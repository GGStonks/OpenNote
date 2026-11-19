/**
 * The pure part of the page's camera (useViewport.ts): constants and the arithmetic of zoom limits,
 * fit to width and its snap, the pinch's zoom, rebasing, momentum, the release velocity and the
 * pull's rubber band. useViewport.ts calls these; crates/viewport (the Rust camera the native
 * canvas uses, rust/DECISIONS.md ADR-006) is a port of them, checked against this file by
 * `npm run bench:rustref -- bench/rust-ref/viewport.json --module viewport` and
 * crates/viewport/tests/reference.rs. Change one, change the other.
 */

/** Screen px left between a page fitted to the width and each edge of the screen. */
export const FIT_MARGIN = 2;
/** A pinch ending within this fraction of the page's fit-to-width zoom snaps to it (and follows the pages again). */
export const FIT_SNAP = 0.08;
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 5;
/** The smallest zoom fitting the width may give (a page far wider than the screen). */
export const MIN_FIT_ZOOM = 0.05;
/** Two fingers start zooming once their spread has changed this much (before that they scroll). */
export const PINCH_START = 0.05;
/**
 * A pinch that has scaled the page this much since the zoom it is drawn at commits that zoom while
 * the fingers are still down, and goes on from there. At most every REBASE_MIN_MS.
 */
export const REBASE_RATIO = 1.5;
export const REBASE_MIN_MS = 250;
export const TAP_MAX_MS = 320;
export const TAP_SLOP = 14;
/** Pull distance (after PULL_RESISTANCE) that adds a page. */
export const PULL_THRESHOLD = 110;
/** Pull distance per px of finger travel past the end (rubber band). */
export const PULL_RESISTANCE = 0.5;
/** The pull goes back over this long (CSS transition, cubic-bezier(.2,.8,.2,1)). */
export const PULL_RELEASE_MS = 220;
/** Finger travel within this of the end of the scroll range already counts as pull. */
export const PULL_EDGE = 0.5;
/** UIScrollView's normal deceleration rate: the glide's speed is multiplied by this per ms. */
export const MOMENTUM_DECAY = 0.998;
/** A momentum step covers at most this long (a stalled frame does not jump the page). */
export const MOMENTUM_MAX_DT = 32;
/** A release slower than this (px/ms) does not glide. */
export const MOMENTUM_MIN_SPEED = 0.1;
/** The glide stops below this speed (px/ms). */
export const MOMENTUM_STOP_SPEED = 0.01;
/** The release velocity is measured over the fingers' last VELOCITY_WINDOW_MS... */
export const VELOCITY_WINDOW_MS = 80;
/** ...and only from movement spanning more than this (one noisy event cannot fling or stop the page). */
export const VELOCITY_MIN_DT = 8;
/** Fingers that last moved longer ago than this when they lifted do not fling. */
export const RELEASE_RECENT_MS = 80;

/** Zoom limits: below MIN_ZOOM only as far as fitting the width (or `floor`, for fitting a page) needs. */
export function clampZoom(z: number, clientWidth: number, contentWidth: number, floor = Infinity): number {
  const fitW = clientWidth / contentWidth;
  return Math.max(Math.min(MIN_ZOOM, fitW, floor), Math.min(MAX_ZOOM, z));
}

/** The zoom fitting `width` (content px) on screen, FIT_MARGIN from either edge. */
export function fitWidthZoom(clientWidth: number, width: number): number {
  return Math.max(MIN_FIT_ZOOM, (clientWidth - 2 * FIT_MARGIN) / Math.max(1, width));
}

/** The pinch's zoom from its start zoom and the fingers' spread then (d0) and now. */
export function pinchZoom(z0: number, spread: number, d0: number, clientWidth: number, contentWidth: number): number {
  const fitW = clientWidth / contentWidth;
  return Math.max(Math.min(MIN_ZOOM, fitW), Math.min(MAX_ZOOM, z0 * (spread / d0)));
}

/** A pinch ending at zoom `z` snaps to the fit-to-width zoom `zf`. */
export function snapsToFit(z: number, zf: number): boolean {
  return Math.abs(z / zf - 1) < FIT_SNAP;
}

/** The pinch has scaled by `k` since its zoom was committed `sinceMs` ago: commit it now. */
export function shouldRebase(k: number, sinceMs: number): boolean {
  return Math.abs(Math.log(k)) > Math.log(REBASE_RATIO) && sinceMs > REBASE_MIN_MS;
}

