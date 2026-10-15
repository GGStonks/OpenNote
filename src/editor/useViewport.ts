import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { GestureBus } from './gestures';
import type { Stroke } from '../types';
import { drawStrokes, strokePaintBounds } from '../ink/strokeRenderer';
import { sceneItem } from '../ink/pinchScene';
import { tileWork } from './tileWork';

/**
 * The pinch overlay's worker (pinchWorker.ts), shared by every pinch so strokes are sent to it once.
 * null where OffscreenCanvas is missing (iPadOS before 16.4) or the worker failed: the overlay is
 * then drawn on the page's thread.
 */
let pinchWorker: Worker | null | undefined;
const workerIds = new WeakMap<Stroke, number>();
let nextWorkerId = 1;
function getPinchWorker(): Worker | null {
  if (pinchWorker !== undefined) return pinchWorker;
  try {
    if (typeof OffscreenCanvas === 'undefined' || !('transferControlToOffscreen' in HTMLCanvasElement.prototype)) return (pinchWorker = null);
    const w = new Worker(new URL('../ink/pinchWorker.ts', import.meta.url), { type: 'module' });
    w.addEventListener('error', () => {
      pinchWorker = null;
    });
    pinchWorker = w;
  } catch {
    pinchWorker = null;
  }
  return pinchWorker;
}

/**
 * Viewport of the note: scrolling, zoom and the pull that adds a page.
 *
 * One finger scrolls natively (the browser's own scrolling and fling, off the main thread) when
 * fingers do not draw: the note and its pages have `touch-action: pan-x pan-y`, and the touches
 * that must not scroll are cancelled when they start (touchstart preventDefault): the Pencil (it
 * writes; it scrolls only with the hand tool), a hand resting on the glass while the Pencil writes,
 * and a second finger, so two fingers always pan and pinch-zoom here in JS, with momentum. v2.0.5
 * and earlier scrolled with every finger in JS (touch-action: none everywhere), which lagged behind
 * the finger on slower tablets. When fingers draw, the pages keep touch-action: none and one finger
 * draws. The mouse wheel scrolls natively and ctrl + wheel (trackpad pinch) zooms.
 *
 * Zoom goes from MIN_ZOOM (or less, when fitting the width needs less) to MAX_ZOOM; 1 = actual size
 * (96 px per inch). It starts fitted to the width and refits when the window changes size
 * (rotation, split view) until the user zooms. While two fingers pinch, the content is scaled with
 * a CSS transform about the point between them (no re-layout per frame); the zoom is applied when
 * the pinch ends, with the same point kept under the fingers. A pinch only starts once the fingers'
 * distance changed by PINCH_START, so a two-finger scroll does not zoom by accident.
 *
 * Pulling past the end of the note (fingers, hand tool or wheel) reports the pull distance and,
 * past PULL_THRESHOLD, asks for a new page (onPullCommit).
 *
 * A quick tap of two or three fingers that barely move is reported through onFingerTap
 * (Notability: two-finger tap = undo, three-finger tap = redo).
 */

interface Options {
  contentWidth: number;
  fingersNavigate: () => boolean; // true when a single finger should scroll (stylus-only / hand tool)
  gestures: GestureBus;
  onFingerTap?: (fingers: number) => void;
  /** Distance (px) the note is pulled past its end; 0 when released. */
  onPull?: (distance: number) => void;
  /** The pull reached PULL_THRESHOLD. */
  onPullCommit?: () => void;
  /** The Pencil scrolls too (hand tool). */
  penScrolls?: () => boolean;
  /**
   * The ink to draw sharp while two fingers zoom: the surface's strokes and where the surface sits
   * in the unzoomed content (px). Without it the pinch shows the content stretched.
   */
  pinchInk?: () => { strokes: Stroke[]; pad: number } | null;
}

/**
 * Ink drawn sharp while two fingers zoom. The content is scaled with a CSS transform during a pinch,
 * which stretched the ink's canvases (blurry, more so the further the zoom went) until the fingers
 * lifted and the canvases were repainted at the new zoom, when the ink popped back sharp. A canvas
 * over the view now draws the visible strokes at the screen's resolution for the current pinch on
 * every frame (from their cached geometry), with the stretched ink hidden under it
 * ([data-pinching] [data-ink-layer], index.css), and stays until the page has repainted at the
 * new zoom, so the ink stays sharp throughout.
 */
