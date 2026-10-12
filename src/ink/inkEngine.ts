import { Point } from '../types';
import { XY } from './spline';

/**
 * Handwriting engine: a TypeScript port of the modelling stage of Google's Ink Stroke Modeler
 * (github.com/google/ink-stroke-modeler, Apache-2.0), the library behind the handwriting of
 * Google's own note apps, with its default parameters.
 *
 *  1. Wobble smoother: at very low speed the input is replaced by its moving average over the
 *     last 40 ms (removes the digitiser's jitter when writing slowly); at normal speed the raw
 *     position is used, with a smooth blend in between.
 *  2. Up-sampling: inputs are interpolated so that the model advances at least at 180 Hz.
 *  3. Position modeller: the ink tip is a mass pulled towards the pen by a spring, with drag
 *     (explicit Euler). This is what makes the line fluid: corners are rounded the way a real nib
 *     rounds them, and jitter is filtered without the lag of a heavy moving average.
 *  4. End of stroke: when the pen lifts, the tip is moved on until it reaches the pen.
 *
 * The model is causal: every output point depends only on earlier input, so ink that has been
 * drawn never moves again ("no retracing"). The live stroke and the saved stroke are the same.
 *
 * Rendering (strokeRenderer.ts): the dense output is drawn as a polyline (uniform width) or, for
 * the fountain pen, as the exact union of capsules swept by a circle whose radius follows the
 * pressure — smooth at any size, with no polygonal facets.
 */

export interface ModeledPoint {
  x: number;
  y: number;
  /** Normalised pressure 0..1. */
  p: number;
  /** ms since the start of the stroke. */
  t: number;
}

// Ink Stroke Modeler defaults, converted to milliseconds and page units (96 px per inch).
const WOBBLE_TIMEOUT = 40; // ms
const PX_PER_CM = 96 / 2.54;
const WOBBLE_SPEED_FLOOR = (1.31 * PX_PER_CM) / 1000; // px/ms
const WOBBLE_SPEED_CEILING = (1.44 * PX_PER_CM) / 1000;
const SPRING_MASS = (11 / 32400) * 1e6; // ms^2
const DRAG = 72 / 1000; // 1/ms
const MAX_DT = 1000 / 180; // ms (minimum output rate 180 Hz)
const END_ITERATIONS = 20;
const END_STOP_DISTANCE = 0.05; // px

interface WobbleSample {
  x: number;
  y: number;
  d: number;
  dt: number;
  t: number;
}

interface TipState {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

function step(s: TipState, ax: number, ay: number, dt: number) {
  const accX = (ax - s.x) / SPRING_MASS - DRAG * s.vx;
  const accY = (ay - s.y) / SPRING_MASS - DRAG * s.vy;
  s.vx += dt * accX;
  s.vy += dt * accY;
  s.x += dt * s.vx;
  s.y += dt * s.vy;
}

/** Streaming stroke model. Feed samples with add(); `points` only ever grows. */
export class StrokeModeler {
  readonly points: ModeledPoint[] = [];
  private window: WobbleSample[] = [];
  private sumX = 0;
  private sumY = 0;
  private sumD = 0;
  private sumDt = 0;
  private last: { x: number; y: number; t: number; p: number } | null = null;
  private tip: TipState = { x: 0, y: 0, vx: 0, vy: 0 };

  private wobble(x: number, y: number, t: number): XY {
    const prev = this.window[this.window.length - 1];
    const d = prev ? Math.hypot(x - prev.x, y - prev.y) : 0;
    const dt = prev ? t - prev.t : 0;
    this.window.push({ x, y, d, dt, t });
    this.sumX += x;
    this.sumY += y;
    this.sumD += d;
    this.sumDt += dt;
    while (this.window.length > 1 && this.window[0].t < t - WOBBLE_TIMEOUT) {
      const f = this.window.shift()!;
      this.sumX -= f.x;
      this.sumY -= f.y;
      // The next sample's distance/duration were measured from the removed one.
      const n = this.window[0];
      this.sumD -= n.d;
      this.sumDt -= n.dt;
      n.d = 0;
      n.dt = 0;
    }
    if (this.sumDt <= 0) return { x, y };
    const n = this.window.length;
    const speed = this.sumD / this.sumDt;
    const k = Math.max(0, Math.min(1, (speed - WOBBLE_SPEED_FLOOR) / (WOBBLE_SPEED_CEILING - WOBBLE_SPEED_FLOOR)));
    return { x: this.sumX / n + (x - this.sumX / n) * k, y: this.sumY / n + (y - this.sumY / n) * k };
  }

  add(x: number, y: number, t: number, p: number): void {
    if (this.last && t <= this.last.t) t = this.last.t + 0.5;
    const s = this.wobble(x, y, t);
    const last = this.last;
    if (!last) {
      this.tip = { x: s.x, y: s.y, vx: 0, vy: 0 };
      this.points.push({ x: s.x, y: s.y, p, t });
      this.last = { x: s.x, y: s.y, t, p };
      return;
    }
    const total = t - last.t;
    const n = Math.max(1, Math.ceil(total / MAX_DT));
    const dt = total / n;
    for (let i = 1; i <= n; i++) {
      const f = i / n;
      step(this.tip, last.x + (s.x - last.x) * f, last.y + (s.y - last.y) * f, dt);
      this.points.push({ x: this.tip.x, y: this.tip.y, p: last.p + (p - last.p) * f, t: last.t + total * f });
    }
    this.last = { x: s.x, y: s.y, t, p };
  }

