import { RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Stroke } from '../types';
import { GlInk, RGBA, prepareGlGeometry } from '../ink/glInk';
import { drawStrokes } from '../ink/strokeRenderer';
import { tileWork } from './tileWork';
import { frameRate } from '../services/frameRate';
import { crashLog } from '../services/crashLog';

/**
 * The ink while two fingers zoom, drawn by the GPU from its vectors on every frame (glInk.ts), as
 * Notability-style apps keep it sharp: the page's canvases and tiles are bitmaps, stretched until
 * the fingers lifted. When a pinch starts, the GPU canvas (laid over the scroll view) draws the
 * strokes and the page's ink is hidden in the same frame; every frame of the pinch it is drawn
 * again at the content's transform; once the fingers lift it stays, following the new zoom, until
 * the sharp ink has painted the tiles in view (tileWork.painting), then the page's ink is shown
 * and the GPU canvas hidden, in one frame. Between pinches the canvas is 1 x 1 (no memory).
 * Everything a pinch needs (the GPU context, its programs, the strokes' geometry in its buffers) is
 * made ahead, a slice at a time once the note has been still for a moment: made when the fingers
 * started, it held up the first pinch of a long note for a second.
 * Not when the iOS shell draws the pinch (tileWork.shell, Low Power Mode).
 */

/** The GPU ink stays at most this long after the fingers lift. */
const HANDOFF_MAX_MS = 1500;
/** The note still this long: the next pinch's geometry is prepared, PREPARE_SLICE_MS at a time. */
const PREPARE_AFTER_MS = 300;
/**
 * A pinch starting with strokes not prepared yet (just written, or the note just opened) prepares
 * them for up to this many frames; with more left than that it uses the bitmaps.
 */
const START_FRAMES = 1.5;
const PREPARE_SLICE_MS = () => frameRate.frameMs * 0.36;

let shared: GlInk | null | undefined;
/** Renderers whose pipelines have been through GlInk.warm. */
const warmed = new WeakSet<GlInk>();
function glInk(): GlInk | null {
  if (shared?.lost) {
    shared.canvas.remove();
    shared = undefined;
  }
  if (shared === undefined) {
    // For comparisons (benchmark, diagnostics): localStorage opennote_gl = 'off' keeps the bitmaps.
    try {
      if (localStorage.getItem('opennote_gl') === 'off') return null;
    } catch {
      /* storage unavailable */
    }
    try {
      shared = GlInk.create();
    } catch {
      shared = null;
    }
  }
  return shared;
}

