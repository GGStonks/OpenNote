import type { ModeledPoint } from './engine';

/**
 * Width of fountain-pen ink (the variable-width pen, with real pressure): the ink engine gives the
 * line and the pen's force; how wide the ink is there is decided here, from the two things a real
 * nib responds to. Both are calibrated on the owner's own handwriting (bench/recordings, 292
 * strokes: force median 0.16, p10 0.07, p90 0.50; speed median 0.54 px/ms, p10 0.13, p90 2.2), so
 * everyday writing keeps the weight it had and the new range is spread around it.
 *
 *  - Pressure: 0.61x the nominal width barely touching to 1.55x pressed hard (0.72x-1.30x until
 *    2.8.2, which made the line look uniform). At the median force it is the old width exactly
 *    (0.88x); the firmest tenth of writing reaches about 1.2x, the lightest about 0.76x. Not
 *    thinner than 0.61x: the old 0.4x floor made light writing thin and fragile.
 *  - Speed: a slow, deliberate line is fuller, a fast flick finer, as real ink: 1x at the median
 *    writing speed, up to +10% nearly still and -10% at speed, on a log scale (writing speeds span
 *    two orders of magnitude) through a tanh, so it eases in and never jumps.
 *
 * Speed is measured along the line, over SPEED_ARC px either side of each point (arc length over
 * time), so a point's width depends only on the line within SPEED_ARC of it. With the smoothing
 * after it (strokeRenderer.smoothLine, 3 sigma), that stays inside SMOOTH_SETTLE: the live line's
 * final part (smoothLiveStroke) gets exactly the widths the finished stroke gets, and the native
 * live ink draws those same widths (nativeInk.ts sends them). Must stay < SMOOTH_SETTLE - 3 sigma.
 * `npm run bench:look` measures the width range and that live and finished widths agree.
 */
export const SPEED_ARC = 4;
/** The median writing speed (page px per ms): the speed factor is 1 there. */
const SPEED_MEDIAN = 0.55;

/** Pressure part of the width: a factor of the nominal width for a normalised force 0..1. */
export function pressureFactor(pressure: number): number {
  const p = Math.max(0, Math.min(1, pressure || 0.5));
  return 0.61 + 0.94 * Math.pow(p, 0.68);
}

/** Speed part of the width: a factor for a speed in page px per ms. */
export function speedFactor(v: number): number {
  if (!(v > 0)) return 1.1;
  return 1 - 0.1 * Math.tanh(Math.log(v / SPEED_MEDIAN) / 1.2);
}

/** Pen speed at each point (page px per ms): arc length over time within SPEED_ARC either side. */
export function pointSpeeds(pts: readonly ModeledPoint[]): Float64Array {
  const n = pts.length;
  const at = new Float64Array(n);
  for (let i = 1; i < n; i++) at[i] = at[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  const v = new Float64Array(n);
  let a = 0, b = 0;
  for (let i = 0; i < n; i++) {
    while (at[i] - at[a] > SPEED_ARC) a++;
    if (b < i) b = i;
    while (b + 1 < n && at[b + 1] - at[i] <= SPEED_ARC) b++;
    const dt = pts[b].t - pts[a].t;
    v[i] = dt > 0 ? (at[b] - at[a]) / dt : 0;
  }
  return v;
}

/** Widths of fountain-pen ink along a modelled line of nominal width `base`. */
export function inkWidths(pts: readonly ModeledPoint[], base: number): number[] {
  const v = pointSpeeds(pts);
  return pts.map((q, i) => base * pressureFactor(q.p) * speedFactor(v[i]));
}
