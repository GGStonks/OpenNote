import type { ModeledPoint } from './engine';

/**
 * Width of fountain-pen ink (the variable-width pen, with real pressure): the ink engine gives the
 * line and the pen's force, and the width follows the force through PRESSURE_SIGMA of line.
 *
 *  - Range: 0.61x the nominal width barely touching to 1.55x pressed hard, calibrated on the
 *    owner's handwriting (bench/recordings: force median 0.16, p10 0.07, p90 0.50) so the median
 *    force keeps the old width (0.88x) and everyday writing its weight.
 *  - Calm: the force is averaged along the line (a Gaussian over PRESSURE_SIGMA px) before it sets
 *    the width, so the ink swells and thins with the hand's pressure and does not twitch with each
 *    sample's noise. 2.9.0 also narrowed fast strokes (speed from a few px of line): the Pencil's
 *    sample timing made that flicker (width roughness 1.8x 2.8.2's) and the end of the line near
 *    the pen kept changing width as it settled, which showed as a wriggling "serpent". Gone.
 *
 * A point's width depends on the line within WIDTH_REACH of it; strokeRenderer adds that to its
 * SMOOTH_SETTLE, so the live line's final part (and the native ink, which draws its widths) is the
 * finished stroke exactly. `npm run bench:look` measures range, roughness and the moving end.
 */
export const PRESSURE_SIGMA = 2;
/** How far along the line (page px) a point's width depends on. */
export const WIDTH_REACH = 3 * PRESSURE_SIGMA;

/** Pressure part of the width: a factor of the nominal width for a normalised force 0..1. */
export function pressureFactor(pressure: number): number {
  const p = Math.max(0, Math.min(1, pressure || 0.5));
  return 0.61 + 0.94 * Math.pow(p, 0.68);
}

/** Widths of fountain-pen ink along a modelled line of nominal width `base`. */
export function inkWidths(pts: readonly ModeledPoint[], base: number): number[] {
  const n = pts.length;
  const at = new Float64Array(n);
  for (let i = 1; i < n; i++) at[i] = at[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  const inv = 1 / (2 * PRESSURE_SIGMA * PRESSURE_SIGMA);
  const out: number[] = new Array(n);
  let a = 0, b = 0;
  for (let i = 0; i < n; i++) {
    // Every point within WIDTH_REACH either side (fewer at the ends of the line, never none).
    while (at[i] - at[a] > WIDTH_REACH) a++;
    if (b < i) b = i;
    while (b + 1 < n && at[b + 1] - at[i] <= WIDTH_REACH) b++;
    let sp = 0, sw = 0;
    for (let j = a; j <= b; j++) {
      const d = at[j] - at[i];
      const w = Math.exp(-d * d * inv);
      sp += pts[j].p * w;
      sw += w;
    }
    out[i] = base * pressureFactor(sp / sw);
  }
  return out;
}
