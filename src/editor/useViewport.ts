import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { GestureBus } from './gestures';

/**
 * Scroll + zoom viewport with touch navigation implemented in JS.
 *
 * The page canvases need `touch-action: none` (otherwise the Pencil scrolls instead of writing on
 * iPad), which also disables native finger scrolling. v1.0 therefore could not be scrolled or
 * zoomed with fingers in stylus-only mode. Here: one finger pans when fingers do not draw, two
 * fingers always pan + pinch-zoom around the midpoint, with momentum; ctrl/⌘+wheel zooms on desktop.
 *
 * During a pinch (or a burst of wheel zooming) only a CSS transform is applied to the content, which
 * the compositor animates without layout or React renders; the real zoom (layout size, canvas
 * resolution, scroll position) is committed once when the gesture ends. Committing on every
 * pointermove re-rendered every page and reallocated their canvases, which made pinching lag.
 *
 * A quick tap of two or three fingers that barely move is reported through onFingerTap
 * (Notability: two-finger tap = undo, three-finger tap = redo).
 */

export const MIN_ZOOM = 0.3;
export const MAX_ZOOM = 4;

interface Options {
  contentWidth: number;
  fingersNavigate: () => boolean; // true when a single finger should pan (stylus-only / hand tool)
  gestures: GestureBus;
  onFingerTap?: (fingers: number) => void;
}

const TAP_MAX_MS = 320;
const TAP_SLOP = 14;