class PinchInk {
  private canvas: HTMLCanvasElement | null = null;
  private frame: number | null = null;
  /** k: the pinch's scale; o: its origin (zoomed content px); z: the zoom the content is laid out at. */
  state: { k: number; o: { x: number; y: number }; z: number } | null = null;
  private removeTimer: number | null = null;
  /** The mapping (view x = ax + S * surface x) the canvas was last drawn with. */
  private drawn: { ax: number; ay: number; S: number } | null = null;
  private idle: ReturnType<typeof setTimeout> | null = null;
  /** Worker mode: the views sent (by sequence number), the page region whose strokes were sent. */
  private worker: Worker | null = null;
  private seq = 0;
  private views = new Map<number, { ax: number; ay: number; S: number }>();
  private region: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private settleSeq = -1;
  private onDrawn = (e: MessageEvent) => {
    if (e.data?.type !== 'drawn' || !this.canvas) return;
    const v = this.views.get(e.data.seq);
    if (!v) return;
    for (const k of this.views.keys()) if (k <= e.data.seq) this.views.delete(k);
    // Until the worker's first drawing the stretched page ink stays visible (no blank frame).
    if (!this.drawn) this.outer.setAttribute('data-pinching', '');
    this.drawn = v;
    this.follow();
    if (this.settleSeq >= 0 && e.data.seq >= this.settleSeq) this.handOver();
  };

  constructor(private el: HTMLElement, private outer: HTMLElement, private ink: () => { strokes: Stroke[]; pad: number } | null) {}

