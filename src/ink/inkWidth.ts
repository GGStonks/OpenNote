import type { ModeledPoint } from './engine';

/**
 * Width of fountain-pen ink (the variable-width pen, with real pressure): the ink engine gives the
 * line and the pen's force; the width follows the force and the direction the nib travels.
 *
 *  - Pressure: 0.61x the nominal width barely touching to 1.55x pressed hard, calibrated on the
 *    owner's handwriting (bench/recordings: force median 0.16, p10 0.07, p90 0.50) so the median
 *    force keeps the old width (0.88x) and everyday writing its weight.
 *  - Nib (2.9.3): a fountain pen's nib lays ink down wider across its slit than along its edge, so
 *    a line's width depends on its direction: downstrokes full, the strokes joining letters (rising
 *    to the right) fine, horizontals between (NIB_RATIO between the widest and the narrowest, the
 *    edge NIB_ANGLE above the baseline, as a right hand holds a pen). Before, every direction had
 *    the same width and the ink looked like a felt tip (the owner: "rigid").
 *    The direction comes from the line's own shape, never from the samples' timing (2.9.0's speed
 *    term twitched with it), and only from the line already behind the point (the chord over DIR_PX,
 *    averaged over DIR_SIGMA back), as a nib only knows where it has been: measured on both sides,
 *    the direction near the pen changed as the line went on, and the end of the line changed width
 *    while writing (end width p99 8-12%: the serpent again).
 *  - Calm: the force is averaged along the line (a Gaussian over PRESSURE_SIGMA px) before it sets
 *    the width, so the ink swells and thins with the hand and not with each sample's noise.
 *
 * These widths are drawn as they are: strokeRenderer's smoothing moves the line's points but no
 * longer averages its widths (averaged again, the settled end of the line changed width once more
 * after it was drawn). A point's width depends on the line WIDTH_AHEAD after it (strokeRenderer's
 * SMOOTH_SETTLE covers it, so the live line's final part, and the native ink, which draws its
 * widths, is the finished stroke exactly) and WIDTH_BEHIND before it (the context a run of the line
 * needs, smoothLiveStroke). `npm run bench:look` measures range, ripple and the end while writing.
 */
export const PRESSURE_SIGMA = 2;
/** The direction at a point: the chord from the line DIR_PX before it (page px). */
const DIR_PX = 3;
/** The nib's factor averaged over the line behind each point (a half Gaussian, page px). */
const DIR_SIGMA = 2.5;
/** How far along the line (page px) after a point its width depends on. */
export const WIDTH_AHEAD = 3 * PRESSURE_SIGMA;
/** How far along the line before a point its width depends on. */
export const WIDTH_BEHIND = Math.max(3 * PRESSURE_SIGMA, DIR_PX + 3 * DIR_SIGMA);

/** The nib's widest mark over its narrowest (1: a round tip, every direction the same). */
export let NIB_RATIO = 1.9;
/** The nib's edge, in degrees above the baseline (rising to the right). */
export let NIB_ANGLE = 28;
/** For the look benches only: other nib shapes. */
export function setNib(ratio: number, angle: number) {
  NIB_RATIO = ratio;
  NIB_ANGLE = angle;
  nibNorm = 0;
}
let nibNorm = 0;

/**
 * How much of handwriting runs in each direction (bench/recordings, by length; 15° bins of the
 * screen angle from 0° (sideways) through 90° (down) to 180°, a line and its reverse alike): the
 * nib's factor is scaled so this mix keeps the ink's weight (within 1% of 2.9.2's). Joining strokes
 * rising to the right (120-180°) are a third of all writing: scaled over every direction alike, the
 * ink came out 8% lighter.
 */
const WRITING_DIRECTIONS = [0.104, 0.04, 0.042, 0.053, 0.05, 0.067, 0.085, 0.082, 0.127, 0.134, 0.105, 0.111];

