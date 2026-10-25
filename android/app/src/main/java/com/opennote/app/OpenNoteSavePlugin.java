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

    /** The folder, from the document id where providers use "volume:path/to/file" (local storage). */
    private String folderOf(Uri uri) {
        try {
            String id = DocumentsContract.getDocumentId(uri);
            int colon = id.indexOf(':');
            String path = colon >= 0 ? id.substring(colon + 1) : id;
            int slash = path.lastIndexOf('/');
            // (Ids without a path, such as the Downloads provider's numbers: the folder is not known.)
            if (slash <= 0) return null;
            String dir = path.substring(0, slash);
            return dir.substring(dir.lastIndexOf('/') + 1);
        } catch (Exception e) {
            return null;
        }
    }
}
