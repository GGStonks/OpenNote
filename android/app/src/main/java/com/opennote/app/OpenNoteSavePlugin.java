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

import java.io.OutputStream;

/**
 * Exports (src/platform.ts exportFile): the system's "save to" picker (Storage Access Framework),
 * so the user chooses where each file goes, and is told where it went; the share sheet left that
 * unclear. Resolves with the file's name and, when the provider says it, its folder.
 */
@CapacitorPlugin(name = "OpenNoteSave")
public class OpenNoteSavePlugin extends Plugin {

    @PluginMethod
    public void save(PluginCall call) {
        String name = call.getString("filename", "export");
        String mime = call.getString("mimeType", "application/octet-stream");
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mime);
        intent.putExtra(Intent.EXTRA_TITLE, name);
        startActivityForResult(call, intent, "saved");
    }

    @ActivityCallback
    private void saved(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        Uri uri = data != null ? data.getData() : null;
        if (result.getResultCode() != Activity.RESULT_OK || uri == null) {
            JSObject r = new JSObject();
            r.put("cancelled", true);
            call.resolve(r);
            return;
        }
        byte[] bytes;
        try {
            bytes = Base64.decode(call.getString("base64", ""), Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            call.reject("Invalid file data");
            return;
        }
        try (OutputStream out = getContext().getContentResolver().openOutputStream(uri, "wt")) {
            if (out == null) throw new java.io.IOException("cannot open the file");
            out.write(bytes);
        } catch (Exception e) {
            call.reject("Could not save the file: " + e.getMessage());
            return;
        }
        JSObject r = new JSObject();
        r.put("name", displayName(uri, call.getString("filename", "export")));
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
