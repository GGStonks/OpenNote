/**
 * The v1.7 handwriting engine, kept as the baseline of the pen benchmarks: a TypeScript port of
 * the modelling stage of Google's Ink Stroke Modeler (github.com/google/ink-stroke-modeler,
 * Apache-2.0) with a stiffer, critically damped spring and a 2.5 px arc-length average. The app
 * draws with Nib (src/ink/engine).
 */
import { InkPoint, ModeledPoint, XY, sampleTimes } from '../src/ink/engine';

// Wobble smoother: Ink Stroke Modeler defaults, in milliseconds and page units (96 px per inch).
const WOBBLE_TIMEOUT = 40; // ms
const PX_PER_CM = 96 / 2.54;
const WOBBLE_SPEED_FLOOR = (1.31 * PX_PER_CM) / 1000; // px/ms
const WOBBLE_SPEED_CEILING = (1.44 * PX_PER_CM) / 1000;
// Position model: stiffer than the library default (natural frequency 54 rad/s, damping 0.66),
// which trailed the pen by ~5 px at writing speed, overshot sharp corners by ~0.7 px and let
// small loops miss their closing point. Critically damped at 250 rad/s: ~1.6 px lag at
// 300 px/s, no overshoot, small letters within ~0.15 px of the pen, jitter still halved.
const OMEGA = 0.25; // rad/ms
const SPRING_MASS = 1 / (OMEGA * OMEGA); // ms^2
const DRAG = 2 * OMEGA; // 1/ms (damping ratio 1)
const MAX_DT = 1.5; // ms (model rate >= 667 Hz, keeps explicit Euler well inside its stable range)
const END_ITERATIONS = 60;
// Output smoothing: each drawn point is the average of the model's points over the last 2.5 px of
// line (causal, so drawn ink still never moves). Removes the digitiser jitter the stiff spring lets
// through, for ~1 px of extra lag: overall 2.8 px lag at 300 px/s (library default: 4.8 px).
const ARC_WINDOW = 2.5; // px
const END_STOP_DISTANCE = 0.05; // px
// Pressure envelope: the width follows a rise of force at once but a drop only with this time
// constant, so a stroke keeps its body width to the end instead of thinning into a hairline as
// the Pencil eases off the glass (the "fragile", tapered look).
const PRESSURE_RELEASE = 60; // ms

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

/** Causal arc-length moving average of the tip positions. */
class ArcWindow {
  items: { x: number; y: number; s: number }[] = [];
  sx = 0;
  sy = 0;
  push(x: number, y: number): XY {
    const last = this.items[this.items.length - 1];
    const s = last ? last.s + Math.hypot(x - last.x, y - last.y) : 0;
    this.items.push({ x, y, s });
    this.sx += x;
    this.sy += y;
    while (this.items.length > 1 && s - this.items[0].s > ARC_WINDOW) {
      const f = this.items.shift()!;
      this.sx -= f.x;
      this.sy -= f.y;
    }
    return { x: this.sx / this.items.length, y: this.sy / this.items.length };
  }
  clone(): ArcWindow {
    const c = new ArcWindow();
    c.items = this.items.slice();
    c.sx = this.sx;
    c.sy = this.sy;
    return c;
  }
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
  private arc = new ArcWindow();
  private env = -1;

  private envelope(p: number, dt: number): number {
    this.env = this.env < 0 || p >= this.env ? p : p + (this.env - p) * Math.exp(-dt / PRESSURE_RELEASE);
    return this.env;
  }

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
    p = this.envelope(p, last ? t - last.t : 0);
    if (!last) {
      this.tip = { x: s.x, y: s.y, vx: 0, vy: 0 };
      this.arc.push(s.x, s.y);
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
      const o = this.arc.push(this.tip.x, this.tip.y);
      this.points.push({ x: o.x, y: o.y, p: last.p + (p - last.p) * f, t: last.t + total * f });
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
    const arc = this.arc.clone();
    const out: ModeledPoint[] = [];
    let last = this.last;
    for (const q of predicted) {
      if (q.t <= last.t) continue;
      const total = q.t - last.t;
      const n = Math.max(1, Math.ceil(total / MAX_DT));
      for (let i = 1; i <= n; i++) {
        const f = i / n;
        step(tip, last.x + (q.x - last.x) * f, last.y + (q.y - last.y) * f, total / n);
        const o = arc.push(tip.x, tip.y);
        out.push({ x: o.x, y: o.y, p: last.p + (q.p - last.p) * f, t: last.t + total * f });
      }
      last = q;
    }
    let t = last.t;
    for (let i = 0; i < END_ITERATIONS; i++) {
      if (Math.hypot(tip.x - last.x, tip.y - last.y) < END_STOP_DISTANCE) break;
      t += MAX_DT;
      step(tip, last.x, last.y, MAX_DT);
      const o = arc.push(tip.x, tip.y);
      out.push({ x: o.x, y: o.y, p: last.p, t });
    }
    // The stroke always ends exactly where the pen lifted.
    const end = out[out.length - 1] ?? this.points[this.points.length - 1];
    if (!end || Math.hypot(end.x - last.x, end.y - last.y) > 0.02) out.push({ x: last.x, y: last.y, p: last.p, t: t + MAX_DT });
    return out;
  }
}

/** The full modelled stroke (as drawn when finished). */
export function modelStroke(points: InkPoint[]): ModeledPoint[] {
  if (points.length === 0) return [];
  const m = new StrokeModeler();
  const times = sampleTimes(points);
  points.forEach((p, i) => m.add(p.x, p.y, times[i], p.pressure > 0 ? p.pressure : 0.5));
  return [...m.points, ...m.tail()];
}

/**
 * Removes the lift-off flick: as the Pencil leaves the glass it keeps moving while its force
 * falls to zero, which drew a thin hook past the end of every stroke. Trailing samples whose raw
 * force dropped under half of the stroke's median force are dropped (a real nib stops inking
 * there), at most the last 30 ms and 10 px.
 */
export function trimLiftOff(points: InkPoint[], force: number[]): InkPoint[] {
  const n = points.length;
  if (n < 6 || force.length !== n) return points;
  const median = force.slice().sort((a, b) => a - b)[n >> 1];
  if (!(median > 0)) return points;
  const tEnd = points[n - 1].t ?? 0;
  let k = n;
  let len = 0;
  while (k > 4) {
    const i = k - 1;
    if (force[i] >= 0.5 * median || tEnd - (points[i].t ?? 0) > 30) break;
    len += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    if (len > 10) break;
    k--;
  }
  return k === n ? points : points.slice(0, k);
}
