package com.opennote.app;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.DashPathEffect;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.os.SystemClock;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.Locale;

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
    /** The WebView, for the stylus samples sent to the page (forwardStylus). */
    static WebView web;
    /** Pointer id of the stylus touch being forwarded (-1: none). */
    private static int stylusId = -1;

    @Override
    public void load() {
        WebView webView = getBridge().getWebView();
        web = webView;
        // Content just off screen is kept rendered: scrolling and zooming the note no longer wait
        // for it to be drawn as it comes into view (Android's own advice for smooth scrolling).
        webView.getSettings().setOffscreenPreRaster(true);
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
        /** A whole drawing (Draw tool shapes, snapped pen shapes) as the page's commands (inkRecorder.ts). */
        private String[] scene;
        private final RectF sceneClip = new RectF();
        private final Paint scenePaint = new Paint(Paint.ANTI_ALIAS_FLAG);

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
            scene = null;
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
                case "d": {
                    if (f.length < 5) return;
                    // Replaces the stroke (a pen stroke that snapped to a shape) or the last drawing.
                    boolean wasScene = active && scene != null;
                    if (!wasScene) {
                        clear();
                        generation++;
                    }
                    sceneClip.set(Float.parseFloat(f[1]), Float.parseFloat(f[2]), Float.parseFloat(f[1]) + Float.parseFloat(f[3]), Float.parseFloat(f[2]) + Float.parseFloat(f[4]));
                    scene = f;
                    active = true;
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
            // The stylus lifted: no lead past the line's end (the line ends where the ink engine ends it).
            hasRaw = false;
            invalidate();
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

        /** Canvas state the page's commands set (canvas.save() does not keep Paint settings). */
        private static final class SceneState {
            int fill = Color.BLACK, stroke = Color.BLACK;
            float alpha = 1, width = 1;
            Paint.Cap cap = Paint.Cap.BUTT;
            Paint.Join join = Paint.Join.MITER;
            float[] dash = null;
            float dashOffset = 0;

            SceneState copy() {
                SceneState c = new SceneState();
                c.fill = fill; c.stroke = stroke; c.alpha = alpha; c.width = width; c.cap = cap; c.join = join;
                c.dash = dash; c.dashOffset = dashOffset;
                return c;
            }
        }

        private static int color(String[] t, int i) {
            return Color.argb(Math.round(Float.parseFloat(t[i + 3]) * 255), Math.round(Float.parseFloat(t[i])), Math.round(Float.parseFloat(t[i + 1])), Math.round(Float.parseFloat(t[i + 2])));
        }

        private static int withAlpha(int c, float alpha) {
            return (c & 0x00FFFFFF) | (Math.round(Color.alpha(c) * alpha) << 24);
        }

        /** canvas arc(): angles in radians, ccw = decreasing angle; a sweep of 2pi or more is a full circle. */
        private void arc(Path p, float cx, float cy, float r, double a0, double a1, boolean ccw) {
            oval.set(cx - r, cy - r, cx + r, cy + r);
            double sweep;
            if (Math.abs(a1 - a0) >= 2 * Math.PI - 1e-4) sweep = ccw ? -2 * Math.PI : 2 * Math.PI;
            else if (!ccw) { sweep = a1 - a0; while (sweep < 0) sweep += 2 * Math.PI; }
            else { sweep = a1 - a0; while (sweep > 0) sweep -= 2 * Math.PI; }
            if (Math.abs(sweep) >= 2 * Math.PI - 1e-4) {
                // Android's arcTo cannot draw a whole circle: two halves.
                float half = (float) Math.toDegrees(sweep / 2);
                p.arcTo(oval, (float) Math.toDegrees(a0), half, p.isEmpty());
                p.arcTo(oval, (float) Math.toDegrees(a0) + half, half, false);
            } else {
                p.arcTo(oval, (float) Math.toDegrees(a0), (float) Math.toDegrees(sweep), p.isEmpty());
            }
        }

        private void drawScene(Canvas canvas, String[] t) {
            int saved = canvas.save();
            canvas.clipRect(sceneClip);
            SceneState st = new SceneState();
            ArrayList<SceneState> stack = new ArrayList<>();
            Path path = new Path();
            int i = 5, n = t.length;
            try {
                while (i < n) {
                    String op = t[i++];
                    switch (op) {
                        case "S": stack.add(st.copy()); canvas.save(); break;
                        case "R":
                            // Never below this drawing's own save (an unbalanced restore would crash).
                            if (!stack.isEmpty()) {
                                st = stack.remove(stack.size() - 1);
                                if (canvas.getSaveCount() > saved + 1) canvas.restore();
                            }
                            break;
                        case "F": st.fill = color(t, i); i += 4; break;
                        case "K": st.stroke = color(t, i); i += 4; break;
                        case "A": st.alpha = Float.parseFloat(t[i++]); break;
                        case "W": st.width = Float.parseFloat(t[i++]); break;
                        case "P": {
                            int c = Integer.parseInt(t[i]), j = Integer.parseInt(t[i + 1]);
                            st.cap = c == 1 ? Paint.Cap.ROUND : c == 2 ? Paint.Cap.SQUARE : Paint.Cap.BUTT;
                            st.join = j == 1 ? Paint.Join.ROUND : j == 2 ? Paint.Join.BEVEL : Paint.Join.MITER;
                            i += 2;
                            break;
                        }
                        case "D": {
                            int cnt = Integer.parseInt(t[i]);
                            float[] d = new float[cnt];
                            for (int k = 0; k < cnt; k++) d[k] = Math.max(0.01f, Float.parseFloat(t[i + 1 + k]));
                            st.dash = cnt >= 2 && cnt % 2 == 0 ? d : null;
                            st.dashOffset = Float.parseFloat(t[i + 1 + cnt]);
                            i += cnt + 2;
                            break;
                        }
                        case "N": path = new Path(); break;
                        case "M": path.moveTo(Float.parseFloat(t[i]), Float.parseFloat(t[i + 1])); i += 2; break;
                        case "L":
                            if (path.isEmpty()) path.moveTo(Float.parseFloat(t[i]), Float.parseFloat(t[i + 1]));
                            else path.lineTo(Float.parseFloat(t[i]), Float.parseFloat(t[i + 1]));
                            i += 2;
                            break;
                        case "Q": path.quadTo(Float.parseFloat(t[i]), Float.parseFloat(t[i + 1]), Float.parseFloat(t[i + 2]), Float.parseFloat(t[i + 3])); i += 4; break;
                        case "C": path.cubicTo(Float.parseFloat(t[i]), Float.parseFloat(t[i + 1]), Float.parseFloat(t[i + 2]), Float.parseFloat(t[i + 3]), Float.parseFloat(t[i + 4]), Float.parseFloat(t[i + 5])); i += 6; break;
                        case "E":
                            arc(path, Float.parseFloat(t[i]), Float.parseFloat(t[i + 1]), Float.parseFloat(t[i + 2]), Double.parseDouble(t[i + 3]), Double.parseDouble(t[i + 4]), !"0".equals(t[i + 5]));
                            i += 6;
                            break;
                        case "X": {
                            float x = Float.parseFloat(t[i]), y = Float.parseFloat(t[i + 1]);
                            path.addRect(x, y, x + Float.parseFloat(t[i + 2]), y + Float.parseFloat(t[i + 3]), Path.Direction.CW);
                            i += 4;
                            break;
                        }
                        case "Z": path.close(); break;
                        case "f":
                            path.setFillType("1".equals(t[i++]) ? Path.FillType.EVEN_ODD : Path.FillType.WINDING);
                            scenePaint.setPathEffect(null);
                            scenePaint.setStyle(Paint.Style.FILL);
                            scenePaint.setColor(withAlpha(st.fill, st.alpha));
                            canvas.drawPath(path, scenePaint);
                            break;
                        case "s":
                            scenePaint.setStyle(Paint.Style.STROKE);
                            scenePaint.setColor(withAlpha(st.stroke, st.alpha));
                            scenePaint.setStrokeWidth(st.width);
                            scenePaint.setStrokeCap(st.cap);
                            scenePaint.setStrokeJoin(st.join);
                            scenePaint.setPathEffect(st.dash != null ? new DashPathEffect(st.dash, st.dashOffset) : null);
                            canvas.drawPath(path, scenePaint);
                            break;
                        case "x":
                            path.setFillType("1".equals(t[i++]) ? Path.FillType.EVEN_ODD : Path.FillType.WINDING);
                            canvas.clipPath(path);
                            break;
                        default:
                            break;
                    }
                }
            } catch (RuntimeException e) {
                // A malformed message: show what was drawn so far rather than crash the app.
            }
            canvas.restoreToCount(saved);
        }

        @Override
        protected void onDraw(Canvas canvas) {
            if (!active) return;
            webView.getLocationInWindow(wvLoc);
            getLocationInWindow(myLoc);
            canvas.save();
            canvas.translate(wvLoc[0] - myLoc[0], wvLoc[1] - myLoc[1]);
            if (scene != null) {
                drawScene(canvas, scene);
                canvas.restore();
                return;
            }
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
    /**
     * Every stylus sample to the page (window.__opennotePencil, src/ink/nativePencil.ts), as the iOS
     * shell does with the Pencil's 240 Hz samples: the WebView's pointer events carry about one sample
     * per display frame, and the ink engine drew the long gaps of a fast stroke as straight pieces
     * (a fast swirl came out segmented, live and once finished). A MotionEvent keeps the samples
     * between frames as its history; all of them are sent, in CSS px of the WebView, with the
     * pressure (0..1), the time (s, uptime clock), altitude and azimuth (rad).
     */
    private static void forwardStylus(MotionEvent ev) {
        WebView view = web;
        if (view == null) return;
        int action = ev.getActionMasked();
        int idx = ev.getActionIndex();
        int phase;
        if (action == MotionEvent.ACTION_DOWN || action == MotionEvent.ACTION_POINTER_DOWN) {
            if (ev.getToolType(idx) != MotionEvent.TOOL_TYPE_STYLUS) return;
            stylusId = ev.getPointerId(idx);
            phase = 0;
        } else if (action == MotionEvent.ACTION_MOVE) {
            phase = 1;
        } else if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_POINTER_UP) {
            if (ev.getPointerId(idx) != stylusId) return;
            phase = 2;
        } else if (action == MotionEvent.ACTION_CANCEL) {
            phase = 3;
        } else {
            return;
        }
        if (stylusId < 0) return;
        int p = ev.findPointerIndex(stylusId);
        if (p < 0) return;
        int[] loc = new int[2];
        view.getLocationInWindow(loc);
        float density = view.getResources().getDisplayMetrics().density;
        StringBuilder js = new StringBuilder(256);
        js.append("window.__opennotePencil&&window.__opennotePencil(").append(phase).append(',')
                .append(String.format(Locale.ROOT, "%.5f", SystemClock.uptimeMillis() / 1000.0)).append(",[");
        int n = ev.getHistorySize();
        for (int h = 0; h <= n; h++) {
            boolean cur = h == n;
            float x = cur ? ev.getX(p) : ev.getHistoricalX(p, h);
            float y = cur ? ev.getY(p) : ev.getHistoricalY(p, h);
            float force = cur ? ev.getPressure(p) : ev.getHistoricalPressure(p, h);
            long t = cur ? ev.getEventTime() : ev.getHistoricalEventTime(h);
            float tilt = cur ? ev.getAxisValue(MotionEvent.AXIS_TILT, p) : ev.getHistoricalAxisValue(MotionEvent.AXIS_TILT, p, h);
            float orient = cur ? ev.getAxisValue(MotionEvent.AXIS_ORIENTATION, p) : ev.getHistoricalAxisValue(MotionEvent.AXIS_ORIENTATION, p, h);
            js.append(String.format(Locale.ROOT, "%.3f,%.3f,%.4f,%.5f,%.4f,%.4f,",
                    (x - loc[0]) / density, (y - loc[1]) / density, Math.max(0f, Math.min(1f, force)), t / 1000.0,
                    Math.PI / 2 - tilt, orient));
        }
        js.append("],[])");
        if (phase >= 2) stylusId = -1;
        view.evaluateJavascript(js.toString(), null);
    }

    static void onTouch(MotionEvent ev) {
        forwardStylus(ev);
        InkOverlay view = overlay;
        if (view == null || !view.isActive()) return;
        int i = ev.getActionIndex();
        if (ev.getToolType(i) != MotionEvent.TOOL_TYPE_STYLUS) return;
        switch (ev.getActionMasked()) {
            case MotionEvent.ACTION_MOVE:
                // Not to samples without pressure (the stylus leaving the glass): the ink engine leaves
                // them out of the ink, and a lead to them made the ink overshoot past its end.
                if (ev.getPressure(i) > 0.02f) view.leadTo(ev.getX(i), ev.getY(i));
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
