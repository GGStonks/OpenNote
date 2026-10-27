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

import androidx.core.view.WindowCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

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
        enterImmersive();
        keepClearOfSystemBars();
    }

    /**
     * Where the system bars or a display cutout do cover the screen (devices where the bars do not
     * stay hidden, or while they are shown), the app's content is inset by them: drawn under the
     * navigation bar, the bottom of the app (the "+" menu, dialogs) was out of sight. With the bars
     * hidden the insets are zero and the app keeps the whole screen. Touch and stylus positions are
     * taken relative to the WebView's place in the window, so they follow.
     */
    private void keepClearOfSystemBars() {
        View content = findViewById(android.R.id.content);
        ViewCompat.setOnApplyWindowInsetsListener(content, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });
    }

    /**
     * Until the page has painted, the window and the WebView show the app's own theme (saved by
     * OpenNoteLaunchPlugin): the WebView's default white, or the system's light or dark, flashed
     * before an OLED Black or Sepia app.
     */
    private void launchColors() {
        SharedPreferences saved = OpenNoteLaunchPlugin.saved(this);
        if (saved == null) return;
        int color = saved.getInt(OpenNoteLaunchPlugin.BACKGROUND, Color.WHITE);
        getWindow().setBackgroundDrawable(new ColorDrawable(color));
        getBridge().getWebView().setBackgroundColor(color);
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
    }
}
