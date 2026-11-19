package com.opennote.app;

import android.app.ActivityManager;
import android.app.ApplicationExitInfo;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * How the last run ended, for the crash report (src/services/crashLog.ts `native-crash`), as the
 * iOS shell does since 2.9.4-rs.23. A native crash (Rust, a GPU driver, the WebView) ends the
 * whole process before the page can log anything: its crash report then only said "the app
 * restarted". Three sources, read at the next start:
 * - Android's own record of the exit (ApplicationExitInfo, Android 11+): reason, signal, memory,
 *   and for a native crash its tombstone (Android 12+), decoded to the crashing thread's backtrace;
 * - a Rust panic, with its backtrace (crates/native `opennote_set_crash_file`);
 * - an uncaught Java exception, with its stack.
 */
final class OpenNoteCrashCapture {
    private static final String PREFS = "opennote_crash_capture";
    private static final int MAX = 11000;

    private OpenNoteCrashCapture() {}

    static File file(Context ctx) {
        return new File(ctx.getFilesDir(), "native-crash.txt");
    }

    /** Java exceptions nobody caught go to the crash file, then to the system's handler. */
    static void install(Context ctx) {
        File f = file(ctx);
        Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();
        if (prev instanceof Capture) return;
        Thread.setDefaultUncaughtExceptionHandler(new Capture(f, prev));
    }

    private static final class Capture implements Thread.UncaughtExceptionHandler {
        private final File file;
        private final Thread.UncaughtExceptionHandler prev;

        Capture(File file, Thread.UncaughtExceptionHandler prev) {
            this.file = file;
            this.prev = prev;
        }

        @Override
        public void uncaughtException(Thread t, Throwable e) {
            try (PrintWriter w = new PrintWriter(new FileOutputStream(file, true))) {
                w.println("\njava exception on thread " + t.getName() + ":");
                e.printStackTrace(w);
            } catch (Throwable ignored) {
                // Nothing more to do: the system's handler still runs.
            }
            if (prev != null) prev.uncaughtException(t, e);
        }
    }

    /** What the last run left (empty when it ended normally); each end is given once. */
    static String takeLastEnd(Context ctx) {
        StringBuilder out = new StringBuilder();
        File f = file(ctx);
        if (f.exists()) {
            try (InputStream in = new java.io.FileInputStream(f)) {
                out.append(new String(readAll(in, MAX), StandardCharsets.UTF_8).trim());
            } catch (Throwable ignored) {
                // An unreadable file says nothing.
            }
            //noinspection ResultOfMethodCallIgnored
            f.delete();
        }
        if (Build.VERSION.SDK_INT >= 30) {
            try {
                String exit = lastExit(ctx);
                if (!exit.isEmpty()) out.insert(0, exit + (out.length() > 0 ? "\n\n" : ""));
            } catch (Throwable t) {
                out.append("\n(exit record unreadable: ").append(t).append(')');
            }
        }
        return out.length() > MAX ? out.substring(0, MAX) : out.toString();
    }

    @androidx.annotation.RequiresApi(30)
    private static String lastExit(Context ctx) throws Exception {
        ActivityManager am = (ActivityManager) ctx.getSystemService(Context.ACTIVITY_SERVICE);
        List<ApplicationExitInfo> list = am.getHistoricalProcessExitReasons(ctx.getPackageName(), 0, 1);
        if (list == null || list.isEmpty()) return "";
        ApplicationExitInfo e = list.get(0);
        SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (e.getTimestamp() <= prefs.getLong("seen", 0)) return "";
        prefs.edit().putLong("seen", e.getTimestamp()).apply();
        int r = e.getReason();
        boolean abnormal = r == ApplicationExitInfo.REASON_SIGNALED || r == ApplicationExitInfo.REASON_LOW_MEMORY
                || r == ApplicationExitInfo.REASON_CRASH || r == ApplicationExitInfo.REASON_CRASH_NATIVE
                || r == ApplicationExitInfo.REASON_ANR || r == ApplicationExitInfo.REASON_INITIALIZATION_FAILURE
                || r == ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE || r == ApplicationExitInfo.REASON_DEPENDENCY_DIED;
        if (!abnormal) return "";
        StringBuilder s = new StringBuilder("android exit: ").append(e);
        if (r == ApplicationExitInfo.REASON_CRASH_NATIVE || r == ApplicationExitInfo.REASON_ANR) {
            try (InputStream in = e.getTraceInputStream()) {
                if (in != null) {
                    byte[] trace = readAll(in, 4 << 20);
                    s.append('\n').append(r == ApplicationExitInfo.REASON_ANR ? new String(trace, 0, Math.min(trace.length, MAX), StandardCharsets.UTF_8) : Tombstone.describe(trace));
                }
            }
        }
        return s.toString();
    }

