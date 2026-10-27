import React, { useLayoutEffect, useRef } from 'react';

/**
 * Floating panels (menus, popovers, pop-ups) kept on the screen, on every device.
 *
 * Each panel is placed by its own CSS (under its button, above the + button…), which suits a
 * tablet; on a phone, or by a button near an edge, it ended partly off the screen (the + button's
 * menu below the bottom edge, the pen popover past the right edge). After layout the panel is
 * measured against the visible screen less the safe area and a margin: moved in by a CSS
 * `translate` (added to its own transform), and narrowed or shortened (scrolling) when it does not
 * fit at all. Again whenever it or the screen changes size (rotation, keyboard, content).
 */

/** Distance kept from the screen's edges (CSS px). */
export const SCREEN_MARGIN = 8;
/** A panel is shortened to the room by its button down to this height (CSS px); with less, it is moved. */
const MIN_ROOM = 160;

let safeProbe: HTMLDivElement | null = null;

/** The safe area's insets (notch, home indicator; CSS px). */
function safeInsets(): { top: number; right: number; bottom: number; left: number } {
  if (!safeProbe) {
    safeProbe = document.createElement('div');
    safeProbe.style.cssText =
      'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
      'padding:var(--sa-top) var(--sa-right) var(--sa-bottom) var(--sa-left)';
    document.body.appendChild(safeProbe);
  }
  const s = getComputedStyle(safeProbe);
  return { top: parseFloat(s.paddingTop) || 0, right: parseFloat(s.paddingRight) || 0, bottom: parseFloat(s.paddingBottom) || 0, left: parseFloat(s.paddingLeft) || 0 };
}

/** Moves (and if need be shrinks) the element so that it is entirely on the screen. */
export function fitOnScreen(el: HTMLElement): void {
  el.style.translate = '';
  el.style.maxWidth = '';
  el.style.maxHeight = '';
  const vv = window.visualViewport;
  const W = vv ? vv.width : window.innerWidth, H = vv ? vv.height : window.innerHeight;
  const ox = vv ? vv.offsetLeft : 0, oy = vv ? vv.offsetTop : 0;
  const safe = safeInsets();
  const x0 = ox + safe.left + SCREEN_MARGIN, x1 = ox + W - safe.right - SCREEN_MARGIN;
  const y0 = oy + safe.top + SCREEN_MARGIN, y1 = oy + H - safe.bottom - SCREEN_MARGIN;
  let r = el.getBoundingClientRect();
  if (!r.width && !r.height) return;
  // Screen px per CSS px of the element (inside the zoomed page they differ).
  const k = el.offsetHeight > 0 ? r.height / el.offsetHeight : 1;
  const maxHeight = (px: number) => {
    el.style.maxHeight = `${Math.max(0, px / k)}px`;
    if (getComputedStyle(el).overflowY === 'visible') el.style.overflowY = 'auto';
    r = el.getBoundingClientRect();
  };
  if (r.width > x1 - x0) {
    el.style.maxWidth = `${Math.max(0, (x1 - x0) / k)}px`;
    r = el.getBoundingClientRect();
  }
  // Too tall for the room on its side of its button: shorter (the rest scrolls), staying by the
  // button. Moved up over it instead, the pen's popover on a phone held sideways covered the very
  // button that closes it. Moved only when the room left is too small to be of use.
  const room = r.bottom > y1 ? y1 - Math.max(r.top, y0) : r.top < y0 ? Math.min(r.bottom, y1) - y0 : r.height;
  if (room < r.height && room >= Math.min(r.height, MIN_ROOM)) maxHeight(room);
  else if (r.height > y1 - y0) maxHeight(y1 - y0);
  let dx = 0, dy = 0;
  if (r.right > x1) dx = x1 - r.right;
  if (r.left + dx < x0) dx = x0 - r.left;
  if (r.bottom > y1) dy = y1 - r.bottom;
  if (r.top + dy < y0) dy = y0 - r.top;
  if (!dx && !dy) return;
  el.style.translate = `${dx}px ${dy}px`;
  // Inside a scaled ancestor (the zoomed page) a CSS px of translate is not a screen px: what it
  // moved, measured, gives the ratio.
  const moved = el.getBoundingClientRect();
  const kx = dx ? (moved.left - r.left) / dx : 1, ky = dy ? (moved.top - r.top) / dy : 1;
  if (Math.abs(kx - 1) > 0.01 || Math.abs(ky - 1) > 0.01) {
    el.style.translate = `${kx > 0 ? dx / kx : dx}px ${ky > 0 ? dy / ky : dy}px`;
  }
}

/** Keeps the element of `ref` on the screen while it is shown (see fitOnScreen). */
export function useOnScreen(ref: React.RefObject<HTMLElement | null>, active = true): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    fitOnScreen(el);
    let frame: number | null = null;
    const later = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = null;
        if (el.isConnected) fitOnScreen(el);
      });
    };
    // Its own size (content, fonts) and the screen's (rotation, keyboard, split screen).
    const ro = new ResizeObserver(later);
    ro.observe(el);
    window.addEventListener('resize', later);
    window.visualViewport?.addEventListener('resize', later);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      ro.disconnect();
      window.removeEventListener('resize', later);
      window.visualViewport?.removeEventListener('resize', later);
    };
  }, [ref, active]);
}

/** A <div> that stays on the screen: for menus and popovers (all props go to the div). */
export const OnScreen = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function OnScreen(props, outer) {
  const ref = useRef<HTMLDivElement | null>(null);
  useOnScreen(ref);
  return (
    <div
      data-on-screen
      {...props}
      ref={(el) => {
        ref.current = el;
        if (typeof outer === 'function') outer(el);
        else if (outer) outer.current = el;
      }}
    />
  );
});
