package com.opennote.app;

import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;

/**
 * App updates from GitHub releases (src/services/updater.ts): downloads the release's APK in the
 * background with Android's download service (DownloadManager: it follows GitHub's redirects, rides
 * out flaky networks and shows its progress in the notification shade; the app polls it for the
 * progress bar) into the app's own folder `updates/`, hands it to the system installer, and deletes
 * the folder (cleanup, called at every start, so the package is gone once the updated app runs).
 */
@CapacitorPlugin(name = "OpenNoteUpdate")
public class OpenNoteUpdatePlugin extends Plugin {

    /** The app's own external files folder (no storage permission needed); the cache if there is none. */
    private File updatesDir() {
        File ext = getContext().getExternalFilesDir("updates");
        return ext != null ? ext : new File(getContext().getCacheDir(), "updates");
    }

    /** No progress for this long: the download is given up as stalled (ms). */
    private static final long STALL_MS = 45000;

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
        File dir = updatesDir();
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        File file = new File(dir, safe);
        //noinspection ResultOfMethodCallIgnored
        file.delete();
        DownloadManager dm = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
        if (dm == null) {
            call.reject("Android's download service is not available");
            return;
        }
        long id;
        try {
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url))
                    .setTitle("OpenNote update")
                    .setDescription(safe)
                    .setMimeType("application/vnd.android.package-archive")
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
                    .setDestinationUri(Uri.fromFile(file));
            id = dm.enqueue(req);
        } catch (Exception e) {
            call.reject("Update download failed: " + e.getMessage());
            return;
        }
        Handler handler = new Handler(Looper.getMainLooper());
        final long[] last = { -1, System.currentTimeMillis() };
        Runnable poll = new Runnable() {
            @Override
            public void run() {
                int status;
                long received, total;
                String reason = null;
                try (Cursor c = dm.query(new DownloadManager.Query().setFilterById(id))) {
                    if (c == null || !c.moveToFirst()) {
                        call.reject("Update download was cancelled");
                        return;
                    }
                    status = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                    received = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
                    total = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
                    if (status == DownloadManager.STATUS_FAILED) reason = "error " + c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
                }
                if (status == DownloadManager.STATUS_SUCCESSFUL) {
                    JSObject res = new JSObject();
                    res.put("path", file.getAbsolutePath());
                    call.resolve(res);
                    return;
                }
                if (reason != null) {
                    dm.remove(id);
                    call.reject("Update download failed (" + reason + ")");
                    return;
                }
                long now = System.currentTimeMillis();
                if (received != last[0]) {
                    last[0] = received;
                    last[1] = now;
                    JSObject p = new JSObject();
                    p.put("received", received);
                    p.put("total", total);
                    notifyListeners("progress", p);
                } else if (now - last[1] > STALL_MS) {
                    dm.remove(id);
                    call.reject("The download stalled (no data for 45 s). Check the connection and try again.");
                    return;
                }
                handler.postDelayed(this, 400);
            }
        };
        handler.post(poll);
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
        if (file == null || !file.exists() || !file.getAbsoluteFile().getParentFile().equals(updatesDir().getAbsoluteFile())) {
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
        // Where v2.1.5 downloaded to.
        deleteTree(new File(getContext().getCacheDir(), "updates"));
        call.resolve();
    }

    private static void deleteTree(File f) {
        File[] children = f.listFiles();
        if (children != null) for (File c : children) deleteTree(c);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }
}
