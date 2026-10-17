/**
 * Fills wide gaps between pen samples, in space and in time, before they reach the ink engine
 * (input layer; the engine itself is frozen).
 *
 * The engine fits each sample with its neighbours, but only with those within NIB.CHORD (6 px):
 * in a very fast stroke, or with a digitiser that samples slowly (older Android tablets, 60-120 Hz),
 * samples land 10-30 px apart, each is fitted alone and the ink becomes straight pieces joined at
 * angles. Here each gap wider than GAP is filled, as the sample arrives, with a cubic (Hermite)
 * from the previous sample to the new one: it leaves the previous sample in the direction the
 * last piece ended in (no kink) and reaches the new one along the circle through the last three
 * samples (how the pen was turning). Nothing waits for a later sample, so there is no added
 * latency, and nothing already given to the engine ever changes. Where the pen turns sharply
 * (a cusp, a reversal) the gap is a straight piece as before, so corners are not rounded off or
 * overshot.
 *
 * Gaps in time are filled too. The engine's fit is a polynomial in time over a window of 14-70 ms;
 * between two samples further apart than that it is evaluated with samples on one side only, i.e.
 * extrapolated, and the ink shot out past the pen and came back (up to 50 px in the recordings):
 * after the pen rested (at touch-down, in a corner: samples that do not move used to be dropped)
 * and over the digitiser's missed samples. So samples where the pen rests are kept every STILL_MS,
 * and a gap longer than MAX_DT is filled every FILL_DT along the straight line.
 */
import type { Point } from '../types';

/** Gaps wider than this (page px) are filled. */
const GAP = 3;
/** Spacing of the filled points (page px). */
const STEP = 1.5;
/** Samples closer than this to the previous one do not count for the direction (jitter). */
const BASE = 1.5;
/** A turn sharper than this (between the incoming direction and the gap, degrees) is a corner. */
const MAX_TURN = 45;
/** How lopsided an arc may be (radians): turn in and out may differ by this, or 60 % of the larger. */
const MIN_SKEW = (10 * Math.PI) / 180;
/** A sample this close to the previous one (page px, each axis) is the pen resting... */
const STILL_PX = 0.2;
/** ... and is kept only once this long after the previous sample (ms). */
const STILL_MS = 6;
/** Gaps in time longer than this are filled (ms)... */
const MAX_DT = 10;
/** ... with samples this far apart in time (ms). */
const FILL_DT = 5;

type V = { x: number; y: number };
const maxTurn = (MAX_TURN * Math.PI) / 180;

export class SampleDensifier {
  private last: Point | null = null;
  /** The newest resting sample not given to the engine yet (the pen was still there then). */
  private held: Point | null = null;
  /** Earlier samples, at least BASE apart (for the direction the pen is turning). */
  private hist: V[] = [];
  /** Unit direction the line arrived at `last` with; null when unknown. */
  private dir: V | null = null;

  /** The points to add for sample `pt`: the filled points, then `pt` itself (none while the pen rests). */
  push(pt: Point): Point[] {
    const prev = this.last;
    if (!prev) {
      this.last = pt;
      this.hist = [pt];
      return [pt];
    }
    if (Math.abs(pt.x - prev.x) < STILL_PX && Math.abs(pt.y - prev.y) < STILL_PX) {
      // Resting: one sample every STILL_MS keeps the engine's time window filled.
      if ((pt.t ?? 0) - (prev.t ?? 0) < STILL_MS) {
        this.held = pt;
        return [];
      }
      this.held = null;
      this.last = pt;
      return [pt];
    }
    // Moving again: the pen was still at the last resting sample until then.
    const lead: Point[] = [];
    let a = prev;
    if (this.held && (this.held.t ?? 0) > (prev.t ?? 0)) {
      a = this.held;
      lead.push(a);
    }
    this.held = null;
    this.last = pt;
    return lead.concat(this.fill(a, pt));
  }

  private fill(a: Point, pt: Point): Point[] {
    const cx = pt.x - a.x, cy = pt.y - a.y, L = Math.hypot(cx, cy);
    if (L < 1e-6) return [pt];
    const chord = { x: cx / L, y: cy / L };
    // Direction at the new sample: the tangent of the circle through the two samples before it and
    // it (inscribed angle: the chord turned by the angle the gap subtends at the older sample).
    const h = this.hist;
    let end = chord;
    if (h.length >= 2) {
      const p0 = h[h.length - 2], p1 = h[h.length - 1];
      const ux = p1.x - p0.x, uy = p1.y - p0.y, wx = pt.x - p0.x, wy = pt.y - p0.y;
      const ang = Math.atan2(ux * wy - uy * wx, ux * wx + uy * wy);
      if (Math.abs(ang) < Math.PI / 3) {
        const c = Math.cos(ang), s = Math.sin(ang);
        end = { x: chord.x * c - chord.y * s, y: chord.x * s + chord.y * c };
      }
    }
    const start = this.dir ?? chord;
    const tp = h[h.length - 1];
    if (!tp || Math.hypot(pt.x - tp.x, pt.y - tp.y) >= BASE) {
      h.push({ x: pt.x, y: pt.y });
      if (h.length > 3) h.shift();
    }
    const angle = (u: V, v: V) => Math.atan2(u.x * v.y - u.y * v.x, u.x * v.x + u.y * v.y);
    // On an arc the line leaves and reaches the gap turned the same way by the same amount; a gap
    // across a corner is lopsided (straight in, turned out) and stays straight, as does one where
    // the pen turns sharply. Lifting or landing (no force: the pen in the air for the engine) too.
    const a1 = angle(start, chord), a2 = angle(chord, end);
    const arc = Math.abs(a1) < maxTurn && Math.abs(a2) < maxTurn && Math.abs(a1 - a2) <= Math.max(MIN_SKEW, 0.6 * Math.max(Math.abs(a1), Math.abs(a2)));
    // The next gap leaves in the direction the pen is moving here (also after a straight piece, so
    // the curve picks up again).
    this.dir = end;
    const ta = a.t ?? 0, tb = pt.t ?? ta;
    const inked = pt.pressure > 0 && a.pressure > 0;
    if ((L <= GAP || !inked) && tb - ta <= MAX_DT) return [pt];
    // A straight gap is filled too, along the straight line: the engine fits unevenly spaced
    // samples badly (dense up to a corner, one wide gap after it: the line overshot the corner).
    // Landing or lifting (a force-less end: the pen in the air for the engine), only a gap in time
    // is filled, straight and force-less too, so the engine still leaves it out of the ink.
    const curved = arc && inked;
    const out: Point[] = [];
    const n = Math.max(inked ? Math.ceil(L / STEP) : 1, Math.ceil((tb - ta) / FILL_DT));
    for (let k = 1; k < n; k++) {
      const s = k / n, s2 = s * s, s3 = s2 * s;
      const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
      out.push({
        ...pt,
        x: curved ? h00 * a.x + h10 * L * start.x + h01 * pt.x + h11 * L * end.x : a.x + cx * s,
        y: curved ? h00 * a.y + h10 * L * start.y + h01 * pt.y + h11 * L * end.y : a.y + cy * s,
        t: ta + (tb - ta) * s,
        pressure: inked ? a.pressure + (pt.pressure - a.pressure) * s : 0,
      });
    }
    out.push(pt);
    return out;
  }
}
