import { RefObject, useEffect, useRef } from 'react';
import { Stroke } from '../types';
import { GlInk, prepareGlGeometry } from '../ink/glInk';
import { drawStrokes } from '../ink/strokeRenderer';
import { tileWork } from './tileWork';
import { frameRate } from '../services/frameRate';

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
const PREPARE_AFTER_MS = 800;
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
    try {
      shared = GlInk.create();
    } catch {
      shared = null;
    }
  }
  return shared;
}

export function usePinchInk(container: RefObject<HTMLElement | null>, scrollRoot: HTMLElement | null, strokes: Stroke[], pageWidth: number, smooth: boolean, enabled: boolean) {
  const latest = useRef({ strokes, pageWidth, smooth, enabled });
  latest.current = { strokes, pageWidth, smooth, enabled };

  // Ahead of the next pinch.
  useEffect(() => {
    if (!enabled || !strokes.length) return;
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(function slice() {
      timer = null;
      if (tileWork.paused) return;
      if (!prepareGlGeometry(strokes, smooth, PREPARE_SLICE_MS())) {
        timer = setTimeout(slice, 4);
        return;
      }
      const g = glInk();
      if (!g) return;
      const first = !warmed.has(g);
      g.setStrokes(strokes, smooth);
      if (first) {
        warmed.add(g);
        g.warm();
      }
    }, PREPARE_AFTER_MS);
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [strokes, smooth, enabled]);

  useEffect(() => {
    if (!scrollRoot) return;
    let on = false;
    let loop: number | null = null;

    const draw = () => {
      const g = shared, c = container.current;
      if (!g || !c) return;
      const er = scrollRoot.getBoundingClientRect(), r = c.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      g.resize(er.width * dpr, er.height * dpr);
      g.draw({ scale: (r.width / latest.current.pageWidth) * dpr, ox: (r.left - er.left) * dpr, oy: (r.top - er.top) * dpr });
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
      const { strokes: list, smooth: sm } = latest.current;
      if (!c || !parent || tileWork.shell || !latest.current.enabled || !list.length) return;
      // Only once the geometry is prepared (a long note, the first seconds after opening it):
      // preparing it here held the first frame of the pinch up for a second.
      if (!prepareGlGeometry(list, sm, 0)) return;
      const g = glInk();
      if (!g) return;
      if (loop !== null) cancelAnimationFrame(loop);
      loop = null;
      Object.assign(g.canvas.style, {
        position: 'absolute', left: `${scrollRoot.offsetLeft}px`, top: `${scrollRoot.offsetTop}px`,
        width: `${scrollRoot.clientWidth}px`, height: `${scrollRoot.clientHeight}px`, pointerEvents: 'none', zIndex: '1', display: '',
      });
      if (g.canvas.parentElement !== parent || g.canvas.previousSibling !== scrollRoot) parent.insertBefore(g.canvas, scrollRoot.nextSibling);
      g.setStrokes(list, sm);
      draw();
      c.classList.add('on-gl-ink');
      on = true;
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

// For the UI benchmark (bench/ui.mjs --only glcompare): both renderers on the same strokes.
(window as unknown as { __opennoteGlInk?: unknown }).__opennoteGlInk = { GlInk, drawStrokes, shared: () => shared };
