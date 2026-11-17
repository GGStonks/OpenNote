package com.opennote.app;

import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.util.Base64;
import android.view.Choreographer;
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

    // Native GPU Canvas (crates/canvas & crates/native)
    static native long canvasSurfaceCreated(Surface surface, int width, int height);
    static native void canvasSurfaceChanged(long host, int width, int height);
    static native void canvasSurfaceDestroyed(long host);
    static native boolean canvasDraw(long host);
    static native void canvasBeginGesture(long host);
    static native void canvasEndGesture(long host, double vx, double vy);
    static native void canvasPanZoom(long host, double dx, double dy, double scale, double cx, double cy);
    static native double[] canvasGetCamera(long host);

    public static void beginGesture() {
        if (canvasHost != 0) canvasBeginGesture(canvasHost);
    }

    public static void endGesture(double vx, double vy) {
        if (canvasHost != 0) canvasEndGesture(canvasHost, vx, vy);
    }

    public static void panZoom(double dx, double dy, double scale, double cx, double cy) {
        if (canvasHost != 0) canvasPanZoom(canvasHost, dx, dy, scale, cx, cy);
    }

    public static double[] getCamera() {
        return canvasHost != 0 ? canvasGetCamera(canvasHost) : null;
    }

    private static long canvasHost = 0;
    private static boolean frameCallbackActive = false;

    private static final Choreographer.FrameCallback frameCallback = new Choreographer.FrameCallback() {
        @Override
        public void doFrame(long frameTimeNanos) {
            if (canvasHost != 0) {
                canvasDraw(canvasHost);
                if (frameCallbackActive) {
                    Choreographer.getInstance().postFrameCallback(this);
                }
            }
        }
    };

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
        if (canvasHost == 0) {
            canvasHost = canvasSurfaceCreated(surface, width, height);
            pendingSurface = null;
            if (canvasHost != 0) startFrameCallback();
            return;
        }
        canvasSurfaceChanged(canvasHost, width, height);
    }

    static void onSurfaceDestroyed() {
        pendingSurface = null;
        if (!LOADED || canvasHost == 0) return;
        stopFrameCallback();
        canvasSurfaceDestroyed(canvasHost);
        canvasHost = 0;
    }

    static void startFrameCallback() {
        if (frameCallbackActive) return;
        frameCallbackActive = true;
        new Handler(Looper.getMainLooper()).post(() -> {
            Choreographer.getInstance().postFrameCallback(frameCallback);
        });
    }

    static void stopFrameCallback() {
        frameCallbackActive = false;
        new Handler(Looper.getMainLooper()).post(() -> {
            Choreographer.getInstance().removeFrameCallback(frameCallback);
        });
    }

    private final ExecutorService worker = Executors.newSingleThreadExecutor((r) -> new Thread(() -> {
        Process.setThreadPriority(Process.THREAD_PRIORITY_FOREGROUND);
        r.run();
    }, "opennote-rust"));
    private final Handler main = new Handler(Looper.getMainLooper());
    private boolean port = false;

    @Override
    public void load() {
        if (!LOADED) return;
        // The page asks window.__opennoteNativeCanvas (platform.ts hasNativeCanvas) before it draws.
        if (nativeCanvasEnabled(getContext()) && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            Uri page = Uri.parse(getBridge().getLocalUrl());
            WebViewCompat.addDocumentStartJavaScript(getBridge().getWebView(), "window.__opennoteNativeCanvas = true;",
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
                .putBoolean("on", Boolean.TRUE.equals(call.getBoolean("on", false))).apply();
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
