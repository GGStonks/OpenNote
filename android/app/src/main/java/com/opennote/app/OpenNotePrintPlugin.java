package com.opennote.app;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintJob;
import android.print.PrintManager;
import android.webkit.WebView;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Prints the WebView (the web app switches to its print layout first). The Android print dialog
 * offers "Save as PDF", which gives a vector PDF of the note. The call resolves only when the print
 * job has finished, so the web app keeps the print layout alive while the system renders it.
 */
@CapacitorPlugin(name = "OpenNotePrint")
public class OpenNotePrintPlugin extends Plugin {

    @PluginMethod
    public void print(PluginCall call) {
        String name = call.getString("name", "OpenNote");
        getActivity().runOnUiThread(() -> {
            try {
                WebView webView = getBridge().getWebView();
                PrintManager manager = (PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
                PrintDocumentAdapter adapter = webView.createPrintDocumentAdapter(name);
                PrintAttributes attributes = new PrintAttributes.Builder()
                        .setMediaSize(PrintAttributes.MediaSize.NA_LETTER)
                        .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                        .build();
                PrintJob job = manager.print(name, adapter, attributes);
                waitForJob(job, call, new Handler(Looper.getMainLooper()));
            } catch (Exception e) {
                call.reject("Printing failed: " + e.getMessage());
            }
        });
    }

    private void waitForJob(PrintJob job, PluginCall call, Handler handler) {
        handler.postDelayed(() -> {
            if (job == null || job.isCompleted() || job.isCancelled() || job.isFailed()) {
                call.resolve();
            } else {
                waitForJob(job, call, handler);
            }
        }, 500);
    }
}