export function useViewport({ contentWidth, fingersNavigate, gestures, onFingerTap }: Options) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const outerRef = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoomState] = useState(1);
  const zoomRef = useRef(1);
  const anchor = useRef<{ cx: number; cy: number; mx: number; my: number } | null>(null);
  const fitted = useRef(false);

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number } | null>(null);
  /** Visual (transform-only) zoom in progress. */
  const visual = useRef<{ z0: number; scale: number; m0: { x: number; y: number }; m: { x: number; y: number }; cx: number; cy: number } | null>(null);
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPan = useRef<{ x: number; y: number; t: number } | null>(null);
  const velocity = useRef({ vx: 0, vy: 0 });
  const momentum = useRef<number | null>(null);
  const tap = useRef<{ start: number; fingers: number; moved: boolean; origins: Map<number, { x: number; y: number }> } | null>(null);
  const onTapRef = useRef(onFingerTap);
  onTapRef.current = onFingerTap;

  const contentPoint = (mx: number, my: number) => {
    const el = scrollRef.current!, outer = outerRef.current!;
    return {
      cx: (el.scrollLeft + mx - outer.offsetLeft) / zoomRef.current,
      cy: (el.scrollTop + my - outer.offsetTop) / zoomRef.current,
    };
  };

  /** Zoom keeping the content point under (mx,my) (container-relative) fixed. */
  const zoomAt = useCallback((z: number, mx: number, my: number) => {
    const el = scrollRef.current;
    if (!el || !outerRef.current) return;
    const nz = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    const { cx, cy } = contentPoint(mx, my);
    anchor.current = { cx, cy, mx, my };
    zoomRef.current = nz;
    setZoomState(nz);
  }, []);

  const applyAnchor = useCallback(() => {
    const a = anchor.current;
    const el = scrollRef.current, outer = outerRef.current;
    if (!el || !outer) return;
    outer.style.transform = '';
    outer.style.willChange = '';
    if (!a) return;
    anchor.current = null;
    el.scrollLeft = a.cx * zoomRef.current + outer.offsetLeft - a.mx;
    el.scrollTop = a.cy * zoomRef.current + outer.offsetTop - a.my;
  }, []);

  useLayoutEffect(() => {
    applyAnchor();
  }, [zoom, applyAnchor]);

  const beginVisualZoom = (mx: number, my: number) => {
    const el = scrollRef.current, outer = outerRef.current;
    if (!el || !outer || visual.current) return;
    const { cx, cy } = contentPoint(mx, my);
    visual.current = { z0: zoomRef.current, scale: 1, m0: { x: mx, y: my }, m: { x: mx, y: my }, cx, cy };
    // Transform origin: the content point under the fingers, in the outer element's own coordinates.
    outer.style.transformOrigin = `${cx * zoomRef.current}px ${cy * zoomRef.current}px`;
    outer.style.willChange = 'transform';
  };

  const updateVisualZoom = (scale: number, mx: number, my: number) => {
    const v = visual.current, outer = outerRef.current;
    if (!v || !outer) return;
    v.scale = Math.max(MIN_ZOOM / v.z0, Math.min(MAX_ZOOM / v.z0, scale));
    v.m = { x: mx, y: my };
    outer.style.transform = `translate(${mx - v.m0.x}px, ${my - v.m0.y}px) scale(${v.scale})`;
  };

  const commitVisualZoom = () => {
    const v = visual.current;
    visual.current = null;
    if (!v) return;
    const nz = v.z0 * v.scale;
    anchor.current = { cx: v.cx, cy: v.cy, mx: v.m.x, my: v.m.y };
    zoomRef.current = nz;
    if (Math.abs(nz - zoom) < 1e-6) applyAnchor();
    else setZoomState(nz);
  };
  const commitRef = useRef(commitVisualZoom);
  commitRef.current = commitVisualZoom;

  const fitWidth = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const z = Math.max(MIN_ZOOM, Math.min(1.25, (el.clientWidth - 8) / contentWidth));
    zoomRef.current = z;
    setZoomState(z);
  }, [contentWidth]);

  useEffect(() => {
    if (!fitted.current && scrollRef.current) {
      fitted.current = true;
      fitWidth();
    }
  }, [fitWidth]);

  const stopMomentum = () => {
    if (momentum.current !== null) cancelAnimationFrame(momentum.current);
    momentum.current = null;
  };

  const startMomentum = () => {
    const el = scrollRef.current;
    if (!el) return;
    let { vx, vy } = velocity.current;
    if (Math.hypot(vx, vy) < 0.2) return;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(32, now - last);
      last = now;
      el.scrollLeft -= vx * dt;
      el.scrollTop -= vy * dt;
      const decay = Math.pow(0.995, dt);
      vx *= decay;
      vy *= decay;
      if (Math.hypot(vx, vy) > 0.02) momentum.current = requestAnimationFrame(step);
      else momentum.current = null;
    };
    momentum.current = requestAnimationFrame(step);
  };

  const rel = (e: PointerEvent) => {
    const r = scrollRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onDown = (e: PointerEvent) => {
      // The mouse pans only where it does not draw (hand tool, gaps between pages).
      const navigateMouse = e.pointerType === 'mouse' && fingersNavigate() && e.button === 0 && (e.target as HTMLElement).tagName !== 'CANVAS';
      if (e.pointerType !== 'touch' && !navigateMouse) return;
      // Leave touches on UI controls (selection handles, text boxes) alone.
      const target = e.target as HTMLElement;
      if (target.closest('[data-no-pan], textarea, input, button')) return;
      stopMomentum();
      if (e.pointerType === 'touch') {
        const now = performance.now();
        if (pointers.current.size === 0) tap.current = { start: now, fingers: 0, moved: false, origins: new Map() };
        const t = tap.current;
        if (t) {
          t.origins.set(e.pointerId, rel(e));
          t.fingers = Math.max(t.fingers, pointers.current.size + 1);
          // Fingers landing one by one over a long time are not a tap.
          if (now - t.start > TAP_MAX_MS) t.moved = true;
        }
      }
      pointers.current.set(e.pointerId, rel(e));
      gestures.touches = pointers.current.size;
      if (pointers.current.size === 2) {
        gestures.navigating = true;
        gestures.cancelStrokes();
        const [a, b] = [...pointers.current.values()];
        pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y) };
        lastPan.current = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, t: performance.now() };
        if (wheelTimer.current) {
          clearTimeout(wheelTimer.current);
          wheelTimer.current = null;
          commitRef.current();
        }
        beginVisualZoom(lastPan.current.x, lastPan.current.y);
      } else if (pointers.current.size === 1 && (fingersNavigate() || navigateMouse)) {
        gestures.navigating = true;
        const p = rel(e);
        lastPan.current = { x: p.x, y: p.y, t: performance.now() };
        velocity.current = { vx: 0, vy: 0 };
      }
    };

    const onMove = (e: PointerEvent) => {
      if (!pointers.current.has(e.pointerId)) return;
      pointers.current.set(e.pointerId, rel(e));
      const t = tap.current;
      if (t && !t.moved) {
        const o = t.origins.get(e.pointerId), p = rel(e);
        if (o && Math.hypot(p.x - o.x, p.y - o.y) > TAP_SLOP) t.moved = true;
      }
      if (!gestures.navigating || !lastPan.current) return;
      const pts = [...pointers.current.values()];
      const now = performance.now();
      let mx: number, my: number;
      if (pts.length >= 2 && pinch.current) {
        mx = (pts[0].x + pts[1].x) / 2;
        my = (pts[0].y + pts[1].y) / 2;
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        // Pan with the midpoint and scale around it, as a transform only.
        updateVisualZoom(dist / Math.max(1, pinch.current.dist), mx, my);
        lastPan.current = { x: mx, y: my, t: now };
        velocity.current = { vx: 0, vy: 0 };
        return;
      } else {
        mx = pts[0].x;
        my = pts[0].y;
        el.scrollLeft -= mx - lastPan.current.x;
        el.scrollTop -= my - lastPan.current.y;
      }
      const dt = Math.max(1, now - lastPan.current.t);
      velocity.current = { vx: (mx - lastPan.current.x) / dt, vy: (my - lastPan.current.y) / dt };
      lastPan.current = { x: mx, y: my, t: now };
    };

    const onUp = (e: PointerEvent) => {
      if (!pointers.current.delete(e.pointerId)) return;
      gestures.touches = pointers.current.size;
      if (pointers.current.size < 2 && pinch.current) {
        pinch.current = null;
        const t = tap.current, v = visual.current;
        if (t && v && !t.moved && performance.now() - t.start < TAP_MAX_MS) {
          // Probably a two-finger tap: do not commit the jitter of the fingers as a zoom change.
          v.scale = 1;
          v.m = v.m0;
        }
        commitRef.current();
        velocity.current = { vx: 0, vy: 0 };
      }
      if (pointers.current.size === 1 && gestures.navigating) {
        const p = [...pointers.current.values()][0];
        lastPan.current = { x: p.x, y: p.y, t: performance.now() };
        if (!fingersNavigate()) {
          // Second finger lifted after a pinch: keep panning with the remaining one.
        }
      }
      if (pointers.current.size === 0) {
        const t = tap.current;
        tap.current = null;
        if (t && !t.moved && t.fingers >= 2 && performance.now() - t.start < TAP_MAX_MS) {
          // A tap is not a pinch: drop the (tiny) visual zoom it started and report it.
          velocity.current = { vx: 0, vy: 0 };
          gestures.navigating = false;
          lastPan.current = null;
          onTapRef.current?.(t.fingers);
          return;
        }
        if (gestures.navigating && performance.now() - (lastPan.current?.t ?? 0) < 80) startMomentum();
        gestures.navigating = false;
        lastPan.current = null;
      }
    };

    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      if (pinch.current) return;
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      if (!visual.current) beginVisualZoom(mx, my);
      const v = visual.current!;
      // Keep the point under the cursor fixed: translate so that m0 stays where it was.
      updateVisualZoom(v.scale * Math.exp(-e.deltaY * 0.01), v.m0.x, v.m0.y);
      if (wheelTimer.current) clearTimeout(wheelTimer.current);
      wheelTimer.current = setTimeout(() => {
        wheelTimer.current = null;
        commitRef.current();
      }, 160);
    };

    el.addEventListener('pointerdown', onDown, { capture: true });
    window.addEventListener('pointermove', onMove, { capture: true });
    window.addEventListener('pointerup', onUp, { capture: true });
    window.addEventListener('pointercancel', onUp, { capture: true });
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('pointerdown', onDown, { capture: true });
      window.removeEventListener('pointermove', onMove, { capture: true });
      window.removeEventListener('pointerup', onUp, { capture: true });
      window.removeEventListener('pointercancel', onUp, { capture: true });
      el.removeEventListener('wheel', onWheel);
      if (wheelTimer.current) clearTimeout(wheelTimer.current);
      stopMomentum();
    };
  }, [fingersNavigate, gestures, zoomAt]);

  const zoomBy = useCallback(
    (factor: number) => {
      const el = scrollRef.current;
      if (!el) return;
      zoomAt(zoomRef.current * factor, el.clientWidth / 2, el.clientHeight / 2);
    },
    [zoomAt]
  );

  return { scrollRef, outerRef, zoom, zoomBy, fitWidth };
}