    private static byte[] readAll(InputStream in, int max) throws java.io.IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while (b.size() < max && (n = in.read(buf)) > 0) b.write(buf, 0, Math.min(n, max - b.size()));
        return b.toByteArray();
    }

    /**
     * The tombstone's protobuf (AOSP system/core/debuggerd/proto/tombstone.proto) as logcat shows
     * it: the signal, the abort message, the crashing thread's backtrace, the other threads' names.
     */
    static final class Tombstone {
        private final byte[] b;
        private int at;
        private final int end;

        private Tombstone(byte[] b, int at, int end) {
            this.b = b;
            this.at = at;
            this.end = end;
        }

        private long varint() {
            long v = 0;
            for (int shift = 0; at < end && shift < 64; shift += 7) {
                int x = b[at++] & 0xff;
                v |= (long) (x & 0x7f) << shift;
                if (x < 0x80) break;
            }
            return v;
        }

        /** The next field: its number in [0], wire type in [1], and the value or the payload's span. */
        private long[] next() {
            long key = varint();
            int wire = (int) (key & 7);
            long field = key >>> 3;
            switch (wire) {
                case 0: return new long[] {field, 0, varint()};
                case 1: at += 8; return new long[] {field, 1, 0};
                case 5: at += 4; return new long[] {field, 5, 0};
                case 2: {
                    int len = (int) varint();
                    int from = at;
                    at = Math.min(end, at + len);
                    return new long[] {field, 2, from, at};
                }
                default: at = end; return new long[] {field, wire, 0};
            }
        }

        private String str(long[] f) {
            return new String(b, (int) f[2], (int) (f[3] - f[2]), StandardCharsets.UTF_8);
        }

        private Tombstone sub(long[] f) {
            return new Tombstone(b, (int) f[2], (int) f[3]);
        }

        static String describe(byte[] data) {
            try {
                return new Tombstone(data, 0, data.length).top();
            } catch (Throwable t) {
                return "(tombstone unreadable: " + t + ")";
            }
        }

        private String top() {
            long tid = -1;
            StringBuilder head = new StringBuilder();
            String crashing = "";
            StringBuilder others = new StringBuilder();
            java.util.List<long[]> threads = new java.util.ArrayList<>();
            while (at < end) {
                long[] f = next();
                if (f[0] == 6 && f[1] == 0) tid = f[2];
                else if (f[0] == 10 && f[1] == 2) head.append("signal ").append(sub(f).signal()).append('\n');
                else if (f[0] == 14 && f[1] == 2) head.append("abort: ").append(str(f)).append('\n');
                else if (f[0] == 16 && f[1] == 2) threads.add(f);
            }
            for (long[] entry : threads) {
                Tombstone e = sub(entry);
                long key = -1;
                long[] value = null;
                while (e.at < e.end) {
                    long[] f = e.next();
                    if (f[0] == 1 && f[1] == 0) key = f[2];
                    else if (f[0] == 2 && f[1] == 2) value = f;
                }
                if (value == null) continue;
                if (key == tid) crashing = e.sub(value).thread(64);
                else others.append(e.sub(value).thread(0));
            }
            return head + "crashing thread " + tid + ":\n" + crashing + "other threads:\n" + others;
        }

        private String signal() {
            String name = "", code = "";
            long addr = -1;
            while (at < end) {
                long[] f = next();
                if (f[0] == 2 && f[1] == 2) name = str(f);
                else if (f[0] == 4 && f[1] == 2) code = str(f);
                else if (f[0] == 9 && f[1] == 0) addr = f[2];
            }
            return name + " " + code + (addr >= 0 ? " fault addr 0x" + Long.toHexString(addr) : "");
        }

        /** A thread: its name, and up to `frames` frames of its backtrace. */
        private String thread(int frames) {
            String name = "";
            StringBuilder bt = new StringBuilder();
            int n = 0;
            while (at < end) {
                long[] f = next();
                if (f[0] == 2 && f[1] == 2) name = str(f);
                else if (f[0] == 4 && f[1] == 2 && n < frames) bt.append(String.format(java.util.Locale.US, "  #%02d %s\n", n++, sub(f).frame()));
            }
            return "  " + name + "\n" + bt;
        }

        private String frame() {
            long relPc = 0, offset = 0;
            String fn = "", file = "";
            while (at < end) {
                long[] f = next();
                if (f[0] == 1 && f[1] == 0) relPc = f[2];
                else if (f[0] == 4 && f[1] == 2) fn = str(f);
                else if (f[0] == 5 && f[1] == 0) offset = f[2];
                else if (f[0] == 6 && f[1] == 2) file = str(f);
            }
            return "pc " + Long.toHexString(relPc) + "  " + file + (fn.isEmpty() ? "" : " (" + fn + "+" + offset + ")");
        }
    }
}
