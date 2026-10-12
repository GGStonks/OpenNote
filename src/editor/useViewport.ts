import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { GestureBus } from './gestures';

/**
 * Viewport of the note: the pages always fill the width of the screen and only scroll up and down.
 *
 * The page canvases need `touch-action: none` (otherwise the Pencil scrolls instead of writing on
 * iPad), which also disables native finger scrolling, so scrolling is done here in JS: one finger
 * scrolls when fingers do not draw, two fingers always scroll, with momentum; the mouse wheel
 * scrolls natively. There is deliberately no pinch-zoom and no horizontal movement: v1.2's
 * free pan/zoom let the page float around the screen. The zoom is the fit-to-width scale,
 * recomputed when the window size changes (rotation, split view).
 *
 * A quick tap of two or three fingers that barely move is reported through onFingerTap
 * (Notability: two-finger tap = undo, three-finger tap = redo).
 */

interface Options {
  contentWidth: number;
  fingersNavigate: () => boolean; // true when a single finger should scroll (stylus-only / hand tool)
  gestures: GestureBus;
  onFingerTap?: (fingers: number) => void;
}

const TAP_MAX_MS = 320;
const TAP_SLOP = 14;
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2.5;

export function useViewport({ contentWidth, fingersNavigate, gestures, onFingerTap }: Options) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const outerRef = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoomState] = useState(1);
  const zoomRef = useRef(1);
  /** Content y (unscaled) at the top of the viewport, kept when the zoom changes. */
  const anchor = useRef<number | null>(null);

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const lastY = useRef<{ y: number; t: number } | null>(null);
  const velocity = useRef(0);
  /** Recent finger positions (for the release velocity). */
  const history = useRef<{ y: number; t: number }[]>([]);
  /** Scroll distance not yet applied: scrolling is applied once per frame. */
  const pending = useRef(0);
  const scrollFrame = useRef<number | null>(null);
  const momentum = useRef<number | null>(null);
  const tap = useRef<{ start: number; fingers: number; moved: boolean; origins: Map<number, { x: number; y: number }> } | null>(null);
  const onTapRef = useRef(onFingerTap);
  onTapRef.current = onFingerTap;

  const fit = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !el.clientWidth) return;
    const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, el.clientWidth / contentWidth));
    if (Math.abs(z - zoomRef.current) < 1e-4) return;
    anchor.current = el.scrollTop / zoomRef.current;
    zoomRef.current = z;
    setZoomState(z);
  }, [contentWidth]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    fit();
    const ro = new ResizeObserver(() => fit());
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);

  // Keep the same part of the note at the top after a zoom change.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || anchor.current === null) return;
    el.scrollTop = anchor.current * zoom;
    el.scrollLeft = 0;
    anchor.current = null;
  }, [zoom]);

  const stopMomentum = () => {
    if (momentum.current !== null) cancelAnimationFrame(momentum.current);
    momentum.current = null;
  };

  const startMomentum = () => {
    const el = scrollRef.current;
    if (!el) return;
    let v = velocity.current;
    if (Math.abs(v) < 0.1) return;
    let last = performance.now();
    // UIScrollView's normal deceleration rate (0.998 per ms): long, soft glide.
    const step = (now: number) => {
      const dt = Math.min(32, now - last);
      last = now;
      const before = el.scrollTop;
      el.scrollTop -= v * dt;
      v *= Math.pow(0.998, dt);
      const stuck = el.scrollTop === before; // reached the top or the bottom
      if (Math.abs(v) > 0.01 && !stuck) momentum.current = requestAnimationFrame(step);
      else momentum.current = null;
    };
    momentum.current = requestAnimationFrame(step);
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const rel = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const centroidY = () => {
      let y = 0;
      for (const p of pointers.current.values()) y += p.y;
      return y / Math.max(1, pointers.current.size);
    };

    const onDown = (e: PointerEvent) => {
      // The mouse drags the page only where it does not draw (hand tool, gaps between pages).
      const navigateMouse = e.pointerType === 'mouse' && fingersNavigate() && e.button === 0 && !(e.target as HTMLElement).closest('[data-ink-input]');
      if (e.pointerType !== 'touch' && !navigateMouse) return;
      // Leave touches on UI controls (selection handles, text boxes) alone.
      if ((e.target as HTMLElement).closest('[data-no-pan], textarea, input, button')) return;
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
        // A second finger always scrolls, and cancels a finger stroke in progress.
        if (!gestures.navigating) gestures.cancelStrokes();
        gestures.navigating = true;
      } else if (fingersNavigate() || navigateMouse) {
        gestures.navigating = true;
      }
      lastY.current = { y: centroidY(), t: performance.now() };
      history.current = [lastY.current];
      velocity.current = 0;
    };

    const flushScroll = () => {
      scrollFrame.current = null;
      if (pending.current) el.scrollTop -= pending.current;
      pending.current = 0;
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
      if (!gestures.navigating || !lastY.current) return;
      if (gestures.dragging) {
        // A finger is moving a selection: keep the page still.
        lastY.current = { y: centroidY(), t: performance.now() };
        history.current = [lastY.current];
        return;
      }
      const y = centroidY();
      const now = performance.now();
      pending.current += y - lastY.current.y;
      if (scrollFrame.current === null) scrollFrame.current = requestAnimationFrame(flushScroll);
      lastY.current = { y, t: now };
      const h = history.current;
      h.push(lastY.current);
      while (h.length > 2 && now - h[0].t > 80) h.shift();
    };

    const onUp = (e: PointerEvent) => {
      if (!pointers.current.delete(e.pointerId)) return;
      gestures.touches = pointers.current.size;
      if (pointers.current.size > 0) {
        // A finger lifted: continue from the remaining ones without a jump.
        lastY.current = { y: centroidY(), t: performance.now() };
        history.current = [lastY.current];
        return;
      }
      if (scrollFrame.current !== null) {
        cancelAnimationFrame(scrollFrame.current);
        flushScroll();
      }
      // Release velocity over the last ~80 ms (one noisy event cannot fling or stop the page).
      const h = history.current;
      const first = h[0], lastH = h[h.length - 1];
      velocity.current = first && lastH && lastH.t - first.t > 8 ? (lastH.y - first.y) / (lastH.t - first.t) : 0;
      history.current = [];
      const t = tap.current;
      tap.current = null;
      const wasNavigating = gestures.navigating;
      gestures.navigating = false;
      const recent = lastY.current && performance.now() - lastY.current.t < 80;
      lastY.current = null;
      if (t && !t.moved && t.fingers >= 2 && performance.now() - t.start < TAP_MAX_MS) {
        onTapRef.current?.(t.fingers);
        return;
      }
      if (wasNavigating && recent && e.type !== 'pointercancel') startMomentum();
    };

    el.addEventListener('pointerdown', onDown, { capture: true });
    window.addEventListener('pointermove', onMove, { capture: true });
    window.addEventListener('pointerup', onUp, { capture: true });
    window.addEventListener('pointercancel', onUp, { capture: true });
    // Browser zoom gestures (ctrl+wheel, Safari's gesture events) would scale the whole UI.
    const noZoom = (ev: Event) => {
      if (ev.type !== 'wheel' || (ev as WheelEvent).ctrlKey) ev.preventDefault();
    };
    el.addEventListener('wheel', noZoom, { passive: false });
    document.addEventListener('gesturestart', noZoom, { passive: false } as AddEventListenerOptions);
    return () => {
      el.removeEventListener('pointerdown', onDown, { capture: true });
      window.removeEventListener('pointermove', onMove, { capture: true });
      window.removeEventListener('pointerup', onUp, { capture: true });
      window.removeEventListener('pointercancel', onUp, { capture: true });
      el.removeEventListener('wheel', noZoom);
      document.removeEventListener('gesturestart', noZoom);
      stopMomentum();
      if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    };
  }, [fingersNavigate, gestures]);

  return { scrollRef, outerRef, zoom };
}
