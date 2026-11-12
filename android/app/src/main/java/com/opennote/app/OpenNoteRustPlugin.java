package com.opennote.app;

import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The app's Rust code (crates/native, libopennote_native.so in jniLibs, built by
 * scripts/build-rust.sh). `call` runs a method on a framed request (base64 in `data`) and
 * resolves with the framed reply (base64 in `data`): crates/native/src/lib.rs has the methods and
 * the framing, src/services/rustCore.ts the page's side. The work runs on a thread of its own, so a
 * long call never holds up the other plugins (the live ink's messages go through the same plugin
 * thread). Without the library (a build without Rust) `available` says so and the page does the
 * work in TypeScript.
 */
@CapacitorPlugin(name = "OpenNoteRust")
public class OpenNoteRustPlugin extends Plugin {
    private static final boolean LOADED;
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

    private final ExecutorService worker = Executors.newSingleThreadExecutor();

    @PluginMethod
    public void available(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("available", LOADED);
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