  /**
   * The rest of the stroke if the pen lifted now (optionally after the predicted samples):
   * provisional, recomputed every frame, never stored.
   */
  tail(predicted: { x: number; y: number; t: number; p: number }[] = []): ModeledPoint[] {
    if (!this.last) return [];
    const tip: TipState = { ...this.tip };
    const out: ModeledPoint[] = [];
    let last = this.last;
    for (const q of predicted) {
      if (q.t <= last.t) continue;
      const total = q.t - last.t;
      const n = Math.max(1, Math.ceil(total / MAX_DT));
      for (let i = 1; i <= n; i++) {
        const f = i / n;
        step(tip, last.x + (q.x - last.x) * f, last.y + (q.y - last.y) * f, total / n);
        out.push({ x: tip.x, y: tip.y, p: last.p + (q.p - last.p) * f, t: last.t + total * f });
      }
      last = q;
    }
    let t = last.t;
    for (let i = 0; i < END_ITERATIONS; i++) {
      if (Math.hypot(tip.x - last.x, tip.y - last.y) < END_STOP_DISTANCE) break;
      t += MAX_DT;
      step(tip, last.x, last.y, MAX_DT);
      out.push({ x: tip.x, y: tip.y, p: last.p, t });
    }
    if (Math.hypot(tip.x - last.x, tip.y - last.y) > 0.3) out.push({ x: last.x, y: last.y, p: last.p, t: t + MAX_DT });
    return out;
  }
}

/**
 * Sample times of a stroke. Strokes saved before v1.2 have no timestamps: they are synthesised
 * from the distance at an ordinary writing speed.
 */
function sampleTimes(points: Point[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (typeof p.t === 'number' && (i === 0 || typeof points[i - 1].t === 'number')) out.push(p.t);
    else if (i === 0) out.push(0);
    else out.push(out[i - 1] + Math.max(4, Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y) / 0.4));
  }
  return out;
}

/** The full modelled stroke (as drawn when finished). */
export function modelStroke(points: Point[]): ModeledPoint[] {
  if (points.length === 0) return [];
  const m = new StrokeModeler();
  const times = sampleTimes(points);
  points.forEach((p, i) => m.add(p.x, p.y, times[i], p.pressure > 0 ? p.pressure : 0.5));
  return [...m.points, ...m.tail()];
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

/** Drops modelled points closer than `min` to the previous one (keeps the last). */
export function thinModeled(pts: ModeledPoint[], min = 0.35): ModeledPoint[] {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const l = out[out.length - 1];
    if (Math.hypot(pts[i].x - l.x, pts[i].y - l.y) >= min) out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/**
 * Appends to `path` the capsule swept by a circle moving from (a, ra) to (b, rb): the two outer
 * tangents and the two end arcs, always with the same winding so that a nonzero fill of many
 * capsules is their exact union.
 */
export function addCapsule(path: Path2D | CanvasRenderingContext2D, a: XY, ra: number, b: XY, rb: number): void {
  const dx = b.x - a.x, dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  if (d <= Math.abs(ra - rb) + 1e-6) {
    // One circle contains the other.
    const c = ra >= rb ? a : b, r = Math.max(ra, rb);
    path.moveTo(c.x + r, c.y);
    path.arc(c.x, c.y, r, 0, Math.PI * 2, true);
    path.closePath();
    return;
  }
  const th = Math.atan2(dy, dx);
  const ph = Math.acos((ra - rb) / d);
  path.moveTo(a.x + ra * Math.cos(th + ph), a.y + ra * Math.sin(th + ph));
  path.lineTo(b.x + rb * Math.cos(th + ph), b.y + rb * Math.sin(th + ph));
  path.arc(b.x, b.y, rb, th + ph, th - ph, true);
  path.lineTo(a.x + ra * Math.cos(th - ph), a.y + ra * Math.sin(th - ph));
  path.arc(a.x, a.y, ra, th - ph, th + ph - Math.PI * 2, true);
  path.closePath();
}

/** SVG path data of the same capsule (for vector export). */
export function capsuleSvg(a: XY, ra: number, b: XY, rb: number, f: (v: number) => string): string {
  const dx = b.x - a.x, dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  if (d <= Math.abs(ra - rb) + 1e-6) {
    const c = ra >= rb ? a : b, r = Math.max(ra, rb);
    return `M${f(c.x + r)} ${f(c.y)}A${f(r)} ${f(r)} 0 1 0 ${f(c.x - r)} ${f(c.y)}A${f(r)} ${f(r)} 0 1 0 ${f(c.x + r)} ${f(c.y)}Z`;
  }
  const th = Math.atan2(dy, dx);
  const ph = Math.acos((ra - rb) / d);
  const P = (c: XY, r: number, ang: number) => `${f(c.x + r * Math.cos(ang))} ${f(c.y + r * Math.sin(ang))}`;
  // Front arc spans 2*ph around b, back arc 2*pi - 2*ph around a; both counter-clockwise (sweep 0).
  return (
    `M${P(a, ra, th + ph)}L${P(b, rb, th + ph)}` +
    `A${f(rb)} ${f(rb)} 0 ${2 * ph > Math.PI ? 1 : 0} 0 ${P(b, rb, th - ph)}` +
    `L${P(a, ra, th - ph)}` +
    `A${f(ra)} ${f(ra)} 0 ${2 * Math.PI - 2 * ph > Math.PI ? 1 : 0} 0 ${P(a, ra, th + ph)}Z`
  );
}
