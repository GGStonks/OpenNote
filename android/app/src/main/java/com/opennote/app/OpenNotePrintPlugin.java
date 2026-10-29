package com.opennote.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.print.OpenNotePdfWriter;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintJob;
import android.print.PrintManager;
import android.webkit.WebView;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;

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

    /**
     * One page of the note as a PDF of exactly its size (the web app shows only that page in its
     * print layout first). The WebView's own PDF renderer is run without the print dialog, at a
     * media size of the page's width x height, so every page of the exported PDF keeps its own size
     * and orientation; the dialog forces one paper size on all of them. Resolves { base64 }.
     */
    /**
     * `transparent`: the page must print see-through where it has no content (the PDF export lays an
     * imported PDF's original page under it). The WebView prints the colour it is given
     * (setBackgroundColor: the app theme's, OpenNoteLaunchPlugin) behind a page without a background
     * of its own, which covered the original page: the export showed only the ink. It is made
     * transparent for the print and given the theme's colour back afterwards.
     */
    @PluginMethod
    public void pdfPage(PluginCall call) {
        Double widthPx = call.getDouble("widthPx"), heightPx = call.getDouble("heightPx");
        String name = call.getString("name", "OpenNote");
        boolean transparent = Boolean.TRUE.equals(call.getBoolean("transparent", false));
        if (widthPx == null || heightPx == null || widthPx <= 0 || heightPx <= 0) {
            call.reject("Page size missing");
            return;
        }
        getActivity().runOnUiThread(() -> {
            WebView webView = getBridge().getWebView();
            Runnable restore = () -> {
                if (!transparent) return;
                SharedPreferences saved = OpenNoteLaunchPlugin.saved(getContext());
                webView.setBackgroundColor(saved != null ? saved.getInt(OpenNoteLaunchPlugin.BACKGROUND, Color.WHITE) : Color.WHITE);
            };
            if (transparent) webView.setBackgroundColor(Color.TRANSPARENT);
            try {
                PrintDocumentAdapter adapter = webView.createPrintDocumentAdapter(name);
                // Media sizes are in thousandths of an inch; the page is in CSS px (96 per inch).
                int wMils = (int) Math.round(widthPx / 96.0 * 1000), hMils = (int) Math.round(heightPx / 96.0 * 1000);
                PrintAttributes.MediaSize media = new PrintAttributes.MediaSize("opennote_" + wMils + "x" + hMils, "OpenNote page", wMils, hMils);
                PrintAttributes attributes = new PrintAttributes.Builder()
                        .setMediaSize(media)
                        .setResolution(new PrintAttributes.Resolution("opennote", "PDF", 600, 600))
                        .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                        .setColorMode(PrintAttributes.COLOR_MODE_COLOR)
                        .build();
                File file = File.createTempFile("opennote-page", ".pdf", getContext().getCacheDir());
                ParcelFileDescriptor out = ParcelFileDescriptor.open(file,
                        ParcelFileDescriptor.MODE_READ_WRITE | ParcelFileDescriptor.MODE_CREATE | ParcelFileDescriptor.MODE_TRUNCATE);
                OpenNotePdfWriter.write(adapter, attributes, out, new OpenNotePdfWriter.Done() {
                    @Override
                    public void ok() {
                        restore.run();
                        try {
                            out.close();
                            byte[] bytes = readAll(file);
                            JSObject res = new JSObject();
                            res.put("base64", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP));
                            call.resolve(res);
                        } catch (Exception e) {
                            call.reject("PDF read failed: " + e.getMessage());
                        } finally {
                            //noinspection ResultOfMethodCallIgnored
                            file.delete();
                        }
                    }

                    @Override
                    public void fail(String message) {
                        restore.run();
                        try {
                            out.close();
                        } catch (Exception ignored) {
                            // already closed
                        }
                        //noinspection ResultOfMethodCallIgnored
                        file.delete();
                        call.reject(message);
                    }
                });
            } catch (Throwable t) {
                restore.run();
                // E.g. a system that refuses the android.print helper: the web app falls back to the print dialog.
                call.reject("PDF export unavailable: " + t);
            }
        });
    }

    /**
     * Prints a PDF the web app made (Print…: the same vector PDF as the export, the original PDF
     * pages under the ink) with the system print dialog. Resolves when the job is done.
     */
    @PluginMethod
    public void printPdf(PluginCall call) {
        String name = call.getString("name", "OpenNote");
        String base64 = call.getString("base64", "");
        final byte[] pdf;
        try {
            pdf = android.util.Base64.decode(base64, android.util.Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            call.reject("Nothing to print");
            return;
        }
        if (pdf.length == 0) {
            call.reject("Nothing to print");
            return;
        }
        getActivity().runOnUiThread(() -> {
            try {
                PrintManager manager = (PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
                PrintDocumentAdapter adapter = new PrintDocumentAdapter() {
                    @Override
                    public void onLayout(PrintAttributes oldAttributes, PrintAttributes newAttributes, android.os.CancellationSignal cancel,
                                         LayoutResultCallback callback, android.os.Bundle extras) {
                        if (cancel.isCanceled()) {
                            callback.onLayoutCancelled();
                            return;
                        }
                        callback.onLayoutFinished(new android.print.PrintDocumentInfo.Builder(name + ".pdf")
                                .setContentType(android.print.PrintDocumentInfo.CONTENT_TYPE_DOCUMENT)
                                .build(), true);
                    }

                    @Override
                    public void onWrite(android.print.PageRange[] pages, ParcelFileDescriptor destination, android.os.CancellationSignal cancel,
                                        WriteResultCallback callback) {
                        try (java.io.FileOutputStream out = new java.io.FileOutputStream(destination.getFileDescriptor())) {
                            out.write(pdf);
                            callback.onWriteFinished(new android.print.PageRange[] { android.print.PageRange.ALL_PAGES });
                        } catch (IOException e) {
                            callback.onWriteFailed(e.getMessage());
                        }
                    }
                };
                PrintJob job = manager.print(name, adapter, null);
                waitForJob(job, call, new Handler(Looper.getMainLooper()));
            } catch (Exception e) {
                call.reject("Printing failed: " + e.getMessage());
            }
        });
    }

    private static byte[] readAll(File file) throws IOException {
        try (FileInputStream in = new FileInputStream(file); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[64 * 1024];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            return out.toByteArray();
        }
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
