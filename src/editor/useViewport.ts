import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { GestureBus } from './gestures';
import { setTilesPaused, tileWork } from './tileWork';
import { crashLog, powerState } from '../services/crashLog';
import { nativePinch } from './nativePinch';
import { frameRate } from '../services/frameRate';

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
   * What "fit to width" fits: the page on screen (its left edge and width in the unzoomed content).
   * Without it, the whole content (the widest page and the padding around it).
   */
  fitTarget?: () => { left: number; width: number } | null;
}

export type FitMode = 'width' | 'page' | null;

/** Screen px left between a page fitted to the width and each edge of the screen. */
const FIT_MARGIN = 2;
/** A pinch ending within this fraction of the page's fit-to-width zoom snaps to it (and follows the pages again). */
const FIT_SNAP = 0.08;

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
/**
 * A pinch that has scaled the page this much since the zoom it is drawn at commits that zoom while
 * the fingers are still down, and goes on from there: pictures, LaTeX, text and paper are drawn
 * again at the new scale (stretched from the pinch's start, a pinch from 30% to 300% showed them
 * blurred). At most every REBASE_MIN_MS.
 */
const REBASE_RATIO = 1.5;
const REBASE_MIN_MS = 250;

/**
 * Which draws a pinch on iOS: the page (its own transform: the real note all round, zooming out
 * too), or in Low Power Mode, where WebKit draws the page at 30 fps, the shell's snapshot
 * (nativePinch.ts: fluid, but only what was on screen, scaled). A rule, not a measurement: one slow
 * pinch (the first after a start) must not hand every later one to the snapshot.
 */
const shellDrawsPinch = () => !!window.OpenNoteNative?.lowPower;
export const PULL_THRESHOLD = 110;
/** Pull distance per px of finger travel past the end (rubber band). */
const PULL_RESISTANCE = 0.5;

