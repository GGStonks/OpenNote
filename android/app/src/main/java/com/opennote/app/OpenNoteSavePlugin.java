package com.opennote.app;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.util.Base64;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Exports (src/platform.ts exportFile): the system's "save to" picker (Storage Access Framework),
 * so the user chooses where each file goes, and is told where it went; the share sheet left that
 * unclear. Resolves with the file's name and, when the provider says it, its folder.
 *
 * The file is staged first (stage: base64 chunks written to the app's cache) and save() carries
 * only its id. Opening the picker sends the app to the background, and Capacitor then puts the
 * pending call's data in the activity's saved state (twice): with the file in it (a PDF as base64,
 * megabytes with pages a highlighter makes heavy) that is over Android's ~1 MB limit, the app died
 * with TransactionTooLargeException, and the file chosen in the picker stayed empty (0 B). The
 * staged file's id is also kept on disk, so the file is written even when the call itself did not
 * survive.
 */
@CapacitorPlugin(name = "OpenNoteSave")
public class OpenNoteSavePlugin extends Plugin {

    private static final String PREFS = "opennote_save";

    private File stagedFile(String id) {
        File dir = new File(getContext().getCacheDir(), "export-staged");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        return new File(dir, id.replaceAll("[^A-Za-z0-9]", ""));
    }

    /** Appends a base64 chunk to the staged file `id` (`first`: starts it). Resolves at once (no activity). */
    @PluginMethod
    public void stage(PluginCall call) {
        String id = call.getString("id", "");
        if (id.isEmpty()) {
            call.reject("No file id");
            return;
        }
        boolean first = Boolean.TRUE.equals(call.getBoolean("first", false));
        if (first) dropOldStaged();
        try (FileOutputStream out = new FileOutputStream(stagedFile(id), !first)) {
            out.write(Base64.decode(call.getString("chunk", ""), Base64.DEFAULT));
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not prepare the file: " + e.getMessage());
        }
    }

    /** Staged files left by an export that never finished (a day old). */
    private void dropOldStaged() {
        File[] files = new File(getContext().getCacheDir(), "export-staged").listFiles();
        if (files == null) return;
        long old = System.currentTimeMillis() - 24 * 3600 * 1000L;
        //noinspection ResultOfMethodCallIgnored
        for (File f : files) if (f.lastModified() < old) f.delete();
    }

    @PluginMethod
    public void save(PluginCall call) {
        String name = call.getString("filename", "export");
        String mime = call.getString("mimeType", "application/octet-stream");
        String staged = call.getString("staged", "");
        getContext().getSharedPreferences(PREFS, 0).edit().putString("staged", staged).putString("filename", name).apply();
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mime);
        intent.putExtra(Intent.EXTRA_TITLE, name);
        startActivityForResult(call, intent, "saved");
    }

    @ActivityCallback
    private void saved(PluginCall call, ActivityResult result) {
        android.content.SharedPreferences prefs = getContext().getSharedPreferences(PREFS, 0);
        String staged = call != null ? call.getString("staged", "") : prefs.getString("staged", "");
        String name = call != null ? call.getString("filename", "export") : prefs.getString("filename", "export");
        prefs.edit().clear().apply();
        File file = staged == null || staged.isEmpty() ? null : stagedFile(staged);
        Intent data = result.getData();
        Uri uri = data != null ? data.getData() : null;
        if (result.getResultCode() != Activity.RESULT_OK || uri == null) {
            //noinspection ResultOfMethodCallIgnored
            if (file != null) file.delete();
            if (call != null) {
                JSObject r = new JSObject();
                r.put("cancelled", true);
                call.resolve(r);
            }
            return;
        }
        try (OutputStream out = getContext().getContentResolver().openOutputStream(uri, "wt")) {
            if (out == null) throw new java.io.IOException("cannot open the file");
            if (file != null) {
                try (InputStream in = new FileInputStream(file)) {
                    byte[] buf = new byte[64 * 1024];
                    for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
                }
            } else if (call != null) {
                // Small files from older callers: the data in the call itself.
                out.write(Base64.decode(call.getString("base64", ""), Base64.DEFAULT));
            }
        } catch (Exception e) {
            if (call != null) call.reject("Could not save the file: " + e.getMessage());
            return;
        } finally {
            //noinspection ResultOfMethodCallIgnored
            if (file != null) file.delete();
        }
        if (call == null) return;
        JSObject r = new JSObject();
        r.put("name", displayName(uri, name));
        String folder = folderOf(uri);
        if (folder != null) r.put("folder", folder);
        call.resolve(r);
    }

    private String displayName(Uri uri, String fallback) {
        try (Cursor c = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                String n = c.getString(0);
                if (n != null && !n.isEmpty()) return n;
            }
        } catch (Exception ignored) {
            /* the provider does not say */
        }
        return fallback;
    }

    /**
     * Where the file went, as the user would call it: the folder for local storage ("volume:path"
     * ids, and the Downloads provider's "raw:/path" ones), "Downloads" for the Downloads provider's
     * other ids (numbers), otherwise the provider's own name (Drive, a cloud app...).
     */
    private String folderOf(Uri uri) {
        String authority = uri.getAuthority();
        try {
            String id = DocumentsContract.getDocumentId(uri);
            String path = null;
            if (id.startsWith("raw:")) path = id.substring(4);
            else if ("com.android.externalstorage.documents".equals(authority)) {
                int colon = id.indexOf(':');
                path = colon >= 0 ? id.substring(colon + 1) : id;
                if (path.indexOf('/') < 0) return "Internal storage";
            }
            if (path != null) {
                int slash = path.lastIndexOf('/');
                if (slash > 0) {
                    String dir = path.substring(0, slash);
                    return dir.substring(dir.lastIndexOf('/') + 1);
                }
            }
        } catch (Exception ignored) {
            /* not a document id: below */
        }
        if ("com.android.providers.downloads.documents".equals(authority)) return "Downloads";
        try {
            android.content.pm.PackageManager pm = getContext().getPackageManager();
            android.content.pm.ProviderInfo info = authority != null ? pm.resolveContentProvider(authority, 0) : null;
            if (info != null) {
                CharSequence label = info.loadLabel(pm);
                if (label == null || label.length() == 0) label = info.applicationInfo.loadLabel(pm);
                if (label != null && label.length() > 0) return label.toString();
            }
        } catch (Exception ignored) {
            /* unknown provider */
        }
        return null;
    }
}