/**
 * The nib's mark moving in direction (dx, dy) (screen axes, y down), as a factor of the nominal
 * width: an elliptical nib's extent across the motion, scaled so everyday writing keeps its weight.
 */
export function nibFactor(dx: number, dy: number): number {
  if (!nibNorm) {
    let s = 0;
    WRITING_DIRECTIONS.forEach((h, k) => {
      const a = ((7.5 + 15 * k) * Math.PI) / 180;
      s += h * nibExtent(Math.cos(a), Math.sin(a));
    });
    nibNorm = 1 / s;
  }
  const l = Math.hypot(dx, dy);
  return l > 1e-6 ? nibExtent(dx / l, dy / l) * nibNorm : 1;
}

function nibExtent(ux: number, uy: number): number {
  const a = (NIB_ANGLE * Math.PI) / 180;
  // The edge's direction on screen (rising to the right: y up is negative).
  const ex = Math.cos(a), ey = -Math.sin(a);
  const along = ux * ex + uy * ey; // cos of the angle between motion and edge
  const across = ux * -ey + uy * ex; // sin of it
  // An ellipse NIB_RATIO across the edge and 1 along it: moving along the edge leaves the narrowest
  // mark, moving across it the widest.
  return Math.sqrt(across * across * NIB_RATIO * NIB_RATIO + along * along);
}

/** Pressure part of the width: a factor of the nominal width for a normalised force 0..1. */
export function pressureFactor(pressure: number): number {
  const p = Math.max(0, Math.min(1, Number.isFinite(pressure) ? pressure : 0.5));
  return 0.61 + 0.94 * Math.pow(p, 0.68);
}

/** Widths of fountain-pen ink along a modelled line of nominal width `base`. */
export function inkWidths(pts: readonly ModeledPoint[], base: number): number[] {
  const n = pts.length;
  const at = new Float64Array(n);
  for (let i = 1; i < n; i++) at[i] = at[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  // The nib's factor at each point, from the direction the line came from (the chord over DIR_PX;
  // within DIR_PX of the start, the chord from the start).
  const raw = new Float64Array(n);
  let a = 0;
  for (let i = 0; i < n; i++) {
    if (at[i] >= DIR_PX) {
      while (at[i] - at[a + 1] >= DIR_PX) a++;
      raw[i] = nibFactor(pts[i].x - pts[a].x, pts[i].y - pts[a].y);
    } else {
      // Too short a line for a direction (a dot): the mean.
      raw[i] = at[i] > 0.3 ? nibFactor(pts[i].x - pts[0].x, pts[i].y - pts[0].y) : 1;
    }
  }
  const dinv = 1 / (2 * DIR_SIGMA * DIR_SIGMA), pinv = 1 / (2 * PRESSURE_SIGMA * PRESSURE_SIGMA);
  const out: number[] = new Array(n);
  let d0 = 0, p0 = 0, p1 = 0;
  for (let i = 0; i < n; i++) {
    // The nib's factor averaged over the line behind: it never changes once the pen has gone on.
    while (at[i] - at[d0] > 3 * DIR_SIGMA) d0++;
    let sd = 0, wd = 0;
    for (let j = d0; j <= i; j++) {
      const d = at[i] - at[j];
      const w = Math.exp(-d * d * dinv);
      sd += raw[j] * w;
      wd += w;
    }
    // The force: every point within 3 sigma either side (fewer at the ends of the line, never none).
    while (at[i] - at[p0] > WIDTH_AHEAD) p0++;
    if (p1 < i) p1 = i;
    while (p1 + 1 < n && at[p1 + 1] - at[i] <= WIDTH_AHEAD) p1++;
    let sp = 0, wp = 0;
    for (let j = p0; j <= p1; j++) {
      const d = at[j] - at[i];
      const w = Math.exp(-d * d * pinv);
      sp += pts[j].p * w;
      wp += w;
    }
    out[i] = base * pressureFactor(sp / wp) * (sd / wd);
  }
  return out;
}
