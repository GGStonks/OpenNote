package com.opennote.app;

import android.os.Build;
import android.os.Bundle;
import android.view.MotionEvent;
import android.view.Window;
import android.view.WindowManager;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(OpenNotePrintPlugin.class);
        registerPlugin(OpenNoteInkPlugin.class);
        registerPlugin(OpenNoteUpdatePlugin.class);
        super.onCreate(savedInstanceState);
        enterImmersive();
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
