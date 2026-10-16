package android.print;

import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;

/**
 * Runs a PrintDocumentAdapter (the WebView's own: vector ink, text and math exactly as printed)
 * straight to a PDF file, without the print dialog, for one page size at a time
 * (com.opennote.app.OpenNotePrintPlugin.pdfPage). The adapter's result callbacks have
 * package-private constructors, which is why this class lives in android.print.
 */
public final class OpenNotePdfWriter {

    public interface Done {
        void ok();

        void fail(String message);
    }

    private OpenNotePdfWriter() {}

    /** Must be called on the main thread; `done` is called on it too. */
    public static void write(PrintDocumentAdapter adapter, PrintAttributes attributes, ParcelFileDescriptor out, Done done) {
        adapter.onStart();
        adapter.onLayout(null, attributes, new CancellationSignal(), new PrintDocumentAdapter.LayoutResultCallback() {
            @Override
            public void onLayoutFinished(PrintDocumentInfo info, boolean changed) {
                adapter.onWrite(new PageRange[] { PageRange.ALL_PAGES }, out, new CancellationSignal(), new PrintDocumentAdapter.WriteResultCallback() {
                    @Override
                    public void onWriteFinished(PageRange[] pages) {
                        adapter.onFinish();
                        done.ok();
                    }

                    @Override
                    public void onWriteFailed(CharSequence error) {
                        adapter.onFinish();
                        done.fail(error != null ? error.toString() : "PDF write failed");
                    }

                    @Override
                    public void onWriteCancelled() {
                        adapter.onFinish();
                        done.fail("PDF write cancelled");
                    }
                });
            }

            @Override
            public void onLayoutFailed(CharSequence error) {
                adapter.onFinish();
                done.fail(error != null ? error.toString() : "PDF layout failed");
            }

            @Override
            public void onLayoutCancelled() {
                adapter.onFinish();
                done.fail("PDF layout cancelled");
            }
        }, new Bundle());
    }
}