  show(k: number, o: { x: number; y: number }, z: number) {
    this.state = { k, o, z };
    if (this.removeTimer !== null) {
      cancelAnimationFrame(this.removeTimer);
      this.removeTimer = null;
    }
    if (!this.canvas) {
      const c = document.createElement('canvas');
      c.style.cssText = 'position:absolute;pointer-events:none;z-index:5;transform-origin:0 0;';
      this.el.parentElement?.appendChild(c);
      this.canvas = c;
      this.drawn = null;
      this.region = null;
      this.settleSeq = -1;
      tileWork.deferring = true;
      this.worker = getPinchWorker();
      if (this.worker) {
        try {
          const off = c.transferControlToOffscreen();
          this.worker.postMessage({ type: 'init', canvas: off, dpr: Math.min(window.devicePixelRatio || 1, 2) }, [off]);
          this.worker.addEventListener('message', this.onDrawn);
        } catch {
          this.worker = null;
        }
      }
      if (!this.worker) this.outer.setAttribute('data-pinching', '');
    }
    if (this.frame === null) this.frame = requestAnimationFrame(() => this.update(false));
    // Fingers resting: drawn exactly for where they are.
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.update(true), 120);
  }

  /** The page has been laid out at zoom z: the overlay hands over to it after two frames. */
  settle(z: number) {
    if (!this.canvas || !this.state) return;
    this.state = { k: 1, o: { x: 0, y: 0 }, z };
    if (this.worker) {
      // Hand over once the worker has drawn the final view (at most 600 ms later).
      this.update(true);
      this.settleSeq = this.seq;
      if (!this.drawn) {
        this.remove();
        return;
      }
      if (this.idle) clearTimeout(this.idle);
      this.idle = setTimeout(() => this.handOver(), 600);
      return;
    }
    this.update(false);
    this.handOver();
  }

  /**
   * The page's ink is shown again once its tiles have repainted at the new zoom (in slices, under
   * the overlay; at most 2.5 s), then the overlay goes on the next frame.
   */
  private handOver(since = performance.now()) {
    if (this.removeTimer !== null) return;
    if (tileWork.pending.size && performance.now() - since < 2500) {
      this.removeTimer = requestAnimationFrame(() => {
        this.removeTimer = null;
        this.handOver(since);
      });
      return;
    }
    this.removeTimer = requestAnimationFrame(() => {
      this.outer.removeAttribute('data-pinching');
      this.removeTimer = requestAnimationFrame(() => this.remove());
    });
  }

  remove() {
    tileWork.deferring = false;
    if (this.worker) {
      this.worker.removeEventListener('message', this.onDrawn);
      this.worker.postMessage({ type: 'detach' });
      this.worker = null;
    }
    this.views.clear();
    this.settleSeq = -1;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    if (this.removeTimer !== null) cancelAnimationFrame(this.removeTimer);
    if (this.idle) clearTimeout(this.idle);
    this.frame = this.removeTimer = this.idle = null;
    this.canvas?.remove();
    this.canvas = null;
    this.state = null;
    this.drawn = null;
    this.outer.removeAttribute('data-pinching');
  }

  /** The current mapping of surface px to view px. */
  private mapping(pad: number) {
    const st = this.state!;
    const S = st.z * st.k;
    const left = this.outer.offsetLeft - this.el.scrollLeft, top = this.outer.offsetTop - this.el.scrollTop;
    return { S, ax: left + st.o.x * (1 - st.k) + pad * S, ay: top + st.o.y * (1 - st.k) + pad * S };
  }

  /**
   * Follows the pinch. Drawing every visible stroke on every frame was too slow zoomed out, so the
   * canvas (drawn with a margin of MARGIN view sizes on each side) is moved and scaled with a CSS
   * transform between drawings, and drawn again when the zoom has changed by more than REDRAW_SCALE
   * since, when its margin would come into view, or when the fingers rest (`exact`).
   */
  private update(exact: boolean) {
    this.frame = null;
    const c = this.canvas, ink = this.ink();
    if (!c || !this.state || !ink) return;
    const el = this.el;
    const w = el.clientWidth, h = el.clientHeight;
    const m = this.mapping(ink.pad);
    if (this.worker) {
      this.sendScene(ink.strokes, m, w, h);
      const seq = ++this.seq;
      this.views.set(seq, m);
      this.place(c, w, h);
      this.worker.postMessage({ type: 'view', seq, ax: m.ax + MARGIN * w, ay: m.ay + MARGIN * h, S: m.S, w: w * (1 + 2 * MARGIN), h: h * (1 + 2 * MARGIN) });
      this.follow();
      return;
    }
    const d = this.drawn;
    if (d && !exact) {
      const r = m.S / d.S;
      // Where the drawn canvas's corners land now (view px).
      const left = m.ax + (-MARGIN * w - d.ax) * r, top = m.ay + (-MARGIN * h - d.ay) * r;
      const right = left + w * (1 + 2 * MARGIN) * r, bottom = top + h * (1 + 2 * MARGIN) * r;
      if (Math.abs(r - 1) < REDRAW_SCALE && left <= 0 && top <= 0 && right >= w && bottom >= h) {
        c.style.transform = `translate(${left}px, ${top}px) scale(${r})`;
        return;
      }
    }
    this.draw(c, ink.strokes, m, w, h);
  }

  /** Positions and sizes the overlay element (its pixels belong to the worker). */
  private place(c: HTMLCanvasElement, w: number, h: number) {
    c.style.left = `${this.el.offsetLeft}px`;
    c.style.top = `${this.el.offsetTop}px`;
    c.style.width = `${w * (1 + 2 * MARGIN)}px`;
    c.style.height = `${h * (1 + 2 * MARGIN)}px`;
  }

  /** Worker mode: moves the canvas from the view it was drawn for to the current one. */
  private follow() {
    const c = this.canvas, d = this.drawn, ink = this.ink();
    if (!c || !d || !ink || !this.state) return;
    const w = this.el.clientWidth, h = this.el.clientHeight;
    const m = this.mapping(ink.pad);
    const r = m.S / d.S;
    c.style.transform = `translate(${m.ax + (-MARGIN * w - d.ax) * r}px, ${m.ay + (-MARGIN * h - d.ay) * r}px) scale(${r})`;
  }

  /**
   * Worker mode: sends the strokes of the page region around the view that the worker does not have
   * yet (each once per session), and which of them to draw. The region is the view plus half a view
   * on every side, and grows when the view leaves it (zooming out).
   */
  private sendScene(strokes: Stroke[], m: { ax: number; ay: number; S: number }, w: number, h: number) {
    const vx0 = -m.ax / m.S, vx1 = (w - m.ax) / m.S, vy0 = -m.ay / m.S, vy1 = (h - m.ay) / m.S;
    const r = this.region;
    if (r && vx0 >= r.x0 && vx1 <= r.x1 && vy0 >= r.y0 && vy1 <= r.y1) return;
    const dw = (vx1 - vx0) / 2, dh = (vy1 - vy0) / 2;
    const reg = { x0: vx0 - dw, x1: vx1 + dw, y0: vy0 - dh, y1: vy1 + dh };
    this.region = reg;
    const list: { id: number; item: ReturnType<typeof sceneItem> }[] = [];
    const ids: number[] = [];
    for (const s of strokes) {
      const b = strokePaintBounds(s);
      if (b.maxX < reg.x0 || b.minX > reg.x1 || b.maxY < reg.y0 || b.minY > reg.y1) continue;
      let id = workerIds.get(s);
      if (id === undefined) {
        id = nextWorkerId++;
        workerIds.set(s, id);
        list.push({ id, item: sceneItem(s) });
      }
      ids.push(id);
    }
    if (list.length) this.worker!.postMessage({ type: 'items', list });
    this.worker!.postMessage({ type: 'order', ids });
  }

  private draw(c: HTMLCanvasElement, strokes: Stroke[], m: { ax: number; ay: number; S: number }, w: number, h: number) {
    const el = this.el;
    // At most 2x: the overlay lives only while fingers zoom, and a 3x canvas of the view plus its
    // margin cost more to draw and composite than the sharpness was worth.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = w * (1 + 2 * MARGIN), ch = h * (1 + 2 * MARGIN);
    c.style.left = `${el.offsetLeft}px`;
    c.style.top = `${el.offsetTop}px`;
    c.style.width = `${cw}px`;
    c.style.height = `${ch}px`;
    c.style.transform = `translate(${-MARGIN * w}px, ${-MARGIN * h}px)`;
    if (c.width !== Math.round(cw * dpr) || c.height !== Math.round(ch * dpr)) {
      c.width = Math.round(cw * dpr);
      c.height = Math.round(ch * dpr);
    }
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    // Canvas px = (view px + margin) * dpr; view px = a + S * surface px.
    const ox = m.ax + MARGIN * w, oy = m.ay + MARGIN * h;
    const x0 = -ox / m.S, x1 = (cw - ox) / m.S, y0 = -oy / m.S, y1 = (ch - oy) / m.S;
    const shown = strokes.filter((s) => {
      const b = strokePaintBounds(s);
      return b.maxX >= x0 && b.minX <= x1 && b.maxY >= y0 && b.minY <= y1;
    });
    ctx.setTransform(dpr * m.S, 0, 0, dpr * m.S, dpr * ox, dpr * oy);
    drawStrokes(ctx, shown);
    this.drawn = m;
  }
}

