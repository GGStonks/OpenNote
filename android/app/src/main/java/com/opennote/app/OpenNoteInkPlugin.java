package com.opennote.app;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;

/**
 * Native live ink (src/ink/nativeInk.ts): the stroke being written is drawn by a native view above
 * the WebView, as soon as the page has modelled each pen sample, instead of waiting for the
 * WebView's own rendering pipeline (the page's next frame, its paint, the compositor's frame), and
 * continued to the stylus's newest raw position straight from the touch event (MainActivity). The
 * page keeps drawing the stroke as well and says when its own copy is on screen; only then is the
 * native ink cleared.
 *
 * The page talks to it through window.OpenNoteInk.post(message), registered here before the page
 * loads (plugins load before the bridge loads the WebView).
 */
@CapacitorPlugin(name = "OpenNoteInk")
public class OpenNoteInkPlugin extends Plugin {

    /** The overlay of the running activity (MainActivity feeds it the stylus's raw positions). */
    static InkOverlay overlay;

    @Override
    public void load() {
        WebView webView = getBridge().getWebView();
        InkOverlay view = new InkOverlay(getContext(), webView);
        overlay = view;
        webView.addJavascriptInterface(new Object() {
            @JavascriptInterface
            public void post(String msg) {
                view.post(() -> view.handle(msg));
            }
        }, "OpenNoteInk");
        webView.post(() -> {
            ViewGroup parent = (ViewGroup) webView.getParent();
            if (parent != null && view.getParent() == null) {
                parent.addView(view, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            }
        });
    }

    /**
     * The overlay. Coordinates are WebView px (what the page sends: CSS px x devicePixelRatio).
     * Geometry as the ink engine's (src/ink/engine/geometry.ts, addCapsule): fountain pen = union of
     * capsules between consecutive points, all wound the same way (nonzero fill); ballpoint = a
     * round-capped line.
     */
    static class InkOverlay extends View {
        /** Settled ink is split into paths of this many points: a full one is never rebuilt. */
        private static final int CHUNK = 64;

        private final WebView webView;
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final ArrayList<Path> chunks = new ArrayList<>();
        private final ArrayList<Float> chunkWidths = new ArrayList<>();
        private float[] settled = new float[3 * 256];
        private int settledCount;
        private int chunkStart;
        private float[] tail = new float[0];
        private Path tailPath = new Path();
        private float tailWidth;
        private boolean variable;
        private final RectF clip = new RectF();
        private boolean active;
        private boolean hasRaw;
        private float rawX, rawY;
        private int generation;
        private final int[] wvLoc = new int[2];
        private final int[] myLoc = new int[2];
        private final RectF oval = new RectF();

        InkOverlay(Context context, WebView webView) {
            super(context);
            this.webView = webView;
            setClickable(false);
            setFocusable(false);
            setWillNotDraw(false);
        }

        @Override
        public boolean onTouchEvent(MotionEvent event) {
            return false;
        }

        boolean isActive() {
            return active;
        }

        private void addCapsule(Path path, float ax, float ay, float ra, float bx, float by, float rb) {
            double dx = bx - ax, dy = by - ay, d = Math.hypot(dx, dy);
            if (d <= Math.abs(ra - rb) + 1e-6) {
                boolean useA = ra >= rb;
                path.addCircle(useA ? ax : bx, useA ? ay : by, Math.max(ra, rb), Path.Direction.CCW);
                return;
            }
            double th = Math.atan2(dy, dx), ph = Math.acos((ra - rb) / d);
            path.moveTo((float) (ax + ra * Math.cos(th + ph)), (float) (ay + ra * Math.sin(th + ph)));
            path.lineTo((float) (bx + rb * Math.cos(th + ph)), (float) (by + rb * Math.sin(th + ph)));
            oval.set(bx - rb, by - rb, bx + rb, by + rb);
            path.arcTo(oval, (float) Math.toDegrees(th + ph), (float) Math.toDegrees(-2 * ph), false);
            path.lineTo((float) (ax + ra * Math.cos(th - ph)), (float) (ay + ra * Math.sin(th - ph)));
            oval.set(ax - ra, ay - ra, ax + ra, ay + ra);
            path.arcTo(oval, (float) Math.toDegrees(th - ph), (float) Math.toDegrees(2 * ph - 2 * Math.PI), false);
            path.close();
        }

        /** Path through pts[from..to) (x, y, r triples). */
        private Path build(float[] pts, int from, int to) {
            Path path = new Path();
            int n = to - from;
            if (n <= 0) return path;
            if (variable) {
                if (n == 1) addCapsule(path, pts[from * 3], pts[from * 3 + 1], pts[from * 3 + 2], pts[from * 3], pts[from * 3 + 1], pts[from * 3 + 2]);
                for (int i = from + 1; i < to; i++) {
                    addCapsule(path, pts[(i - 1) * 3], pts[(i - 1) * 3 + 1], pts[(i - 1) * 3 + 2], pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
                }
            } else {
                path.moveTo(pts[from * 3], pts[from * 3 + 1]);
                if (n == 1) path.lineTo(pts[from * 3] + 0.01f, pts[from * 3 + 1]);
                for (int i = from + 1; i < to; i++) path.lineTo(pts[i * 3], pts[i * 3 + 1]);
            }
            return path;
        }

        private void clear() {
            chunks.clear();
            chunkWidths.clear();
            settledCount = 0;
            chunkStart = 0;
            tail = new float[0];
            tailPath = new Path();
            hasRaw = false;
            active = false;
        }

        void handle(String msg) {
            String[] f = msg.split(",");
            if (f.length == 0) return;
            switch (f[0]) {
                case "b":
                    if (f.length < 10) return;
                    clear();
                    generation++;
                    paint.setColor(Color.argb(Math.round(Float.parseFloat(f[4]) * 255), Math.round(Float.parseFloat(f[1])), Math.round(Float.parseFloat(f[2])), Math.round(Float.parseFloat(f[3]))));
                    variable = !"0".equals(f[5]);
                    clip.set(Float.parseFloat(f[6]), Float.parseFloat(f[7]), Float.parseFloat(f[6]) + Float.parseFloat(f[8]), Float.parseFloat(f[7]) + Float.parseFloat(f[9]));
                    active = true;
                    break;
                case "u": {
                    if (!active || f.length < 2) return;
                    int total = (f.length - 2) / 3;
                    int fresh = Math.max(0, Math.min(total, Integer.parseInt(f[1])));
                    int drawn = settledCount;
                    if ((settledCount + fresh) * 3 > settled.length) {
                        float[] grown = new float[Math.max(settled.length * 2, (settledCount + fresh) * 3)];
                        System.arraycopy(settled, 0, grown, 0, settledCount * 3);
                        settled = grown;
                    }
                    for (int i = 0; i < fresh; i++) {
                        for (int k = 0; k < 3; k++) settled[(settledCount + i) * 3 + k] = Float.parseFloat(f[2 + i * 3 + k]);
                    }
                    settledCount += fresh;
                    // The tail continues from the last settled point.
                    int nt = total - fresh;
                    int lead = settledCount > 0 ? 1 : 0;
                    tail = new float[(nt + lead) * 3];
                    if (lead == 1) System.arraycopy(settled, (settledCount - 1) * 3, tail, 0, 3);
                    for (int i = 0; i < nt; i++) {
                        for (int k = 0; k < 3; k++) tail[(lead + i) * 3 + k] = Float.parseFloat(f[2 + (fresh + i) * 3 + k]);
                    }
                    if (fresh > 0) {
                        // The open chunk runs from its first point to the end; once it holds CHUNK points
                        // it is left as it is and the next starts at its last point.
                        if (chunks.isEmpty()) {
                            chunkStart = 0;
                            chunks.add(null);
                            chunkWidths.add(0f);
                        } else if (drawn - chunkStart >= CHUNK) {
                            chunkStart = drawn - 1;
                            chunks.add(null);
                            chunkWidths.add(0f);
                        }
                        chunks.set(chunks.size() - 1, build(settled, chunkStart, settledCount));
                        chunkWidths.set(chunkWidths.size() - 1, settled[(settledCount - 1) * 3 + 2] * 2);
                    }
                    tailPath = build(tail, 0, tail.length / 3);
                    tailWidth = tail.length > 0 ? tail[tail.length - 1] * 2 : 0;
                    break;
                }
                case "e":
                case "c":
                    generation++;
                    clear();
                    break;
                default:
                    return;
            }
            invalidate();
        }

        /** The stylus's newest raw position (window px), straight from the touch event. */
        void leadTo(float windowX, float windowY) {
            webView.getLocationInWindow(wvLoc);
            rawX = windowX - wvLoc[0];
            rawY = windowY - wvLoc[1];
            hasRaw = true;
            invalidate();
        }

        /** Safety net: the page normally clears the ink ("e"); if it never does, do not leave it. */
        void touchEnded() {
            int gen = generation;
            postDelayed(() -> {
                if (generation == gen && active) {
                    clear();
                    invalidate();
                }
            }, 2000);
        }

        private void drawPath(Canvas canvas, Path path, float width) {
            if (variable) {
                paint.setStyle(Paint.Style.FILL);
            } else {
                paint.setStyle(Paint.Style.STROKE);
                paint.setStrokeWidth(width);
                paint.setStrokeCap(Paint.Cap.ROUND);
                paint.setStrokeJoin(Paint.Join.ROUND);
            }
            canvas.drawPath(path, paint);
        }

        @Override
        protected void onDraw(Canvas canvas) {
            if (!active) return;
            webView.getLocationInWindow(wvLoc);
            getLocationInWindow(myLoc);
            canvas.save();
            canvas.translate(wvLoc[0] - myLoc[0], wvLoc[1] - myLoc[1]);
            canvas.clipRect(clip);
            for (int i = 0; i < chunks.size(); i++) {
                Path p = chunks.get(i);
                if (p != null) drawPath(canvas, p, chunkWidths.get(i));
            }
            drawPath(canvas, tailPath, tailWidth);
            int n = tail.length / 3;
            float ex, ey, er;
            if (n > 0) {
                ex = tail[(n - 1) * 3]; ey = tail[(n - 1) * 3 + 1]; er = tail[(n - 1) * 3 + 2];
            } else if (settledCount > 0) {
                ex = settled[(settledCount - 1) * 3]; ey = settled[(settledCount - 1) * 3 + 1]; er = settled[(settledCount - 1) * 3 + 2];
            } else {
                canvas.restore();
                return;
            }
            if (hasRaw) {
                float[] seg = { ex, ey, er, rawX, rawY, er };
                drawPath(canvas, build(seg, 0, 2), er * 2);
            }
            canvas.restore();
        }
    }

    /** Called by MainActivity for every touch event before the WebView gets it. */
    static void onTouch(MotionEvent ev) {
        InkOverlay view = overlay;
        if (view == null || !view.isActive()) return;
        int i = ev.getActionIndex();
        if (ev.getToolType(i) != MotionEvent.TOOL_TYPE_STYLUS) return;
        switch (ev.getActionMasked()) {
            case MotionEvent.ACTION_MOVE:
                view.leadTo(ev.getX(i), ev.getY(i));
                break;
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL:
                view.touchEnded();
                break;
            default:
                break;
        }
    }
}
