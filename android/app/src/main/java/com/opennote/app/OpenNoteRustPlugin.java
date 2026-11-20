package com.opennote.app;

import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.util.Base64;
import android.view.Choreographer;
import android.view.MotionEvent;
import android.view.View;
import android.view.Surface;
import android.webkit.WebView;

import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The app's Rust library (crates/native, libopennote_native.so in jniLibs, built by
 * scripts/build-rust.sh); crates/native/src/lib.rs has the methods and the framing,
 * src/services/rustCore.ts the page's side.
 *
 * Two routes. The page's `OpenNoteRustPort` (addWebMessageListener, where the WebView can send
 * array buffers): binary both ways, `u32 id, u8 method length, method, framed request` in and
 * `u32 id, framed reply` out, one copy each way. The base64 route through Capacitor (`call`) is
 * the fallback for older WebViews: on a Galaxy Tab A8 it spent ~1.5 s moving a 54,000-point
 * request (JSON parsing, base64, evaluateJavascript), more than Rust's own work.
 *
 * The work runs on a thread of its own at foreground priority (scheduled on the fast cores like
 * the page's), so a long call neither waits on the slow cores nor holds up the other plugins.
 * Without the library `available` says why and the page does the work in TypeScript.
 */
@CapacitorPlugin(name = "OpenNoteRust")
public class OpenNoteRustPlugin extends Plugin {
    static final boolean LOADED;
    private static final String LOAD_ERROR;

    static {
        boolean ok = false;
        String err = null;
        try {
            System.loadLibrary("opennote_native");
            ok = true;
        } catch (Throwable t) {
            err = t.toString();
        }
        LOADED = ok;
        LOAD_ERROR = err;
    }

    private static native byte[] nativeCall(String method, byte[] request);

    // Native live ink (crates/native/src/live.rs), for OpenNoteInkPlugin's overlay (UI thread).
    /** A session for the stroke "r" announced (13 numbers, see live.rs); 0 on a bad call. */
    static native long liveNew(double[] params);
    /** One pen sample (CSS px as the page reads it, force as sent, time in s); false if broken. */
    static native boolean liveAdd(long h, double x, double y, double force, double t);
    /** The line now: [fresh, x, y, radius, ...] (view units); null if broken. */
    static native double[] liveUpdate(long h);
    static native void liveFree(long h);

    // Native GPU Canvas (crates/canvas, crates/native canvas_service.rs). The library owns the
    // canvas: this class holds no handle, only whether it is attached.
    /** The canvas draws into this surface; false when no GPU could (the reason in canvasStats). */
    static native boolean canvasSurfaceCreated(Surface surface, int width, int height);
    static native void canvasSurfaceChanged(int width, int height);
    /** Synchronous: when it returns no draw uses the surface's window, and it is released. */
    static native void canvasSurfaceDestroyed();
    /** Rust panics (with their backtrace) are appended to this file (crates/native opennote_set_crash_file). */
    static native void setCrashFile(String path);
    /** GLES instead of Vulkan for this run; before the surface exists (crates/native canvas_service::prefer_gl). */
    static native void canvasPreferGl(String why);

    /** Draws the canvas's frame when the page changed it; on the render thread only. */
    static native boolean canvasDrawActive();

    // The Rust camera (crates/native viewport_service.rs, rust/DECISIONS.md ADR-006): with the
    // native canvas, two fingers over the note move crates/viewport; the render thread advances
    // it and draws at the display's rate, then pushes the camera to the page, which mirrors it.
    /** A finger: phase 0 down, 1 move, 2 up, 3 cancel; (x, y) WebView CSS px. True when the camera holds it. */
    static native boolean viewportTouch(long id, int phase, double x, double y);
    /** The display's best refresh rate, recorded with each gesture. */
    static native void viewportDisplayHz(double hz);
    /** The camera for the page when it moved since the last push, else null. */
    static native String viewportPoll();
    /** The fingers of one event, n x [id, phase, x, y, t] (WebView CSS px, t s of CLOCK_MONOTONIC). */
    static native int viewportTouches(double[] samples, int n);
    /** Whether the camera moves or holds fingers. */
    static native boolean viewportBusy();
    /** Draws the frame presented at `presentMs` (CLOCK_MONOTONIC ms); render thread only. */
    static native boolean canvasDrawAt(double presentMs);

    /** The WebView the camera is pushed to. */
    private static volatile java.lang.ref.WeakReference<WebView> cameraWebView = new java.lang.ref.WeakReference<>(null);
    private static final Handler uiThread = new Handler(Looper.getMainLooper());

    /**
     * Every finger of a touch event to the Rust camera, before the WebView gets the event (which it
     * still does: taps, one finger, the page cancelling a finger stroke when a second finger lands).
     * Rust takes only fingers that come down over the note while the stylus is off the glass, and
     * moves the camera once two are down. MainActivity.dispatchTouchEvent, UI thread.
     */
    static void onTouch(MotionEvent ev, View webView) {
        if (!LOADED || !canvasAttached || webView == null) return;
        int[] loc = new int[2];
        webView.getLocationInWindow(loc);
        float density = webView.getResources().getDisplayMetrics().density;
        int action = ev.getActionMasked();
        int index = ev.getActionIndex();
        // Every finger of the event at once, each sample with its own time (getEventTime, the
        // clock Choreographer's frames are on) and the historical ones batched into the event:
        // the camera is resampled at each display frame's time (crates/native viewport_service.rs).
        double[] buf = touchBuf;
        int n = 0;
        switch (action) {
            case MotionEvent.ACTION_DOWN:
            case MotionEvent.ACTION_POINTER_DOWN:
                if (ev.getToolType(index) != MotionEvent.TOOL_TYPE_FINGER || OpenNoteInkPlugin.stylusDown()) return;
                n = put(buf, n, ev.getPointerId(index), 0, (ev.getX(index) - loc[0]) / density, (ev.getY(index) - loc[1]) / density, ev.getEventTime());
                break;
            case MotionEvent.ACTION_MOVE:
                for (int h = 0; h < ev.getHistorySize(); h++) {
                    for (int i = 0; i < ev.getPointerCount(); i++) {
                        if (ev.getToolType(i) != MotionEvent.TOOL_TYPE_FINGER) continue;
                        n = put(buf, n, ev.getPointerId(i), 1, (ev.getHistoricalX(i, h) - loc[0]) / density, (ev.getHistoricalY(i, h) - loc[1]) / density, ev.getHistoricalEventTime(h));
                    }
                }
                for (int i = 0; i < ev.getPointerCount(); i++) {
                    if (ev.getToolType(i) != MotionEvent.TOOL_TYPE_FINGER) continue;
                    n = put(buf, n, ev.getPointerId(i), 1, (ev.getX(i) - loc[0]) / density, (ev.getY(i) - loc[1]) / density, ev.getEventTime());
                }
                break;
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_POINTER_UP:
                if (ev.getToolType(index) != MotionEvent.TOOL_TYPE_FINGER) return;
                n = put(buf, n, ev.getPointerId(index), 2, (ev.getX(index) - loc[0]) / density, (ev.getY(index) - loc[1]) / density, ev.getEventTime());
                break;
            case MotionEvent.ACTION_CANCEL:
                for (int i = 0; i < ev.getPointerCount(); i++) {
                    n = put(buf, n, ev.getPointerId(i), 3, (ev.getX(i) - loc[0]) / density, (ev.getY(i) - loc[1]) / density, ev.getEventTime());
                }
                break;
            default:
                break;
        }
        if (n > 0) viewportTouches(buf, n);
    }

    /** Up to 64 samples of one event (UI thread only). */
    private static final double[] touchBuf = new double[5 * 64];

    private static int put(double[] buf, int n, int id, int phase, double x, double y, long timeMs) {
        if (n >= 64) return n;
        buf[5 * n] = id;
        buf[5 * n + 1] = phase;
        buf[5 * n + 2] = x;
        buf[5 * n + 3] = y;
        buf[5 * n + 4] = timeMs / 1000.0;
        return n + 1;
    }

    // The camera to the page, one evaluation at a time (UI thread): a push asked for while the
    // last is still running in the page is sent, with the newest camera, once that one has run.
    private static boolean cameraInFlight = false;
    private static boolean cameraAgain = false;
    private static final java.util.concurrent.atomic.AtomicBoolean cameraPushQueued = new java.util.concurrent.atomic.AtomicBoolean(false);

    private static void pushCamera() {
        if (cameraInFlight) {
            cameraAgain = true;
            return;
        }
        WebView web = cameraWebView.get();
        if (web == null) return;
        String cam = viewportPoll();
        if (cam == null) return;
        cameraInFlight = true;
        web.evaluateJavascript("window.__opennoteCamera&&window.__opennoteCamera(" + cam + ")", r -> {
            cameraInFlight = false;
            if (cameraAgain) {
                cameraAgain = false;
                pushCamera();
            }
        });
    }

    /** The display's best refresh rate (MainActivity, from the display's modes). */
    static void setDisplayHz(float hz) {
        if (LOADED && hz > 0) viewportDisplayHz(hz);
    }
    private static volatile float surfaceHz = 0;
    static void setSurfaceRate(float hz) {
        surfaceHz = hz;
    }

    private static boolean canvasAttached = false;
    private static volatile boolean frameCallbackActive = false;

    /**
     * The canvas is drawn on a thread of its own ("opennote-canvas", display priority, its own
     * Choreographer). Drawing waits for the surface's next buffer; on the UI thread that wait held
     * up the touches and the WebView's frames.
     */
    private static Handler render;

    private static synchronized Handler render() {
        if (render == null) {
            android.os.HandlerThread t = new android.os.HandlerThread("opennote-canvas", Process.THREAD_PRIORITY_DISPLAY);
            t.start();
            render = new Handler(t.getLooper());
        }
        return render;
    }

    private static final Choreographer.FrameCallback frameCallback = new Choreographer.FrameCallback() {
        @Override
        public void doFrame(long frameTimeNanos) {
            if (!frameCallbackActive) return;
            // The frame is presented about a vsync after Choreographer's frame time: the camera is
            // advanced to that moment (System.nanoTime and getEventTime are both CLOCK_MONOTONIC).
            double t = frameTimeNanos / 1e6;
            double d = t - lastFrameMs;
            if (d > 3 && d < 40) periodMs += (d - periodMs) * 0.1;
            lastFrameMs = t;
            canvasDrawAt(t + periodMs);
            if (cameraPushQueued.compareAndSet(false, true)) {
                uiThread.post(() -> {
                    cameraPushQueued.set(false);
                    pushCamera();
                });
            }
            Choreographer.getInstance().postFrameCallback(this);
        }
    };
    private static double lastFrameMs = 0;
    private static double periodMs = 1000.0 / 60.0;

    static final String PREFS = "opennote_native_canvas";

    private static Boolean nativeCanvasThisRun;

    /**
     * The native canvas was chosen in Settings > Diagnostics. Read once per run: it applies from the
     * next start, and everything that depends on it (the SurfaceView, the see-through WebView, the
     * page's flag, the gestures) must agree for the whole run.
     */
    static synchronized boolean nativeCanvasEnabled(android.content.Context ctx) {
        if (nativeCanvasThisRun == null) {
            nativeCanvasThisRun = LOADED && ctx.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE).getBoolean("on", false);
        }
        return nativeCanvasThisRun;
    }

    /** The host is made with the surface's size once it is known (surfaceChanged follows surfaceCreated). */
    private static Surface pendingSurface;

    static void onSurfaceCreated(Surface surface) {
        if (!LOADED) return;
        pendingSurface = surface;
    }

    static void onSurfaceChanged(Surface surface, int width, int height) {
        if (!LOADED) return;
        // The canvas's surface at the display's best rate (Android 11+; the window's display mode,
        // MainActivity.preferFastestMode, does it before): Choreographer then ticks at that rate.
        if (android.os.Build.VERSION.SDK_INT >= 30 && surfaceHz > 0) {
            try {
                surface.setFrameRate(surfaceHz, Surface.FRAME_RATE_COMPATIBILITY_DEFAULT);
            } catch (Throwable ignored) {
                // A surface that refuses keeps the display's rate.
            }
        }
        if (!canvasAttached) {
            canvasAttached = canvasSurfaceCreated(surface, width, height);
            pendingSurface = null;
            if (canvasAttached) startFrameCallback();
            return;
        }
        canvasSurfaceChanged(width, height);
    }

    static void onSurfaceDestroyed() {
        pendingSurface = null;
        if (!LOADED || !canvasAttached) return;
        stopFrameCallback();
        // A frame callback still queued on the render thread finds no canvas and draws nothing.
        canvasSurfaceDestroyed();
        canvasAttached = false;
    }

    static void startFrameCallback() {
        if (frameCallbackActive) return;
        frameCallbackActive = true;
        render().post(() -> {
            Choreographer.getInstance().removeFrameCallback(frameCallback);
            Choreographer.getInstance().postFrameCallback(frameCallback);
        });
    }

    static void stopFrameCallback() {
        frameCallbackActive = false;
        render().post(() -> Choreographer.getInstance().removeFrameCallback(frameCallback));
    }

    private final ExecutorService worker = Executors.newSingleThreadExecutor((r) -> new Thread(() -> {
        Process.setThreadPriority(Process.THREAD_PRIORITY_FOREGROUND);
        r.run();
    }, "opennote-rust"));
    private final Handler main = new Handler(Looper.getMainLooper());
    private boolean port = false;

    @Override
    public void load() {
        // How the last run ended (a native crash ends the process before the page logs it), for the
        // crash report: given to the page once per run (a reload keeps the WebView's session storage).
        String lastEnd = OpenNoteCrashCapture.takeLastEnd(getContext());
        OpenNoteCrashCapture.install(getContext());
        if (LOADED) setCrashFile(OpenNoteCrashCapture.file(getContext()).getAbsolutePath());
        if (!lastEnd.isEmpty() && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            Uri page = Uri.parse(getBridge().getLocalUrl());
            String js = "try { if (!sessionStorage.getItem('opennote_native_crash')) { sessionStorage.setItem('opennote_native_crash', '1'); window.__opennoteNativeCrash = "
                    + org.json.JSONObject.quote(lastEnd) + "; } } catch (e) {}";
            WebViewCompat.addDocumentStartJavaScript(getBridge().getWebView(), js, Collections.singleton(page.getScheme() + "://" + page.getAuthority()));
        }
        if (!LOADED) return;
        // A run with the canvas on that ended abnormally (the system's exit record: a GPU driver's
        // segfault ends the process past anything Rust catches) makes the canvas use GLES from then
        // on, else Vulkan on a fragile driver (Mali) would end every run the same way. Reset when
        // the canvas is switched in Diagnostics.
        if (nativeCanvasEnabled(getContext())) {
            android.content.SharedPreferences prefs = getContext().getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE);
            if (lastEnd.contains("android exit:")) prefs.edit().putBoolean("gl", true).apply();
            if (prefs.getBoolean("gl", false)) canvasPreferGl("the last run with the canvas ended abnormally");
        }
        // The page asks window.__opennoteNativeCanvas (platform.ts hasNativeCanvas) before it draws.
        if (nativeCanvasEnabled(getContext()) && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            Uri page = Uri.parse(getBridge().getLocalUrl());
            cameraWebView = new java.lang.ref.WeakReference<>(getBridge().getWebView());
            WebViewCompat.addDocumentStartJavaScript(getBridge().getWebView(), "window.__opennoteNativeCanvas = true; window.__opennoteNativeViewport = true;",
                    Collections.singleton(page.getScheme() + "://" + page.getAuthority()));
        }
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
                || !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER)) return;
        WebView webView = getBridge().getWebView();
        Uri local = Uri.parse(getBridge().getLocalUrl());
        String origin = local.getScheme() + "://" + local.getAuthority();
        WebViewCompat.addWebMessageListener(webView, "OpenNoteRustPort", Collections.singleton(origin),
                (view, message, sourceOrigin, isMainFrame, reply) -> onPortMessage(message, reply));
        port = true;
    }

    private void onPortMessage(WebMessageCompat message, JavaScriptReplyProxy reply) {
        if (message.getType() != WebMessageCompat.TYPE_ARRAY_BUFFER) return;
        byte[] in = message.getArrayBuffer();
        worker.execute(() -> {
            ByteBuffer b = ByteBuffer.wrap(in).order(ByteOrder.LITTLE_ENDIAN);
            int id = b.getInt();
            int mlen = b.get() & 0xff;
            String method = new String(in, 5, mlen, StandardCharsets.UTF_8);
            byte[] request = new byte[in.length - 5 - mlen];
            System.arraycopy(in, 5 + mlen, request, 0, request.length);
            byte[] r = nativeCall(method, request);
            if (r == null) r = new byte[0];
            byte[] out = new byte[4 + r.length];
            ByteBuffer.wrap(out).order(ByteOrder.LITTLE_ENDIAN).putInt(id);
            System.arraycopy(r, 0, out, 4, r.length);
            main.post(() -> reply.postMessage(out));
        });
    }

    /** Settings > Diagnostics: the native canvas from the next start. */
    @PluginMethod
    public void setNativeCanvas(PluginCall call) {
        getContext().getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE).edit()
                .putBoolean("on", Boolean.TRUE.equals(call.getBoolean("on", false))).putBoolean("gl", false).apply();
        call.resolve();
    }

    @PluginMethod
    public void available(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("available", LOADED);
        ret.put("port", port);
        ret.put("nativeCanvas", nativeCanvasEnabled(getContext()));
        if (LOAD_ERROR != null) ret.put("error", LOAD_ERROR);
        call.resolve(ret);
    }

    @PluginMethod
    public void call(PluginCall call) {
        if (!LOADED) {
            call.reject("Rust library not loaded: " + LOAD_ERROR);
            return;
        }
        String method = call.getString("method", "");
        String data = call.getString("data", "");
        worker.execute(() -> {
            try {
                byte[] reply = nativeCall(method, Base64.decode(data, Base64.NO_WRAP));
                if (reply == null) {
                    call.reject("Rust call failed");
                    return;
                }
                JSObject ret = new JSObject();
                ret.put("data", Base64.encodeToString(reply, Base64.NO_WRAP));
                call.resolve(ret);
            } catch (Throwable t) {
                call.reject(t.toString());
            }
        });
    }
}
