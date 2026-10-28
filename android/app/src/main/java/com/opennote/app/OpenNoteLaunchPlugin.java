package com.opennote.app;

import android.app.Activity;
import android.app.UiModeManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.os.Build;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The UI theme for the launch screens, which are drawn before the web app runs. The app sends its
 * theme at start and on every change; it is kept here and used from the next start: by Android's
 * splash screen from Android 13 (setSplashScreenTheme, persisted by the system) and by the window
 * and the WebView until the page has painted (MainActivity), so an OLED Black app no longer
 * started on the light grey screen.
 */
@CapacitorPlugin(name = "OpenNoteLaunch")
public class OpenNoteLaunchPlugin extends Plugin {
    static final String PREFS = "opennote_launch";
    static final String THEME = "theme";
    static final String BACKGROUND = "background";

    @PluginMethod
    public void setTheme(PluginCall call) {
        String id = call.getString("id", "light");
        boolean dark = Boolean.TRUE.equals(call.getBoolean("dark", false));
        int color;
        try {
            color = Color.parseColor(call.getString("background", "#F2F2F7"));
        } catch (IllegalArgumentException e) {
            call.reject("Not a colour");
            return;
        }
        Activity activity = getActivity();
        activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(THEME, id).putInt(BACKGROUND, color).apply();
        activity.runOnUiThread(() -> {
            // The page is up by now (it sends this at start): plain colour, opaque WebView.
            activity.getWindow().setBackgroundDrawable(new ColorDrawable(color));
            getBridge().getWebView().setBackgroundColor(color);
            if (Build.VERSION.SDK_INT >= 33) {
                activity.getSplashScreen().setSplashScreenTheme(launchStyle(id));
            } else if (Build.VERSION.SDK_INT >= 31) {
                // Android 12 has no setSplashScreenTheme: its splash screen follows the app's own
                // night mode (persisted by the system), so a dark theme starts on the dark colour.
                UiModeManager modes = (UiModeManager) activity.getSystemService(Context.UI_MODE_SERVICE);
                if (modes != null) modes.setApplicationNightMode(dark ? UiModeManager.MODE_NIGHT_YES : UiModeManager.MODE_NIGHT_NO);
            }
        });
        call.resolve();
    }

    /** The colour and theme saved by the app, or null before it has sent one. */
    static SharedPreferences saved(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        return prefs.contains(BACKGROUND) ? prefs : null;
    }

    static int launchStyle(String id) {
        switch (id) {
            case "dark": return R.style.Launch_Dark;
            case "sepia": return R.style.Launch_Sepia;
            case "midnight": return R.style.Launch_Midnight;
            case "oled": return R.style.Launch_Oled;
            default: return R.style.Launch_Light;
        }
    }
}
