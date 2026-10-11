import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { GestureBus } from './gestures';

/**
 * Scroll + zoom viewport with touch navigation implemented in JS.
 *
 * The page canvases need `touch-action: none` (otherwise the Pencil scrolls instead of writing on
 * iPad), which also disables native finger scrolling. v1.0 therefore could not be scrolled or
 * zoomed with fingers in stylus-only mode. Here: one finger pans when fingers do not draw, two
 * fingers always pan + pinch-zoom around the midpoint, with momentum; ctrl/⌘+wheel zooms on desktop.
 */

export const MIN_ZOOM = 0.3;
export const MAX_ZOOM = 4;

interface Options {
  contentWidth: number;
  fingersNavigate: () => boolean; // true when a single finger should pan (stylus-only / hand tool)
  gestures: GestureBus;
}

export function useViewport({ contentWidth, fingersNavigate, gestures }: Options) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const outerRef = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoomState] = useState(1);
  const zoomRef = useRef(1);
  const anchor = useRef<{ cx: number; cy: number; mx: number; my: number } | null>(null);
  const fitted = useRef(false);

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; zoom: number } | null>(null);
  const lastPan = useRef<{ x: number; y: number; t: number } | null>(null);
  const velocity = useRef({ vx: 0, vy: 0 });
  const momentum = useRef<number | null>(null);

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

  useLayoutEffect(() => {
    const a = anchor.current;
    const el = scrollRef.current, outer = outerRef.current;
    if (!a || !el || !outer) return;
    anchor.current = null;
    el.scrollLeft = a.cx * zoom + outer.offsetLeft - a.mx;
    el.scrollTop = a.cy * zoom + outer.offsetTop - a.my;
  }, [zoom]);

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
      const navigateMouse = e.pointerType === 'mouse' && fingersNavigate() && e.button === 0;
      if (e.pointerType !== 'touch' && !navigateMouse) return;
      // Leave touches on UI controls (selection handles, text boxes) alone.
      const target = e.target as HTMLElement;
      if (target.closest('[data-no-pan], textarea, input, button')) return;
      stopMomentum();
      pointers.current.set(e.pointerId, rel(e));
      gestures.touches = pointers.current.size;
      if (pointers.current.size === 2) {
        gestures.navigating = true;
        gestures.cancelStrokes();
        const [a, b] = [...pointers.current.values()];
        pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: zoomRef.current };
        lastPan.current = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, t: performance.now() };
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
      if (!gestures.navigating || !lastPan.current) return;
      const pts = [...pointers.current.values()];
      const now = performance.now();
      let mx: number, my: number;
      if (pts.length >= 2 && pinch.current) {
        mx = (pts[0].x + pts[1].x) / 2;
        my = (pts[0].y + pts[1].y) / 2;
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        // Pan by midpoint movement, then zoom around the midpoint.
        el.scrollLeft -= mx - lastPan.current.x;
        el.scrollTop -= my - lastPan.current.y;
        const z = (pinch.current.zoom * dist) / Math.max(1, pinch.current.dist);
        if (Math.abs(z - zoomRef.current) > 0.002) zoomAt(z, mx, my);
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
      if (pointers.current.size < 2) pinch.current = null;
      if (pointers.current.size === 1 && gestures.navigating) {
        const p = [...pointers.current.values()][0];
        lastPan.current = { x: p.x, y: p.y, t: performance.now() };
        if (!fingersNavigate()) {
          // Second finger lifted after a pinch: keep panning with the remaining one.
        }
      }
      if (pointers.current.size === 0) {
        if (gestures.navigating && performance.now() - (lastPan.current?.t ?? 0) < 80) startMomentum();
        gestures.navigating = false;
        lastPan.current = null;
      }
    };

    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(zoomRef.current * Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
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
