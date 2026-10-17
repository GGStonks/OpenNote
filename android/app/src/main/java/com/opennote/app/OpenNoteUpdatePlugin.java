package com.opennote.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * App updates from GitHub releases (src/services/updater.ts): downloads the release's APK in the
 * background into the cache folder `updates/`, hands it to the system installer, and deletes the
 * folder (cleanup, called at every start, so the package is gone once the updated app runs).
 */
@CapacitorPlugin(name = "OpenNoteUpdate")
public class OpenNoteUpdatePlugin extends Plugin {

    private File updatesDir() {
        return new File(getContext().getCacheDir(), "updates");
    }

    /** Downloads `url` to updates/`fileName`; "progress" events { received, total }; resolves { path }. */
    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url");
        String name = call.getString("fileName", "OpenNote.apk");
        if (url == null || !url.startsWith("https://")) {
            call.reject("Invalid download URL");
            return;
        }
        // Only a plain file name inside the updates folder.
        String safe = new File(name).getName().replaceAll("[^A-Za-z0-9._-]", "_");
        new Thread(() -> {
            File dir = updatesDir();
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
            File part = new File(dir, safe + ".part");
            File done = new File(dir, safe);
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setInstanceFollowRedirects(true);
                conn.setConnectTimeout(20000);
                conn.setReadTimeout(60000);
                conn.setRequestProperty("Accept", "application/octet-stream");
                int status = conn.getResponseCode();
                if (status / 100 != 2) throw new Exception("HTTP " + status);
                long total = conn.getContentLengthLong();
                long received = 0, lastReport = 0;
                try (InputStream in = conn.getInputStream(); OutputStream out = new FileOutputStream(part)) {
                    byte[] buf = new byte[64 * 1024];
                    for (int n; (n = in.read(buf)) > 0; ) {
                        out.write(buf, 0, n);
                        received += n;
                        if (received - lastReport > 256 * 1024) {
                            lastReport = received;
                            JSObject p = new JSObject();
                            p.put("received", received);
                            p.put("total", total);
                            notifyListeners("progress", p);
                        }
                    }
                }
                if (total > 0 && received != total) throw new Exception("Download incomplete");
                //noinspection ResultOfMethodCallIgnored
                done.delete();
                if (!part.renameTo(done)) throw new Exception("Could not save the update");
                JSObject res = new JSObject();
                res.put("path", done.getAbsolutePath());
                call.resolve(res);
            } catch (Exception e) {
                //noinspection ResultOfMethodCallIgnored
                part.delete();
                call.reject("Update download failed: " + e.getMessage());
            } finally {
                if (conn != null) conn.disconnect();
            }
        }).start();
    }

    /**
     * Opens the system installer for a downloaded APK. Where Android needs the user to allow
     * installs from OpenNote first, its settings page opens instead and the call rejects with
     * code "permission" (the app asks the user to allow it and try again).
     */
    @PluginMethod
    public void install(PluginCall call) {
        String path = call.getString("path");
        File file = path != null ? new File(path) : null;
        if (file == null || !file.exists() || !file.getParentFile().equals(updatesDir())) {
            call.reject("Update file missing");
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getContext().getPackageManager().canRequestPackageInstalls()) {
            Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
            settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(settings);
            call.reject("Allow OpenNote to install apps, then tap Install again", "permission");
            return;
        }
        try {
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not open the installer: " + e.getMessage());
        }
    }

    /** Deletes the updates folder (downloaded packages, partial downloads). */
    @PluginMethod
    public void cleanup(PluginCall call) {
        deleteTree(updatesDir());
        call.resolve();
    }

    private static void deleteTree(File f) {
        File[] children = f.listFiles();
        if (children != null) for (File c : children) deleteTree(c);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }
}
