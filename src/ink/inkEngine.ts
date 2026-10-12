import { Point } from '../types';
import { Bezier, bezierPoint, catmullRomBeziers, XY } from './spline';

/**
 * Handwriting engine: the smart pen's curve engine (PDEDraw) applied to every pen stroke.
 *
 *  1. Sampling: like PDEDraw's appendCurvePoint, samples closer than `INK_SAMPLING` to the last
 *     kept point are dropped and samples that only extend a straight run replace its end. This
 *     removes the jitter of raw Pencil/finger input instead of smoothing it afterwards.
 *  2. Curve: a centripetal Catmull-Rom spline through the kept points (no overshoot, no cusps),
 *     as cubic Bezier segments, so ink is exactly the same curve the TikZ/SVG exports describe.
 *  3. Width: constant for the ballpoint (and for input without pressure); for the fountain pen the
 *     pressure at each kept point sets the width, interpolated smoothly along the spline. The curve
 *     is drawn as short round-capped pieces grouped by width, which gives a smooth variable-width
 *     line without the outline artefacts of offset polygons at sharp turns.
 *
 * The raw samples stay in the note (pressure, time, tilt); this runs at render time, the same way
 * for the live stroke and the committed one, so nothing jumps when the pen lifts.
 */

/** Minimum distance between kept samples, in page units (1/96 in). */
export const INK_SAMPLING = 2.4;
/** Length of the pieces of a variable-width stroke. */
const PIECE = 1.6;
/** Widths are grouped in steps of this many units (one canvas stroke call per group). */
const WIDTH_STEP = 0.12;

const dist = (a: XY, b: XY) => Math.hypot(a.x - b.x, a.y - b.y);

function project(p: XY, a: XY, b: XY): XY {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (!l2) return a;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return { x: a.x + t * dx, y: a.y + t * dy };
}

/** PDEDraw's sample thinning (see smartPen.appendCurvePoint), keeping the last sample. */
export function inkControlPoints(points: Point[], sampling = INK_SAMPLING): Point[] {
  if (points.length <= 2) return points;
  const out: Point[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    const last = out[out.length - 1];
    const d = dist(p, last);
    if (d < sampling) continue;
    if (out.length >= 2) {
      const prev = out[out.length - 2];
      if (dist(p, project(p, prev, last)) < 0.27 * sampling && d < 2.2 * sampling) {
        out[out.length - 1] = p;
        continue;
      }
    }
    out.push(p);
  }
  const end = points[points.length - 1];
  const tail = out[out.length - 1];
  if (tail !== end) {
    if (out.length > 1 && dist(end, tail) < sampling * 0.5) out[out.length - 1] = end;
    else out.push(end);
  }
  return smoothControlPoints(out);
}

/** cos of the turn above which a kept point is a corner (about 60°) and is not smoothed. */
const CORNER_COS = 0.5;

/**
 * One 1-2-1 pass over the kept points: removes the residual tremor of hand input (the smart pen
 * hides it by sampling more sparsely, which would round small letters). Ends and sharp corners
 * (tips of v, w, z) are kept exactly.
 */
function smoothControlPoints(pts: Point[]): Point[] {
  if (pts.length < 4) return pts;
  const out = pts.slice();
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    const ux = b.x - a.x, uy = b.y - a.y, vx = c.x - b.x, vy = c.y - b.y;
    const m = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    if (m > 0 && (ux * vx + uy * vy) / m < CORNER_COS) continue;
    out[i] = { ...b, x: 0.25 * a.x + 0.5 * b.x + 0.25 * c.x, y: 0.25 * a.y + 0.5 * b.y + 0.25 * c.y };
  }
  return out;
}

export function inkBeziers(ctrl: XY[]): Bezier[] {
  return catmullRomBeziers(ctrl, false);
}

export function hasRealPressure(points: Point[]): boolean {
  for (const p of points) if (p.pressure !== 0.5 && p.pressure > 0) return true;
  return false;
}

/** Fountain pen: width for a normalised force (0.5 = the nominal width). */
export function pressureWidth(base: number, pressure: number): number {
  const p = Math.max(0.05, Math.min(1, pressure || 0.5));
  return base * (0.38 + 1.24 * p);
}

export interface WidthGroup {
  width: number;
  /** Polyline pieces as flat [x0, y0, x1, y1, ...] runs. */
  runs: number[][];
}

/**
 * Splits the spline into short pieces and groups them by width. Consecutive pieces of the same
 * width form one run, so most strokes need only a handful of runs.
 */
export function variableWidthGroups(segs: Bezier[], widths: number[]): WidthGroup[] {
  const groups = new Map<number, WidthGroup>();
  let current: { key: number; run: number[] } | null = null;
  const emit = (key: number, w: number, a: XY, b: XY) => {
    if (current && current.key === key) {
      current.run.push(b.x, b.y);
      return;
    }
    let g = groups.get(key);
    if (!g) {
      g = { width: w, runs: [] };
      groups.set(key, g);
    }
    const run = [a.x, a.y, b.x, b.y];
    g.runs.push(run);
    current = { key, run };
  };
  segs.forEach((seg, i) => {
    const w0 = widths[i], w1 = widths[i + 1] ?? w0;
    const len = dist(seg[0], seg[1]) + dist(seg[1], seg[2]) + dist(seg[2], seg[3]);
    const n = Math.max(1, Math.ceil(len / PIECE));
    let prev = seg[0];
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const q = k === n ? seg[3] : bezierPoint(seg, t);
      // Smoothstep between the control points' widths.
      const tm = (k - 0.5) / n;
      const s = tm * tm * (3 - 2 * tm);
      const w = w0 + (w1 - w0) * s;
      const key = Math.max(1, Math.round(w / WIDTH_STEP));
      emit(key, key * WIDTH_STEP, prev, q);
      prev = q;
    }
  });
  return [...groups.values()];
}
