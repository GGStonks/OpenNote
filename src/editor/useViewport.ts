import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { GestureBus } from './gestures';

/**
 * Viewport of the note: scrolling, zoom and the pull that adds a page.
 *
 * The page canvases need `touch-action: none` (otherwise the Pencil scrolls instead of writing on
 * iPad), which also disables native finger scrolling, so navigation is done here in JS: one finger
 * scrolls when fingers do not draw, two fingers always scroll and pinch-zoom, with momentum; the
 * mouse wheel scrolls natively and ctrl + wheel (trackpad pinch) zooms.
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
}

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

export function useViewport({ contentWidth, fingersNavigate, gestures, onFingerTap, onPull, onPullCommit }: Options) {
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
      setView(z, a);
    };

    const onDown = (e: PointerEvent) => {
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
      if (wasNavigating && recent && !pulled && e.type !== 'pointercancel') startMomentum();
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

    el.addEventListener('pointerdown', onDown, { capture: true });
    window.addEventListener('pointermove', onMove, { capture: true });
    window.addEventListener('pointerup', onUp, { capture: true });
    window.addEventListener('pointercancel', onUp, { capture: true });
    el.addEventListener('wheel', onWheel, { passive: false });
    document.addEventListener('gesturestart', noZoom, { passive: false } as AddEventListenerOptions);
    return () => {
      el.removeEventListener('pointerdown', onDown, { capture: true });
      window.removeEventListener('pointermove', onMove, { capture: true });
      window.removeEventListener('pointerup', onUp, { capture: true });
      window.removeEventListener('pointercancel', onUp, { capture: true });
      el.removeEventListener('wheel', onWheel);
      document.removeEventListener('gesturestart', noZoom);
      if (wheelPullTimer) clearTimeout(wheelPullTimer);
      stopMomentum();
      if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    };
  }, [fingersNavigate, gestures, setView]); // eslint-disable-line react-hooks/exhaustive-deps

  return { scrollRef, outerRef, zoom, fitMode, fitWidth, zoomToRect, zoomBy };
}
