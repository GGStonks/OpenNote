package com.opennote.app;

import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Rect;
import android.graphics.drawable.ColorDrawable;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.ImageView;

import androidx.activity.OnBackPressedCallback;

import androidx.core.view.WindowCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.DisplayCutoutCompat;
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
     * The app takes the whole screen, under a display cutout too. The page is told, in CSS px,
     * where system bars that stay shown are (its `--sa-*` variables; Android's WebView gives no
     * `env(safe-area-inset-*)`) and the cutout's own outline (`window.OpenNoteCutout`, rectangles):
     * only a control the cutout would cover moves aside (src/services/cutout.ts). The cutout's
     * inset is a whole band (a waterdrop notch reports the status bar's height across the full
     * width), and keeping it free left empty bands above the top bars, or beside them sideways.
     */
    private void keepClearOfSystemBars() {
        View content = findViewById(android.R.id.content);
        ViewCompat.setOnApplyWindowInsetsListener(content, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
            float d = getResources().getDisplayMetrics().density;
            StringBuilder cut = new StringBuilder("[");
            DisplayCutoutCompat cutout = insets.getDisplayCutout();
            if (cutout != null) {
                for (Rect r : cutout.getBoundingRects()) {
                    if (cut.length() > 1) cut.append(',');
                    cut.append(String.format(java.util.Locale.ROOT, "[%.1f,%.1f,%.1f,%.1f]", r.left / d, r.top / d, r.right / d, r.bottom / d));
                }
            }
            cut.append(']');
            insetsCss = String.format(java.util.Locale.ROOT,
                "(function(s){s.setProperty('--sa-top','%.1fpx');s.setProperty('--sa-right','%.1fpx');s.setProperty('--sa-bottom','%.1fpx');s.setProperty('--sa-left','%.1fpx')})(document.documentElement.style);"
                    + "window.OpenNoteCutout=%s;window.dispatchEvent(new Event('opennote-cutout'))",
                bars.top / d, bars.right / d, bars.bottom / d, bars.left / d, cut);
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
                    becomeOpaque();
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

    /** The page has drawn its first frame (until then the launch logo is shown over it). */
    private boolean pagePainted;
    private ImageView launchLogo;

    /**
     * Until the page has painted, the screen is the launch screen of the app's own theme: its colour
     * (saved by OpenNoteLaunchPlugin; the system's light or dark before the app has sent one) behind
     * a see-through WebView, and the logo in the middle of the screen, where index.html draws it, so
     * the page takes over without a jump (as the window's background it moved with the system bars).
     * Before Android 12 this is the launch screen itself (no system preview, styles.xml): a preview
     * can only have one fixed colour, and an OLED Black app started on light grey.
     */
    private void launchColors() {
        SharedPreferences saved = OpenNoteLaunchPlugin.saved(this);
        int color = saved != null ? saved.getInt(OpenNoteLaunchPlugin.BACKGROUND, Color.WHITE) : getColor(R.color.launch_background);
        getWindow().setBackgroundDrawable(new ColorDrawable(color));
        WebView web = getBridge() != null ? getBridge().getWebView() : null;
        if (web != null) web.setBackgroundColor(pagePainted ? color : Color.TRANSPARENT);
        if (!pagePainted && launchLogo == null) {
            launchLogo = new ImageView(this);
            launchLogo.setImageResource(R.drawable.launch_icon);
            int size = Math.round(288 * getResources().getDisplayMetrics().density);
            ((FrameLayout) findViewById(android.R.id.content)).addView(launchLogo, new FrameLayout.LayoutParams(size, size, Gravity.CENTER));
        } else if (pagePainted && launchLogo != null) {
            ((ViewGroup) launchLogo.getParent()).removeView(launchLogo);
            launchLogo = null;
        }
    }

    /**
     * Before Android 12 the activity starts see-through (styles.xml, so that nothing is drawn
     * before its own themed window); once the page is up it is made opaque again, so the screen
     * behind it is no longer kept drawn. Android 10 has only the hidden call for it.
     */
    private void becomeOpaque() {
        if (Build.VERSION.SDK_INT >= 31) return;
        if (Build.VERSION.SDK_INT >= 30) {
            setTranslucent(false);
            return;
        }
        try {
            java.lang.reflect.Method m = android.app.Activity.class.getDeclaredMethod("convertFromTranslucent");
            m.setAccessible(true);
            m.invoke(this);
        } catch (Throwable ignored) {
            // Stays see-through: still drawn opaque (the window itself is), only the screen behind is kept.
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