export function usePinchInk(container: RefObject<HTMLElement | null>, scrollRoot: HTMLElement | null, strokes: Stroke[], pageWidth: number, enabled: boolean) {
  const latest = useRef({ strokes, pageWidth, enabled });
  latest.current = { strokes, pageWidth, enabled };
  const mountedAt = useRef(performance.now());

  // Ahead of the next pinch.
  useEffect(() => {
    if (!enabled || !strokes.length) return;
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(function slice() {
      timer = null;
      if (tileWork.paused) return;
      if (!prepareGlGeometry(strokes, PREPARE_SLICE_MS())) {
        timer = setTimeout(slice, 4);
        return;
      }
      const g = glInk();
      if (!g) return;
      const first = !warmed.has(g);
      g.setStrokes(strokes);
      if (first) {
        warmed.add(g);
        g.warm();
        crashLog.event('gl-ready', { ms: Math.round(performance.now() - mountedAt.current), pieces: g.pieces, strokes: strokes.length });
      }
    }, PREPARE_AFTER_MS);
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [strokes, enabled]);

  useEffect(() => {
    if (!scrollRoot) return;
    let on = false;
    let loop: number | null = null;

    let logged = false;
    const draw = () => {
      const g = shared, c = container.current;
      if (!g || !c) return;
      // Sized and placed from the canvas's own box: the scroll view's box is larger by its
      // scrollbars where they take room (Android, styled scrollbars), and the ink drawn for it was
      // squeezed into the canvas, a little smaller than the page's.
      const er = g.canvas.getBoundingClientRect(), r = c.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      g.resize(er.width * dpr, er.height * dpr);
      g.draw({ scale: (r.width / latest.current.pageWidth) * dpr, ox: (r.left - er.left) * dpr, oy: (r.top - er.top) * dpr });
      if (!logged) {
        logged = true;
        logGeometry('pinch', g, scrollRoot.getBoundingClientRect(), r, latest.current.pageWidth, dpr);
      }
    };
    const stop = () => {
      on = false;
      if (loop !== null) cancelAnimationFrame(loop);
      loop = null;
      container.current?.classList.remove('on-gl-ink');
      if (shared) {
        shared.canvas.style.display = 'none';
        shared.resize(1, 1);
      }
    };
    const start = () => {
      const c = container.current, parent = scrollRoot.parentElement;
      const list = latest.current.strokes;
      const t0 = performance.now();
      tileWork.gl = tileWork.shell ? 'shell' : 'off';
      if (!c || !parent || tileWork.shell || !latest.current.enabled || !list.length) return;
      // Strokes not prepared yet are prepared now, a frame and a half at most (preparing a whole
      // long note here held the first frame of the pinch up for a second): with more left, bitmaps.
      if (!prepareGlGeometry(list, frameRate.frameMs * START_FRAMES)) {
        tileWork.gl = 'preparing';
        return;
      }
      const g = glInk();
      if (!g) {
        tileWork.gl = 'no-webgl';
        return;
      }
      if (loop !== null) cancelAnimationFrame(loop);
      loop = null;
      Object.assign(g.canvas.style, {
        position: 'absolute', left: `${scrollRoot.offsetLeft}px`, top: `${scrollRoot.offsetTop}px`,
        width: `${scrollRoot.clientWidth}px`, height: `${scrollRoot.clientHeight}px`, pointerEvents: 'none', zIndex: '1', display: '',
      });
      if (g.canvas.parentElement !== parent || g.canvas.previousSibling !== scrollRoot) parent.insertBefore(g.canvas, scrollRoot.nextSibling);
      g.setStrokes(list);
      logged = false;
      draw();
      c.classList.add('on-gl-ink');
      on = true;
      tileWork.gl = 'gpu';
      tileWork.glStartMs = Math.round(performance.now() - t0);
    };
    const moved = () => {
      if (on) draw();
    };
    const ended = () => {
      if (!on) return;
      const t0 = performance.now();
      let frames = 0;
      const tick = () => {
        loop = null;
        if (!on) return;
        draw();
        frames++;
        // At least a few frames (the new zoom committed, the sharp ink started), then until it is done.
        if ((frames >= 3 && tileWork.painting.size === 0) || performance.now() - t0 > HANDOFF_MAX_MS) stop();
        else loop = requestAnimationFrame(tick);
      };
      loop = requestAnimationFrame(tick);
    };
    tileWork.pause.add(start);
    tileWork.moved.add(moved);
    tileWork.ended.add(ended);
    return () => {
      tileWork.pause.delete(start);
      tileWork.moved.delete(moved);
      tileWork.ended.delete(ended);
      if (on) stop();
    };
  }, [scrollRoot, container]);
}

/**
 * Where the GPU ink really lands, for the crash report (once per drag or pinch): its canvas on
 * screen and in pixels, its drawing buffer, and the scale it draws at (the page's ink was
 * reported drawn smaller by the GPU on a device, which the benchmark does not show).
 */
function logGeometry(via: 'drag' | 'pinch', g: GlInk, er: DOMRect, r: DOMRect, pageWidth: number, dpr: number) {
  const cr = g.canvas.getBoundingClientRect(), b = g.bufferSize;
  const n = (v: number) => Math.round(v * 100) / 100;
  crashLog.event('gl-geometry', {
    via, dpr: n(window.devicePixelRatio), used: n(dpr), view: [n(er.width), n(er.height)], canvasCss: [n(cr.width), n(cr.height)], canvasAt: [n(cr.left - er.left), n(cr.top - er.top)],
    canvasPx: [g.canvas.width, g.canvas.height], buffer: [b.w, b.h], zoom: n(r.width / pageWidth), page: [n(r.width), n(r.height)], vv: n(window.visualViewport?.scale ?? 1),
  });
}

// For the UI benchmark (bench/ui.mjs --only glcompare): both renderers on the same strokes.
(window as unknown as { __opennoteGlInk?: unknown }).__opennoteGlInk = { GlInk, drawStrokes, shared: () => shared };

let dragShared: GlInk | null | undefined;
function dragGlInk(): GlInk | null {
  if (dragShared?.lost) {
    dragShared.canvas.remove();
    dragShared = undefined;
  }
  if (dragShared === undefined) {
    try {
      dragShared = localStorage.getItem('opennote_gl') === 'off' ? null : GlInk.create();
    } catch {
      dragShared = null;
    }
  }
  return dragShared;
}

/** A selection being dragged: moved by (dx, dy), scaled (fx, fy) about its corner, turned `rot` degrees about its centre. */
export interface DragView {
  bounds: { x: number; y: number; width: number; height: number };
  dx: number;
  dy: number;
  fx: number;
  fy: number;
  rot: number;
}

/** The glow of a selection (the canvas one's colour; 7 page px, as its shadow). */
const SELECTION_GLOW: { radius: number; rgba: RGBA } = { radius: 7, rgba: [37 / 255, 99 / 255, 235 / 255, 0.9] };

/**
 * The ink of a selection being moved, stretched or turned, drawn by the GPU from its vectors on
 * every frame, with its glow: a canvas holding it as a bitmap was capped in size, and a large
 * selection zoomed in looked coarse while it moved. Its own GPU canvas over the scroll view; hidden
 * two frames after the drag ends (the page has drawn the dropped ink by then). Returns whether it
 * draws (the canvas copy is then not made).
 */
export function useDragInk(container: RefObject<HTMLElement | null>, scrollRoot: HTMLElement | null, pageWidth: number, drag: DragView | null, strokes: Stroke[]): boolean {
  const [active, setActive] = useState(false);
  const logged = useRef(false);
  const live = !!drag && strokes.length > 0;
  useLayoutEffect(() => {
    const parent = scrollRoot?.parentElement;
    if (!live || !scrollRoot || !parent) return;
    const g = dragGlInk();
    if (!g) return;
    Object.assign(g.canvas.style, {
      position: 'absolute', left: `${scrollRoot.offsetLeft}px`, top: `${scrollRoot.offsetTop}px`,
      width: `${scrollRoot.clientWidth}px`, height: `${scrollRoot.clientHeight}px`, pointerEvents: 'none', zIndex: '1', display: '',
    });
    if (g.canvas.parentElement !== parent) parent.insertBefore(g.canvas, scrollRoot.nextSibling);
    g.setStrokes(strokes);
    logged.current = false;
    setActive(true);
    return () => {
      setActive(false);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (dragShared && !dragShared.lost) {
            dragShared.canvas.style.display = 'none';
            dragShared.resize(1, 1);
          }
        })
      );
    };
  }, [live, scrollRoot, strokes]);
  useLayoutEffect(() => {
    const g = dragShared, c = container.current;
    if (!active || !drag || !g || !c || !scrollRoot) return;
    // From the canvas's own box (see usePinchInk's draw).
    const er = g.canvas.getBoundingClientRect(), r = c.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    g.resize(er.width * dpr, er.height * dpr);
    const k = (r.width / pageWidth) * dpr;
    const { bounds: b, dx, dy, fx, fy } = drag;
    const t = (drag.rot * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t);
    // As transformSelection: scaled about the corner and moved, then turned about the result's centre.
    const ux = b.x - b.x * fx + dx, uy = b.y - b.y * fy + dy;
    const cx = b.x + (b.width * fx) / 2 + dx, cy = b.y + (b.height * fy) / 2 + dy;
    const px = cos * (ux - cx) - sin * (uy - cy) + cx, py = sin * (ux - cx) + cos * (uy - cy) + cy;
    g.draw(
      {
        scale: k * Math.sqrt(Math.abs(fx * fy)),
        ox: k * px + (r.left - er.left) * dpr,
        oy: k * py + (r.top - er.top) * dpr,
        m: [k * cos * fx, k * sin * fx, -k * sin * fy, k * cos * fy],
      },
      SELECTION_GLOW
    );
    if (!logged.current) {
      logged.current = true;
      logGeometry('drag', g, scrollRoot.getBoundingClientRect(), r, pageWidth, dpr);
    }
  }, [drag, active, pageWidth, scrollRoot, container]);
  return active;
}
