package com.opennote.app;

import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.os.Build;
import android.os.Bundle;
import android.view.MotionEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;

import androidx.core.view.WindowCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(OpenNotePrintPlugin.class);
        registerPlugin(OpenNoteInkPlugin.class);
        registerPlugin(OpenNoteUpdatePlugin.class);
        registerPlugin(OpenNoteSavePlugin.class);
        registerPlugin(OpenNoteLaunchPlugin.class);
        super.onCreate(savedInstanceState);
        launchColors();
        // Capacitor's SystemBars paints the window with the static theme's colour just after start
        // (and on configuration changes): the app's own again after it.
        getWindow().getDecorView().post(this::launchColors);
        enterImmersive();
        keepClearOfSystemBars();
        handleBack();
    }

    /** The safe area for the page, as CSS (`--sa-*`, index.css), or null before the first insets. */
    private String insetsCss;

    /**
     * The app takes the whole screen, under a display cutout too, and the page keeps its controls
     * clear of the cutout and of system bars that stay shown (devices where they do not hide) from
     * the insets, in CSS px: its `--sa-*` variables (Android's WebView does not give
     * `env(safe-area-inset-*)`). The content used to be padded by them instead, which left bands of
     * the window's colour on the cutout's side (top and bottom held upright, the sides sideways).
     * With the bars hidden their insets are zero.
     */
    private void keepClearOfSystemBars() {
        View content = findViewById(android.R.id.content);
        ViewCompat.setOnApplyWindowInsetsListener(content, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            float d = getResources().getDisplayMetrics().density;
            insetsCss = String.format(java.util.Locale.ROOT,
                "(function(s){s.setProperty('--sa-top','%.1fpx');s.setProperty('--sa-right','%.1fpx');s.setProperty('--sa-bottom','%.1fpx');s.setProperty('--sa-left','%.1fpx')})(document.documentElement.style)",
                bars.top / d, bars.right / d, bars.bottom / d, bars.left / d);
            v.setPadding(0, 0, 0, 0);
            sendInsets();
            return WindowInsetsCompat.CONSUMED;
        });
        // Again once a page is there (the first insets come before it).
        getBridge().addWebViewListener(new WebViewListener() {
            @Override
            public void onPageCommitVisible(WebView view, String url) {
                sendInsets();
                if (!pagePainted) {
                    pagePainted = true;
                    launchColors();
                }
            }

            @Override
            public void onPageLoaded(WebView webView) {
                sendInsets();
            }
        });
    }

    private void sendInsets() {
        if (insetsCss != null && getBridge() != null) getBridge().getWebView().evaluateJavascript(insetsCss, null);
    }

    /**
     * The device's back (button or gesture) goes back in the app, as its own back buttons: the page
     * closes what was opened last (src/services/backStack.ts). Only with nothing open does the app
     * go to the background, as Android does with an app's first screen; it used to close the app
     * from anywhere, the note being edited included.
     */
    private void handleBack() {
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView web = getBridge() != null ? getBridge().getWebView() : null;
                if (web == null) {
                    moveTaskToBack(true);
                    return;
                }
                web.evaluateJavascript("(window.OpenNoteBack ? window.OpenNoteBack() : false)", (handled) -> {
                    if (!"true".equals(handled)) moveTaskToBack(true);
                });
            }
        });
    }

    /** The page has drawn its first frame (until then the window shows the launch screen). */
    private boolean pagePainted;

    /**
     * Until the page has painted, the window shows the launch screen of the app's own theme (its
     * colour and the logo, saved by OpenNoteLaunchPlugin; the system's light or dark before the app
     * has sent one) through a see-through WebView; after it, plain colour behind an opaque WebView.
     * Before Android 12 this window is the launch screen itself (no system preview, styles.xml): a
     * preview can only have one fixed colour, and an OLED Black app started on light grey.
     */
    private void launchColors() {
        SharedPreferences saved = OpenNoteLaunchPlugin.saved(this);
        String theme = saved != null ? saved.getString(OpenNoteLaunchPlugin.THEME, "light") : null;
        int color = saved != null ? saved.getInt(OpenNoteLaunchPlugin.BACKGROUND, Color.WHITE) : getColor(R.color.launch_background);
        WebView web = getBridge() != null ? getBridge().getWebView() : null;
        if (pagePainted) {
            getWindow().setBackgroundDrawable(new ColorDrawable(color));
            if (web != null) web.setBackgroundColor(color);
        } else {
            getWindow().setBackgroundDrawableResource(theme != null ? OpenNoteLaunchPlugin.launchScreen(theme) : R.drawable.launch_screen);
            if (web != null) web.setBackgroundColor(Color.TRANSPARENT);
        }
    }

    @Override
    public void onConfigurationChanged(android.content.res.Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        launchColors();
    }

    /** Native live ink: the stylus's newest position reaches the ink overlay before the WebView. */
    @Override
    public boolean dispatchTouchEvent(MotionEvent ev) {
        OpenNoteInkPlugin.onTouch(ev);
        return super.dispatchTouchEvent(ev);
    }

    @Override
    public void onResume() {
        super.onResume();
        enterImmersive();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // Dialogs, the share sheet or the keyboard can bring the bars back: hide them again.
        if (hasFocus) enterImmersive();
    }

    /**
     * Immersive fullscreen: no status bar, no navigation bar, content drawn edge to edge (also
     * under a display cutout). A swipe from an edge shows the bars for a moment; they hide again
     * by themselves.
     */
    private void enterImmersive() {
        Window window = getWindow();
        WindowCompat.setDecorFitsSystemWindows(window, false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams lp = window.getAttributes();
            lp.layoutInDisplayCutoutMode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
                : WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            window.setAttributes(lp);
        }
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
        controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        controller.hide(WindowInsetsCompat.Type.systemBars());
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            // Before Android 11 the compat call above also sets LAYOUT_STABLE, with which the insets
            // keep the hidden status and navigation bars: the page kept their room free (bands at
            // the top and bottom, or the sides held sideways, on an Android 10 phone).
            View decor = window.getDecorView();
            decor.setSystemUiVisibility(decor.getSystemUiVisibility() & ~View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        }
    }
}