/** The pinch overlay is drawn this many view sizes beyond each edge, and again past this change of scale. */
const MARGIN = 0.15;
const REDRAW_SCALE = 0.15;

export type FitMode = 'width' | 'page' | null;

/** A content point (unscaled px, relative to the zoomed content) and where it goes on screen. */
interface Anchor {
  cx: number;
  cy: number;
  sx: number;
  sy: number;
}

const TAP_MAX_MS = 320;
const TAP_SLOP = 14;
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 5;
const PINCH_START = 0.05;
export const PULL_THRESHOLD = 110;
/** Pull distance per px of finger travel past the end (rubber band). */
const PULL_RESISTANCE = 0.5;

export function useViewport({ contentWidth, fingersNavigate, gestures, onFingerTap, onPull, onPullCommit, pinchInk, penScrolls }: Options) {
  const penScrollsRef = useRef(penScrolls);
  penScrollsRef.current = penScrolls;
  const pinchInkRef = useRef(pinchInk);
  pinchInkRef.current = pinchInk;
  const overlay = useRef<PinchInk | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const outerRef = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoomState] = useState(1);
  const zoomRef = useRef(1);
  const [fitMode, setFitModeState] = useState<FitMode>('width');
  const fitModeRef = useRef<FitMode>('width');
  /** Where to put the content after a zoom change (applied once the new size is laid out). */
  const anchor = useRef<Anchor | null>(null);
  const contentWidthRef = useRef(contentWidth);
  contentWidthRef.current = contentWidth;

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const last = useRef<{ x: number; y: number; t: number } | null>(null);
  const velocity = useRef({ x: 0, y: 0 });
  /** Recent finger positions (for the release velocity). */
  const history = useRef<{ x: number; y: number; t: number }[]>([]);
  /** Scroll distance not yet applied: scrolling is applied once per frame. */
  const pending = useRef({ x: 0, y: 0 });
  const scrollFrame = useRef<number | null>(null);
  const momentum = useRef<number | null>(null);
  const tap = useRef<{ start: number; fingers: number; moved: boolean; origins: Map<number, { x: number; y: number }> } | null>(null);
  /** Two fingers down: o = the point between them in the zoomed content's px when the pinch started. */
  const pinch = useRef<{ d0: number; z0: number; o: { x: number; y: number }; engaged: boolean; k: number } | null>(null);
  /** Finger travel past the end of the note. */
  const pullRaw = useRef(0);
  const cb = useRef({ onFingerTap, onPull, onPullCommit });
  cb.current = { onFingerTap, onPull, onPullCommit };

  const setFitMode = (m: FitMode) => {
    fitModeRef.current = m;
    setFitModeState(m);
  };

  /** Content point under the screen point (sx, sy), relative to the scroll box. */
  const anchorAt = (sx: number, sy: number): Anchor | null => {
    const el = scrollRef.current, outer = outerRef.current;
    if (!el || !outer) return null;
    const z = zoomRef.current;
    return { cx: (el.scrollLeft + sx - outer.offsetLeft) / z, cy: (el.scrollTop + sy - outer.offsetTop) / z, sx, sy };
  };

  const applyAnchor = () => {
    const el = scrollRef.current, outer = outerRef.current, a = anchor.current;
    anchor.current = null;
    if (outer) {
      outer.style.transform = '';
      outer.style.transformOrigin = '';
    }
    if (!el || !outer || !a) return;
    const z = zoomRef.current;
    el.scrollLeft = a.cx * z + outer.offsetLeft - a.sx;
    el.scrollTop = a.cy * z + outer.offsetTop - a.sy;
  };

  /**
   * Sets the zoom, keeping `a` (default: the middle of the screen) in place. Below MIN_ZOOM only
   * as far as fitting the width (or `floor`, for fitting a page) needs.
   */
  const setView = useCallback((z: number, a?: Anchor | null, floor = Infinity) => {
    const el = scrollRef.current;
    if (!el) return;
    const fitW = el.clientWidth / contentWidthRef.current;
    z = Math.max(Math.min(MIN_ZOOM, fitW, floor), Math.min(MAX_ZOOM, z));
    anchor.current = a ?? anchorAt(el.clientWidth / 2, el.clientHeight / 2);
    if (Math.abs(z - zoomRef.current) < 1e-4) {
      applyAnchor();
      return;
    }
    zoomRef.current = z;
    setZoomState(z);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Fits the width of the widest page, keeping the content at the top of the screen in place. */
  const fitWidth = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !el.clientWidth) return;
    setFitMode('width');
    const a = anchorAt(0, 0);
    setView(el.clientWidth / contentWidthRef.current, a && { ...a, cx: 0 });
  }, [setView]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Fits a rectangle of the content (unscaled px) on screen, centred: "fit page". */
  const zoomToRect = useCallback(
    (r: { x: number; y: number; width: number; height: number }) => {
      const el = scrollRef.current;
      if (!el || !el.clientWidth) return;
      setFitMode('page');
      const z = Math.min(el.clientWidth / r.width, el.clientHeight / r.height);
      setView(z, { cx: r.x + r.width / 2, cy: r.y + r.height / 2, sx: el.clientWidth / 2, sy: el.clientHeight / 2 }, z);
    },
    [setView]
  );

  /** Zooms by a factor about the middle of the screen (keyboard, buttons). */
  const zoomBy = useCallback(
    (f: number) => {
      setFitMode(null);
      setView(zoomRef.current * f);
    },
    [setView]
  );

  // Fitted to the width: refit when the window or the content width changes.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const refit = () => {
      if (fitModeRef.current === 'width') fitWidth();
    };
    refit();
    const ro = new ResizeObserver(refit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitWidth, contentWidth]);

  // After a zoom change: put the anchor back in place before the frame is painted.
  useLayoutEffect(() => {
    applyAnchor();
    if (overlay.current?.state) overlay.current.settle(zoom);
  }, [zoom]); // eslint-disable-line react-hooks/exhaustive-deps

  const stopMomentum = () => {
    if (momentum.current !== null) cancelAnimationFrame(momentum.current);
    momentum.current = null;
  };

  const startMomentum = () => {
    const el = scrollRef.current;
    if (!el) return;
    let { x: vx, y: vy } = velocity.current;
    if (Math.hypot(vx, vy) < 0.1) return;
    let t0 = performance.now();
    // UIScrollView's normal deceleration rate (0.998 per ms): long, soft glide.
    const step = (now: number) => {
      const dt = Math.min(32, now - t0);
      t0 = now;
      const bx = el.scrollLeft, by = el.scrollTop;
      el.scrollTop -= vy * dt;
      el.scrollLeft -= vx * dt;
      const decay = Math.pow(0.998, dt);
      vx *= decay;
      vy *= decay;
      const stuck = el.scrollTop === by && el.scrollLeft === bx; // reached an edge
      if (Math.hypot(vx, vy) > 0.01 && !stuck) momentum.current = requestAnimationFrame(step);
      else momentum.current = null;
    };
    momentum.current = requestAnimationFrame(step);
  };

  const reportPull = () => {
    const d = pullRaw.current * PULL_RESISTANCE;
    const outer = outerRef.current;
    if (outer && !pinch.current?.engaged) {
      outer.style.transition = '';
      outer.style.transform = d > 0 ? `translateY(${-d}px)` : '';
    }
    cb.current.onPull?.(d);
    if (d >= PULL_THRESHOLD) {
      pullRaw.current = 0;
      if (outer) outer.style.transform = '';
      cb.current.onPull?.(0);
      cb.current.onPullCommit?.();
    }
  };

  const releasePull = () => {
    if (pullRaw.current === 0) return;
    pullRaw.current = 0;
    const outer = outerRef.current;
    if (outer) {
      outer.style.transition = 'transform 220ms cubic-bezier(.2,.8,.2,1)';
      outer.style.transform = '';
      setTimeout(() => {
        if (outer.style.transform === '') outer.style.transition = '';
      }, 240);
    }
    cb.current.onPull?.(0);
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const rel = (e: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    /** Fingers that came down on a selection / handle (see onDown). */
    const controlFingers = new Set<number>();
    const centroid = () => {
      let x = 0, y = 0;
      for (const p of pointers.current.values()) {
        x += p.x;
        y += p.y;
      }
      const n = Math.max(1, pointers.current.size);
      return { x: x / n, y: y / n };
    };
    const spread = () => {
      const [a, b] = [...pointers.current.values()];
      return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
    };
    const resetTrack = () => {
      const c = centroid();
      last.current = { x: c.x, y: c.y, t: performance.now() };
      history.current = [last.current];
    };

    const beginPinch = () => {
      const d = spread();
      pinch.current = d > 0 ? { d0: d, z0: zoomRef.current, o: { x: 0, y: 0 }, engaged: false, k: 1 } : null;
    };

    /** Applies the pinch's zoom (fingers lifted or down to one). */
    const endPinch = () => {
      const p = pinch.current;
      pinch.current = null;
      const outer = outerRef.current;
      if (!p || !p.engaged || !outer) return;
      const z = p.z0 * p.k;
      const a = {
        cx: p.o.x / p.z0,
        cy: p.o.y / p.z0,
        sx: p.o.x + outer.offsetLeft - el.scrollLeft,
        sy: p.o.y + outer.offsetTop - el.scrollTop,
      };
      setFitMode(null);
      const before = zoomRef.current;
      setView(z, a);
      // The zoom did not change (no new layout to wait for): the content is back as it was.
      if (Math.abs(zoomRef.current - before) < 1e-4) overlay.current?.remove();
    };

    /** When the Pencil last came down (Chromium's touch events do not say which touches are a stylus). */
    let penDownAt = -Infinity;
    /** This gesture's movement scrolled the page here in JS (only then is there JS momentum). */
    let jsScrolled = false;
    /** The gesture started with the mouse (hand tool): the mouse drags the page here in JS. */
    let mouseDown = false;
    /** One finger (or the Pencil with the hand tool) scrolls natively: JS leaves it alone. */
    const nativeSingle = () => pointers.current.size === 1 && fingersNavigate() && !mouseDown;

    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'pen') penDownAt = performance.now();
      if (pointers.current.size === 0) {
        jsScrolled = false;
        mouseDown = e.pointerType === 'mouse';
      }
      // The mouse drags the page only where it does not draw (hand tool, gaps between pages).
      const navigateMouse = e.pointerType === 'mouse' && fingersNavigate() && e.button === 0 && !(e.target as HTMLElement).closest('[data-ink-input]');
      if (e.pointerType !== 'touch' && !navigateMouse) return;
      // The Pencil is writing: a touch now is the hand resting on the glass. It must not scroll or
      // zoom the page under the pen (the stroke would be bent), nor count as a finger.
      if (e.pointerType === 'touch' && gestures.inking && gestures.inkingWith === 'pen') return;
      // Leave touches on controls and text boxes alone.
      const target = e.target as HTMLElement;
      if (target.closest('textarea, input, button')) return;
      // A finger on a selection or a shape handle belongs to that control, but it still counts
      // as a finger: with a second one down, the two scroll the page and the drag is abandoned.
      const onControl = !!target.closest('[data-no-pan]');
      if (onControl && e.pointerType !== 'touch') return;
      if (onControl && target.closest('[data-no-pan-strict]')) return;
      if (onControl) controlFingers.add(e.pointerId);
      stopMomentum();
      if (e.pointerType === 'touch') {
        const now = performance.now();
        if (pointers.current.size === 0) tap.current = { start: now, fingers: 0, moved: false, origins: new Map() };
        const t = tap.current;
        if (t) {
          t.origins.set(e.pointerId, rel(e));
          t.fingers = Math.max(t.fingers, pointers.current.size + 1);
          if (now - t.start > TAP_MAX_MS) t.moved = true;
        }
      }
      pointers.current.set(e.pointerId, rel(e));
      gestures.touches = pointers.current.size;
      if (pointers.current.size >= 2) {
        // A second finger always scrolls and zooms, and cancels a finger stroke or a drag in progress.
        if (!gestures.navigating) gestures.cancelStrokes();
        if (gestures.dragging || controlFingers.size) gestures.cancelDrags();
        gestures.navigating = true;
        if (pointers.current.size === 2) beginPinch();
        else endPinch();
      } else if (onControl) {
        // One finger on a control: the control handles it.
      } else if (fingersNavigate() || navigateMouse) {
        gestures.navigating = true;
      }
      resetTrack();
      velocity.current = { x: 0, y: 0 };
    };

    const flushScroll = () => {
      scrollFrame.current = null;
      let dx = -pending.current.x, dy = -pending.current.y;
      pending.current = { x: 0, y: 0 };
      if (cb.current.onPullCommit && pointers.current.size > 0 && !pinch.current?.engaged) {
        // Past the end: the movement becomes pull; moving back takes the pull back first.
        if (pullRaw.current > 0 && dy < 0) {
          const back = Math.min(pullRaw.current, -dy);
          pullRaw.current -= back;
          dy += back;
          reportPull();
        }
        const maxTop = el.scrollHeight - el.clientHeight;
        if (dy > 0 && el.scrollTop + dy > maxTop - 0.5) {
          const extra = el.scrollTop + dy - Math.max(el.scrollTop, maxTop);
          dy -= extra;
          pullRaw.current += extra;
          reportPull();
        }
      }
      if (dy) el.scrollTop += dy;
      if (dx) el.scrollLeft += dx;
    };

    const onMove = (e: PointerEvent) => {
      if (!pointers.current.has(e.pointerId)) return;
      const p = rel(e);
      pointers.current.set(e.pointerId, p);
      const t = tap.current;
      if (t && !t.moved) {
        const o = t.origins.get(e.pointerId);
        if (o && Math.hypot(p.x - o.x, p.y - o.y) > TAP_SLOP) t.moved = true;
      }
      if (!gestures.navigating || !last.current) return;
      if (nativeSingle()) {
        resetTrack();
        return;
      }
      jsScrolled = true;
      if (gestures.dragging) {
        // A finger is moving a selection: keep the page still.
        resetTrack();
        return;
      }
      const c = centroid();
      const now = performance.now();
      const pz = pinch.current;
      const outer = outerRef.current;
      if (pz && pointers.current.size === 2 && outer) {
        const s = spread() / pz.d0;
        if (!pz.engaged && Math.abs(s - 1) > PINCH_START) {
          // The pinch starts here, about the point between the fingers.
          pz.engaged = true;
          pz.d0 = spread();
          pz.o = { x: el.scrollLeft + c.x - outer.offsetLeft, y: el.scrollTop + c.y - outer.offsetTop };
          releasePull();
          outer.style.transition = '';
        }
        if (pz.engaged) {
          const fitW = el.clientWidth / contentWidthRef.current;
          const z = Math.max(Math.min(MIN_ZOOM, fitW), Math.min(MAX_ZOOM, pz.z0 * (spread() / pz.d0)));
          pz.k = z / pz.z0;
          outer.style.transformOrigin = `${pz.o.x}px ${pz.o.y}px`;
          outer.style.transform = `scale(${pz.k})`;
          if (pinchInkRef.current) {
            overlay.current ??= new PinchInk(el, outer, () => pinchInkRef.current?.() ?? null);
            overlay.current.show(pz.k, pz.o, pz.z0);
          }
        }
      }
      pending.current.x += c.x - last.current.x;
      pending.current.y += c.y - last.current.y;
      if (scrollFrame.current === null) scrollFrame.current = requestAnimationFrame(flushScroll);
      last.current = { x: c.x, y: c.y, t: now };
      const h = history.current;
      h.push(last.current);
      while (h.length > 2 && now - h[0].t > 80) h.shift();
    };

    const onUp = (e: PointerEvent) => {
      controlFingers.delete(e.pointerId);
      if (!pointers.current.delete(e.pointerId)) return;
      gestures.touches = pointers.current.size;
      if (pointers.current.size < 2) endPinch();
      if (pointers.current.size > 0) {
        // A finger lifted: continue from the remaining ones without a jump.
        resetTrack();
        return;
      }
      if (scrollFrame.current !== null) {
        cancelAnimationFrame(scrollFrame.current);
        flushScroll();
      }
      const pulled = pullRaw.current > 0;
      releasePull();
      // Release velocity over the last ~80 ms (one noisy event cannot fling or stop the page).
      const h = history.current;
      const first = h[0], lastH = h[h.length - 1];
      const dt = first && lastH ? lastH.t - first.t : 0;
      velocity.current = dt > 8 ? { x: (lastH.x - first.x) / dt, y: (lastH.y - first.y) / dt } : { x: 0, y: 0 };
      history.current = [];
      const t = tap.current;
      tap.current = null;
      const wasNavigating = gestures.navigating;
      gestures.navigating = false;
      const recent = last.current && performance.now() - last.current.t < 80;
      last.current = null;
      if (t && !t.moved && t.fingers >= 2 && performance.now() - t.start < TAP_MAX_MS) {
        cb.current.onFingerTap?.(t.fingers);
        return;
      }
      if (wasNavigating && recent && !pulled && jsScrolled && e.type !== 'pointercancel') startMomentum();
    };

    // Wheel: ctrl + wheel (and trackpad pinch, which arrives as ctrl + wheel) zooms about the
    // pointer; scrolling down past the end pulls a new page.
    let wheelPullTimer: ReturnType<typeof setTimeout> | null = null;
    const onWheel = (ev: WheelEvent) => {
      if (ev.ctrlKey || ev.metaKey) {
        ev.preventDefault();
        const p = rel(ev);
        const a = anchorAt(p.x, p.y);
        const unit = ev.deltaMode === 1 ? 16 : 1;
        setFitMode(null);
        setView(zoomRef.current * Math.exp(-ev.deltaY * unit * 0.0025), a);
        return;
      }
      if (!cb.current.onPullCommit || ev.deltaY <= 0) return;
      const maxTop = el.scrollHeight - el.clientHeight;
      if (el.scrollTop < maxTop - 0.5) return;
      pullRaw.current += Math.min(60, ev.deltaY * (ev.deltaMode === 1 ? 16 : 1)) * 0.6;
      reportPull();
      if (wheelPullTimer) clearTimeout(wheelPullTimer);
      wheelPullTimer = setTimeout(releasePull, 260);
    };
    // Safari's own pinch gestures would scale the whole UI.
    const noZoom = (ev: Event) => ev.preventDefault();

    // Which touches may scroll natively (see the top of this file): decided when each touch starts.
    let touchPullY: number | null = null;
    const onTouchStart = (ev: TouchEvent) => {
      const stylus = [...ev.changedTouches].some((t) => (t as Touch & { touchType?: string }).touchType === 'stylus') || performance.now() - penDownAt < 120;
      if (stylus) {
        if (!penScrollsRef.current?.()) ev.preventDefault();
        return;
      }
      if (gestures.inking && gestures.inkingWith === 'pen') ev.preventDefault();
      else if (ev.touches.length >= 2) ev.preventDefault();
      touchPullY = ev.touches.length === 1 ? ev.touches[0].clientY : null;
    };
    // One finger past the end of the note (native scrolling stops there): the pull that adds a page.
    const onTouchMove = (ev: TouchEvent) => {
      if (!cb.current.onPullCommit || ev.touches.length !== 1 || touchPullY === null || pointers.current.size > 1 || gestures.inking) return;
      const y = ev.touches[0].clientY;
      const dy = touchPullY - y;
      touchPullY = y;
      const maxTop = el.scrollHeight - el.clientHeight;
      if (pullRaw.current > 0 && dy < 0) {
        pullRaw.current = Math.max(0, pullRaw.current + dy);
        reportPull();
      } else if (dy > 0 && el.scrollTop >= maxTop - 1) {
        pullRaw.current += dy;
        reportPull();
      }
    };
    const onTouchEnd = (ev: TouchEvent) => {
      if (ev.touches.length) return;
      touchPullY = null;
      if (pullRaw.current > 0) releasePull();
    };
    el.addEventListener('touchstart', onTouchStart, { passive: false, capture: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onTouchEnd, { passive: true });
    el.addEventListener('pointerdown', onDown, { capture: true });
    window.addEventListener('pointermove', onMove, { capture: true });
    window.addEventListener('pointerup', onUp, { capture: true });
    window.addEventListener('pointercancel', onUp, { capture: true });
    el.addEventListener('wheel', onWheel, { passive: false });
    document.addEventListener('gesturestart', noZoom, { passive: false } as AddEventListenerOptions);
    return () => {
      el.removeEventListener('touchstart', onTouchStart, { capture: true });
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
      el.removeEventListener('pointerdown', onDown, { capture: true });
      window.removeEventListener('pointermove', onMove, { capture: true });
      window.removeEventListener('pointerup', onUp, { capture: true });
      window.removeEventListener('pointercancel', onUp, { capture: true });
      el.removeEventListener('wheel', onWheel);
      document.removeEventListener('gesturestart', noZoom);
      if (wheelPullTimer) clearTimeout(wheelPullTimer);
      stopMomentum();
      if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
      overlay.current?.remove();
      overlay.current = null;
    };
  }, [fingersNavigate, gestures, setView]); // eslint-disable-line react-hooks/exhaustive-deps

  return { scrollRef, outerRef, zoom, fitMode, fitWidth, zoomToRect, zoomBy };
}