/** The rest of a placement the scroll range or its rounding left: as a translation, only under 1 px. */
export function subPixel(d: number): number {
  return Math.abs(d) < 1 ? Math.round(d * 100) / 100 : 0;
}

/** One momentum step of `dtMs`: how far the content scrolls (subtracted from the scroll) and the speed after. */
export function momentumStep(vx: number, vy: number, dtMs: number): { dx: number; dy: number; vx: number; vy: number } {
  const dt = Math.min(MOMENTUM_MAX_DT, dtMs);
  const decay = Math.pow(MOMENTUM_DECAY, dt);
  return { dx: vx * dt, dy: vy * dt, vx: vx * decay, vy: vy * decay };
}

/** The fingers' release velocity (px/ms) from their recent positions (oldest first). */
export function releaseVelocity(h: { x: number; y: number; t: number }[]): { x: number; y: number } {
  const first = h[0], lastH = h[h.length - 1];
  const dt = first && lastH ? lastH.t - first.t : 0;
  return dt > VELOCITY_MIN_DT ? { x: (lastH.x - first.x) / dt, y: (lastH.y - first.y) / dt } : { x: 0, y: 0 };
}

/** CSS cubic-bezier(x1, y1, x2, y2) at progress u (0..1), as browsers evaluate it. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number, u: number): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  const bx = (t: number) => ((1 - 3 * x2 + 3 * x1) * t + (3 * x2 - 6 * x1)) * t * t + 3 * x1 * t;
  const by = (t: number) => ((1 - 3 * y2 + 3 * y1) * t + (3 * y2 - 6 * y1)) * t * t + 3 * y1 * t;
  // Bisection on x(t) = u: x is monotonic for 0 <= x1, x2 <= 1.
  let lo = 0, hi = 1, t = u;
  for (let i = 0; i < 60; i++) {
    t = (lo + hi) / 2;
    if (bx(t) < u) lo = t;
    else hi = t;
  }
  return by((lo + hi) / 2);
}

/** How much of the pull is left `ms` after its release (1 at the release, 0 at PULL_RELEASE_MS). */
export function pullLeft(ms: number): number {
  return 1 - cubicBezier(0.2, 0.8, 0.2, 1, ms / PULL_RELEASE_MS);
}

/** The scroll view: its client size and the content's unzoomed size (Editor's contentWidth, totalHeight). */
export interface ScrollBox {
  clientWidth: number;
  clientHeight: number;
  contentWidth: number;
  contentHeight: number;
}

/** The content's left margin at zoom z (`margin: 0 auto`: centred when narrower than the screen). */
export function marginLeft(b: ScrollBox, z: number): number {
  return Math.max(0, (b.clientWidth - b.contentWidth * z) / 2);
}
export function maxScrollLeft(b: ScrollBox, z: number): number {
  return Math.max(0, b.contentWidth * z - b.clientWidth);
}
export function maxScrollTop(b: ScrollBox, z: number): number {
  return Math.max(0, b.contentHeight * z - b.clientHeight);
}

/**
 * What the browser makes of useViewport's applyAnchor: the content point (cx, cy) (unscaled px)
 * to the screen point (sx, sy) at zoom z, the scroll positions clamped to their range and the
 * rest under 1 px as a translation (subPixel). Exact positions (a browser may round them to
 * device px; applyAnchor's translation takes the rounding up).
 */
export function placeAnchor(b: ScrollBox, z: number, a: { cx: number; cy: number; sx: number; sy: number }): { scrollLeft: number; scrollTop: number; dx: number; dy: number } {
  const m = marginLeft(b, z);
  const scrollLeft = Math.min(maxScrollLeft(b, z), Math.max(0, a.cx * z + m - a.sx));
  const scrollTop = Math.min(maxScrollTop(b, z), Math.max(0, a.cy * z - a.sy));
  return { scrollLeft, scrollTop, dx: subPixel(a.sx - (a.cx * z + m - scrollLeft)), dy: subPixel(a.sy - (a.cy * z - scrollTop)) };
}

/** Index of the page at surface height y (sheets.ts sheetIndexAt, from the pages' tops). */
export function sheetIndexAtTop(tops: number[], y: number): number {
  let k = 0;
  while (k + 1 < tops.length && tops[k + 1] <= y) k++;
  return k;
}