export function useViewport({ contentWidth, fingersNavigate: fingersNavigateProp, gestures, onFingerTap, onPull, onPullCommit, penScrolls, fitTarget }: Options) {
  // Read through a ref: a new function on every render re-ran the gesture effect, whose clean-up
  // ended a pinch in progress (a render during the pinch, such as its zoom being committed on the
  // way, switched the GPU ink off).
  const fingersNavigateRef = useRef(fingersNavigateProp);
  fingersNavigateRef.current = fingersNavigateProp;
  const fitTargetRef = useRef(fitTarget);
  fitTargetRef.current = fitTarget;
  const penScrollsRef = useRef(penScrolls);
  penScrollsRef.current = penScrolls;
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
  /** o: the content point first between the fingers (outer px); c0 / c: the fingers' centre then / now (scroll view px). */
  /** native: the shell's pinch (nativePinch.ts) while it shows this one. */
  const pinch = useRef<{ d0: number; z0: number; o: { x: number; y: number }; c0: { x: number; y: number }; c: { x: number; y: number }; engaged: boolean; k: number; native: number | null; rebasedAt: number } | null>(null);
  /** Finger travel past the end of the note. */
  const pullRaw = useRef(0);
  const cb = useRef({ onFingerTap, onPull, onPullCommit });
  cb.current = { onFingerTap, onPull, onPullCommit };

  const setFitMode = (m: FitMode) => {
    fitModeRef.current = m;
    setFitModeState(m);
  };

  /**
   * Where the content's corner is on screen, relative to the scroll box, exactly (offsetLeft is
   * rounded to whole pixels: the content landed up to a pixel off after every zoom).
   */
  const contentCorner = (el: HTMLElement, outer: HTMLElement) => {
    const r = outer.getBoundingClientRect(), e = el.getBoundingClientRect();
    return { x: r.left - e.left - el.clientLeft, y: r.top - e.top - el.clientTop };
  };

  /** Content point under the screen point (sx, sy), relative to the scroll box. */
  const anchorAt = (sx: number, sy: number): Anchor | null => {
    const el = scrollRef.current, outer = outerRef.current;
    if (!el || !outer) return null;
    const z = zoomRef.current, o = contentCorner(el, outer);
    return { cx: (sx - o.x) / z, cy: (sy - o.y) / z, sx, sy };
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
    outer.style.translate = '';
    let o = contentCorner(el, outer);
    el.scrollLeft += a.cx * z + o.x - a.sx;
    el.scrollTop += a.cy * z + o.y - a.sy;
    // The browser rounds scroll positions: the rest of the way by a sub-pixel translation, so the
    // point under the fingers stays exactly where it was (the ink seemed to move slightly). Only
    // the rounding: where the scroll range stops the content short (zoomed out to the page's
    // width), it stays where scrolling can reach it.
    o = contentCorner(el, outer);
    const sub = (d: number) => (Math.abs(d) < 1 ? Math.round(d * 100) / 100 : 0);
    const dx = sub(a.sx - (a.cx * z + o.x)), dy = sub(a.sy - (a.cy * z + o.y));
    if (dx || dy) outer.style.translate = `${dx}px ${dy}px`;
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

  /**
   * Fits the width of the page on screen (fitTarget), FIT_MARGIN screen px from either edge, keeping
   * the content at the top of the screen in place. v2.0.10 and earlier fitted the widest page plus
   * the padding around the surface: wide margins, and too small for narrower pages in a note that
   * mixes sizes or orientations.
   */
  const fitWidthZoom = (el: HTMLElement, t: { width: number }) => Math.max(0.05, (el.clientWidth - 2 * FIT_MARGIN) / Math.max(1, t.width));
  const fitWidth = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !el.clientWidth) return;
    setFitMode('width');
    const t = fitTargetRef.current?.() ?? { left: 0, width: contentWidthRef.current };
    const z = fitWidthZoom(el, t);
    const a = anchorAt(0, 0);
    // The page's left edge goes FIT_MARGIN from the screen's.
    setView(z, a && { ...a, cx: t.left - FIT_MARGIN / z, sx: 0 });
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
    /**
     * The scroll view's place on screen, measured when a gesture starts (it does not move during
     * one): reading it at every pointer event, right after the pinch wrote a new transform, made
     * the browser recompute style and layout several times a frame.
     */
    let gestureRect: DOMRect | null = null;
    const rel = (e: { clientX: number; clientY: number }) => {
      const r = gestureRect ?? el.getBoundingClientRect();
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
      pinch.current = d > 0 ? { d0: d, z0: zoomRef.current, o: { x: 0, y: 0 }, c0: { x: 0, y: 0 }, c: { x: 0, y: 0 }, engaged: false, k: 1, native: null, rebasedAt: 0 } : null;
    };

    /**
     * The pinch on screen, once per frame: the content scaled about the point first between the
     * fingers and moved with them, as one transform (the rendered page is scaled while the
     * fingers move and drawn again once they lift). Panning by scrolling as well
     * fired every scroll listener and a layout on every frame of the pinch.
     */
    let pinchFrame: number | null = null;
    /** The scroll view's background (the desk), as r,g,b, for the shell's snapshot to sit on. */
    const deskColor = (): [number, number, number] | undefined => {
      for (let e: HTMLElement | null = el; e; e = e.parentElement) {
        const m = getComputedStyle(e).backgroundColor.match(/[\d.]+/g);
        if (m && (m.length < 4 || Number(m[3]) > 0)) return [Number(m[0]), Number(m[1]), Number(m[2])];
      }
      return undefined;
    };
    /** The pinch's scale and centre from the fingers now (on every finger event: the shell's snapshot follows each). */
    const trackPinch = (pz: NonNullable<typeof pinch.current>) => {
      const fitW = el.clientWidth / contentWidthRef.current;
      const z = Math.max(Math.min(MIN_ZOOM, fitW), Math.min(MAX_ZOOM, pz.z0 * (spread() / pz.d0)));
      pz.k = z / pz.z0;
      pz.c = centroid();
      if (pz.native !== null) nativePinch.move(pz.native, pz.k, pz.c);
    };
    /** Commits the pinch's zoom while the fingers are down and goes on from it (REBASE_RATIO). */
    const rebase = (pz: NonNullable<typeof pinch.current>, now: number) => {
      const outer = outerRef.current;
      if (!outer) return;
      if (pinchFrame !== null) cancelAnimationFrame(pinchFrame);
      pinchFrame = null;
      const a = { cx: pz.o.x / pz.z0, cy: pz.o.y / pz.z0, sx: pz.c.x, sy: pz.c.y };
      // Drawn now (the anchor is applied with the new zoom, in the same commit).
      flushSync(() => setView(pz.z0 * pz.k, a));
      const corner = contentCorner(el, outer);
      pz.z0 = zoomRef.current;
      pz.d0 = spread();
      pz.k = 1;
      pz.c0 = pz.c;
      pz.o = { x: pz.c.x - corner.x, y: pz.c.y - corner.y };
      pz.rebasedAt = now;
      outer.style.transformOrigin = `${pz.o.x}px ${pz.o.y}px`;
      if (pinchTimes) pinchTimes.rebases++;
      for (const fn of tileWork.moved) fn();
    };
    const applyPinch = () => {
      pinchFrame = null;
      const pz = pinch.current, outer = outerRef.current;
      if (!pz || !pz.engaged || !outer || pointers.current.size !== 2 || pz.native !== null) return;
      outer.style.transform = `translate(${pz.c.x - pz.c0.x}px, ${pz.c.y - pz.c0.y}px) scale(${pz.k})`;
      for (const fn of tileWork.moved) fn();
    };

    /**
     * The pinch's timing, for the crash report (Settings > Diagnostics): every frame while the
     * fingers zoom, the finger events, and how long the new zoom took to draw once they lifted.
     */
    let pinchTimes: { frames: number[]; events: number; loop: number | null; rebases: number } | null = null;
    const timePinch = () => {
      const pt: NonNullable<typeof pinchTimes> = (pinchTimes = { frames: [performance.now()], events: 0, loop: null, rebases: 0 });
      const tick = (t: number) => {
        pt.frames.push(t);
        pt.loop = requestAnimationFrame(tick);
      };
      pt.loop = requestAnimationFrame(tick);
    };
    const logPinch = (z0: number, z: number, native: boolean) => {
      const pt = pinchTimes;
      pinchTimes = null;
      if (!pt) return;
      if (pt.loop !== null) cancelAnimationFrame(pt.loop);
      const f = pt.frames, gaps = f.slice(1).map((t, i) => t - f[i]).sort((a, b) => a - b);
      const lifted = performance.now();
      // The second frame after the new zoom is set: React's commit and the browser's drawing done.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        crashLog.event('pinch', {
          ms: Math.round(lifted - f[0]),
          frames: gaps.length,
          events: pt.events,
          p50: Math.round(gaps[gaps.length >> 1] ?? 0),
          p95: Math.round(gaps[Math.floor(gaps.length * 0.95)] ?? 0),
          max: Math.round(gaps[gaps.length - 1] ?? 0),
          slow: gaps.filter((g) => g > frameRate.frameMs * 1.5).length,
          rebases: pt.rebases,
          hz: Math.round(frameRate.hz),
          gl: tileWork.gl,
          ...(tileWork.gl === 'gpu' ? { glStartMs: tileWork.glStartMs } : {}),
          redrawMs: Math.round(performance.now() - lifted),
          z0: Math.round(z0 * 100) / 100,
          z: Math.round(z * 100) / 100,
          native,
          ...powerState(),
        });
      }));
    };

    /** Applies the pinch's zoom (fingers lifted or down to one). */
    const endPinch = () => {
      const p = pinch.current;
      pinch.current = null;
      if (pinchFrame !== null) cancelAnimationFrame(pinchFrame);
      pinchFrame = null;
      setTilesPaused(false);
      // The fingers lifted: the content is drawn at its new scale again (see onMove).
      if (outerRef.current) outerRef.current.style.willChange = '';
      const outer = outerRef.current;
      if (p?.native != null && !(p.engaged && outer)) nativePinch.end(p.native);
      if (!p || !p.engaged || !outer) return;
      // No momentum after a pinch (the fingers' last movement was zooming, not a fling).
      jsScrolled = false;
      const z = p.z0 * p.k;
      // The content point first between the fingers goes where the fingers are now.
      const a = { cx: p.o.x / p.z0, cy: p.o.y / p.z0, sx: p.c.x, sy: p.c.y };
      const t = fitTargetRef.current?.();
      const zf = t ? fitWidthZoom(el, t) : 0;
      if (t && Math.abs(z / zf - 1) < FIT_SNAP) {
        // Close to the page's width: fitted exactly, edge to edge, as the button does (the point
        // between the fingers keeps its height).
        setFitMode('width');
        setView(zf, { ...a, cx: t.left - FIT_MARGIN / zf, sx: 0 });
      } else {
        setFitMode(null);
        setView(z, a);
      }
      logPinch(p.z0, z, p.native !== null);
      // The shell's snapshot stays until the new zoom is on screen (the second frame from now). It
      // is told where the point first between the fingers really is: the scroll range can keep
      // the page from going where the fingers took it (zoomed out to the page's width), and the
      // snapshot then glides there rather than jumping.
      const id = p.native;
      if (id !== null) {
        requestAnimationFrame(() => {
          const o = outerRef.current, r = gestureRect ?? el.getBoundingClientRect();
          const b = o?.getBoundingClientRect(), z1 = zoomRef.current;
          const at = b ? { k: z1 / p.z0, x: b.left - r.left + (p.o.x / p.z0) * z1, y: b.top - r.top + (p.o.y / p.z0) * z1 } : undefined;
          requestAnimationFrame(() => nativePinch.end(id, at));
        });
      }
    };

    /** When the Pencil last came down (Chromium's touch events do not say which touches are a stylus). */
    let penDownAt = -Infinity;
    /** This gesture's movement scrolled the page here in JS (only then is there JS momentum). */
    let jsScrolled = false;
    /** The gesture started with the mouse (hand tool): the mouse drags the page here in JS. */
    let mouseDown = false;
    /** One finger (or the Pencil with the hand tool) scrolls natively: JS leaves it alone. */
    const fingersNavigate = () => fingersNavigateRef.current();
    const nativeSingle = () => pointers.current.size === 1 && fingersNavigate() && !mouseDown;

    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'pen') penDownAt = performance.now();
      if (pointers.current.size === 0) {
        jsScrolled = false;
        mouseDown = e.pointerType === 'mouse';
        gestureRect = el.getBoundingClientRect();
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
          // The pinch starts here, about the point between the fingers. Movement not scrolled yet
          // is dropped (a frame's worth at most): the page stays as it is on screen, which the
          // shell's snapshot (nativePinch.ts) shows.
          if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
          scrollFrame.current = null;
          pending.current = { x: 0, y: 0 };
          pz.engaged = true;
          pz.d0 = spread();
          pz.c0 = pz.c = c;
          // In the content's own frame (its transform origin), exactly (see contentCorner).
          const corner = contentCorner(el, outer);
          pz.o = { x: c.x - corner.x, y: c.y - corner.y };
          releasePull();
          // The shell's snapshot is the only picture while the fingers move (the page scaled
          // under it as well, at the page's own slower frame rate, showed beside it out of step).
          pz.native = shellDrawsPinch() ? nativePinch.begin(gestureRect ?? el.getBoundingClientRect(), c, deskColor()) : null;
          outer.style.transition = '';
          outer.style.transformOrigin = `${pz.o.x}px ${pz.o.y}px`;
          // Scaled as it is while the fingers move: without this the browser drew the paper,
          // text and math again at every new scale, on every frame of the pinch.
          if (pz.native === null) outer.style.willChange = 'transform';
          tileWork.shell = pz.native !== null;
          setTilesPaused(true);
          timePinch();
        }
        if (pz.engaged) {
          if (pinchTimes) pinchTimes.events++;
          trackPinch(pz);
          if (pz.native === null && Math.abs(Math.log(pz.k)) > Math.log(REBASE_RATIO) && now - pz.rebasedAt > REBASE_MIN_MS) rebase(pz, now);
          if (pinchFrame === null) pinchFrame = requestAnimationFrame(applyPinch);
          last.current = { x: c.x, y: c.y, t: now };
          return;
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
      if (pinchFrame !== null) cancelAnimationFrame(pinchFrame);
      if (pinchTimes?.loop != null) cancelAnimationFrame(pinchTimes.loop);
      if (pinch.current?.native != null) nativePinch.end(pinch.current.native);
      setTilesPaused(false);
    };
  }, [gestures, setView]); // eslint-disable-line react-hooks/exhaustive-deps

  return { scrollRef, outerRef, zoom, fitMode, fitWidth, zoomToRect, zoomBy };
}
