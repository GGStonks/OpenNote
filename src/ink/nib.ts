import { Point } from '../types';
import { ModeledPoint, hasRealPressure, sampleTimes } from './inkEngine';

/**
 * Nib: OpenNote's own handwriting engine.
 *
 * A causal filter (a spring, a moving average) can only smooth by lagging, and lag is what rounds
 * corners and shrinks small loops. Nib smooths every sample with the samples on both sides of it,
 * so the line has no lag-induced distortion, and hides the short wait for those samples behind a
 * provisional tail that is redrawn every frame and always reaches the nib:
 *
 *  1. Anchors: each raw sample is replaced by a local weighted quadratic regression in time over
 *     its neighbours (zero phase: centred on the sample). The window adapts to speed: it spans
 *     about ARC px of line, between MIN_HALF and MAX_HALF ms, so slow writing (where digitiser
 *     jitter shows) is smoothed hard and fast writing keeps its detail. A quadratic, unlike an
 *     average, follows curvature, so loops keep their size.
 *  2. Settling: an anchor is final once the samples its window needs have arrived; from then on
 *     the ink up to it never changes. Until then it is provisional (fitted with the samples that
 *     exist) and drawn on the tail.
 *  3. Curve: centripetal Catmull-Rom through the anchors (no cusps or overshooting loops between
 *     samples), emitted as dense points every STEP px.
 *  4. Pressure: the Pencil's force smoothed the same way (zero phase); the first ATTACK ms take at
 *     least the force the pen settles at, because the first samples' force is an under-read
 *     estimate and real nibs ink at full width as they land; a drop of force is followed with
 *     the RELEASE time constant so strokes keep their body width as the pen eases off.
 *  5. Prediction (tail only, never stored): constant-acceleration extrapolation of the last
 *     PREDICT_WIN ms over HORIZON ms, stopped where the pen would come to rest and only at
 *     writing speed, so it covers the display latency without shooting past the end of a stroke.
 *
 * Input times are ms on any clock; output `t` is relative to the first sample.
 */

export const NIB = {
  /** Half window, in px of line, of the anchor fit. */
  ARC: 1.6,
  /** Half window limits in ms. */
  MIN_HALF: 6,
  MAX_HALF: 70,
  /**
   * The window also stops at samples farther than this from the centre sample: where the pen
   * slows down into a corner the time window grows, and without this it would reach round the
   * corner and cut it.
   */
  CHORD: 2,
  /** Windows spanning less than this (px) are fitted with a line: lower noise, no curvature to lose. */
  LINEAR_BELOW: 1.2,
  /** Speed estimate: displacement over +/- this many ms. */
  SPEED_WIN: 8,
  /** Half window of the pressure smoothing (ms). */
  PRESS_HALF: 14,
  ATTACK: 24,
  RELEASE: 60,
  /** Prediction horizon and the history it is fitted to (ms). */
  HORIZON: 9,
  PREDICT_WIN: 20,
  /** Share of the fitted acceleration used (it is the noisiest term). */
  ACCEL: 1,
  /** No prediction below this speed (px/ms). */
  PREDICT_MIN_SPEED: 0.12,
  /** Output spacing (px). */
  STEP: 0.5,
};

interface Raw {
  x: number;
  y: number;
  t: number;
  /** Force 0..1; 0 = unknown (the pen is lifting). */
  f: number;
}

interface Anchor {
  x: number;
  y: number;
  t: number;
  p: number;
}

const tricube = (u: number) => {
  const a = 1 - Math.abs(u) ** 3;
  return a <= 0 ? 0 : a * a * a;
};

export class NibModeler {
  /** Settled output: only ever grows, never changes. */
  readonly points: ModeledPoint[] = [];
  private raw: Raw[] = [];
  private anchors: Anchor[] = [];
  /** Anchors whose curve segment (from the previous anchor) has been emitted. */
  private emitted = 0;
  private t0 = NaN;
  private env = -1;
  private attackForce = -1;

  add(x: number, y: number, t: number, p: number): void {
    if (Number.isNaN(this.t0)) this.t0 = t;
    let tt = t - this.t0;
    const last = this.raw[this.raw.length - 1];
    if (last && tt <= last.t) tt = last.t + 0.25;
    this.raw.push({ x, y, t: tt, f: p > 0 ? Math.min(1, p) : 0 });
    this.settle(false);
  }

  /** Settles everything (the pen has lifted). */
  finish(): ModeledPoint[] {
    this.settle(true);
    this.emit(true);
    return this.points;
  }

  /**
   * The provisional rest of the stroke after `points`: the unsettled anchors and, with `predict`,
   * the predicted continuation. Recomputed every frame, never stored.
   */
  tail(predict = false): ModeledPoint[] {
    const n = this.raw.length;
    if (!n) return [];
    const provisional: Anchor[] = [];
    let env = this.env;
    for (let i = this.anchors.length; i < n; i++) {
      const a = this.fitAnchor(i, provisional, env);
      env = a.p;
      provisional.push(a);
    }
    const all = provisional.length ? this.anchors.concat(provisional) : this.anchors;
    const out: ModeledPoint[] = [];
    for (let i = Math.max(1, this.emitted); i < all.length; i++) this.segment(all, i, true, out);
    if (this.emitted === 0 && all.length) out.unshift(this.point(all[0]));
    if (predict) out.push(...this.predict(all[all.length - 1]));
    return out;
  }

  // ------------------------------------------------------------------------------------- anchors
  private speedAt(i: number): number {
    const r = this.raw;
    const ti = r[i].t;
    let a = i, b = i;
    while (a > 0 && ti - r[a - 1].t <= NIB.SPEED_WIN) a--;
    while (b < r.length - 1 && r[b + 1].t - ti <= NIB.SPEED_WIN) b++;
    const dt = r[b].t - r[a].t;
    return dt > 0 ? Math.hypot(r[b].x - r[a].x, r[b].y - r[a].y) / dt : 0;
  }

  private halfWindow(i: number): number {
    const v = this.speedAt(i);
    return Math.max(NIB.MIN_HALF, Math.min(NIB.MAX_HALF, v > 0 ? NIB.ARC / v : NIB.MAX_HALF));
  }

  private settle(final: boolean) {
    const r = this.raw;
    const latest = r[r.length - 1].t;
    while (this.anchors.length < r.length) {
      const i = this.anchors.length;
      if (!final) {
        const ti = r[i].t;
        if (latest < ti + NIB.SPEED_WIN) break;
        if (latest < ti + Math.max(this.halfWindow(i), NIB.PRESS_HALF)) break;
        if (ti < NIB.ATTACK && latest < NIB.ATTACK + NIB.PRESS_HALF) break;
      }
      const a = this.fitAnchor(i, [], this.env);
      this.env = a.p;
      this.anchors.push(a);
    }
    this.emit(false);
  }

  /** Anchor i from the samples available now. `pending` = provisional anchors before it. */
  private fitAnchor(i: number, _pending: Anchor[], prevEnv: number): Anchor {
    const r = this.raw;
    const ti = r[i].t;
    const h = this.halfWindow(i);
    const near = (j: number) => Math.hypot(r[j].x - r[i].x, r[j].y - r[i].y) <= NIB.CHORD;
    let a = i, b = i;
    while (a > 0 && ti - r[a - 1].t < h && near(a - 1)) a--;
    while (b < r.length - 1 && r[b + 1].t - ti < h && near(b + 1)) b++;
    const pos = fitAt(r, a, b, ti, h);

    // Pressure: zero-phase weighted mean of the known forces.
    let pa = i, pb = i;
    while (pa > 0 && ti - r[pa - 1].t < NIB.PRESS_HALF) pa--;
    while (pb < r.length - 1 && r[pb + 1].t - ti < NIB.PRESS_HALF) pb++;
    let sw = 0, sf = 0;
    for (let j = pa; j <= pb; j++) {
      if (!(r[j].f > 0)) continue;
      const w = tricube((r[j].t - ti) / NIB.PRESS_HALF) + 1e-6;
      sw += w;
      sf += w * r[j].f;
    }
    let p = sw > 0 ? sf / sw : prevEnv >= 0 ? prevEnv : 0.5;
    if (ti < NIB.ATTACK) p = Math.max(p, this.landingForce());
    // Envelope: rises at once, falls with the release time constant.
    if (prevEnv >= 0 && p < prevEnv) {
      const dt = i > 0 ? ti - r[i - 1].t : 0;
      p = p + (prevEnv - p) * Math.exp(-dt / NIB.RELEASE);
    }
    return { x: pos.x, y: pos.y, t: ti, p };
  }

  /** Median known force of the first ATTACK ms (the force the pen settles at after landing). */
  private landingForce(): number {
    if (this.attackForce >= 0) return this.attackForce;
    const r = this.raw;
    const fs: number[] = [];
    for (const s of r) {
      if (s.t > NIB.ATTACK + NIB.PRESS_HALF) break;
      if (s.f > 0) fs.push(s.f);
    }
    if (!fs.length) return 0;
    fs.sort((x, y) => x - y);
    // Upper half: the first samples are the under-read ones.
    const v = fs[Math.min(fs.length - 1, Math.floor(fs.length * 0.75))];
    if (r[r.length - 1].t >= NIB.ATTACK + NIB.PRESS_HALF) this.attackForce = v;
    return v;
  }

  // ---------------------------------------------------------------------------------------- curve
  private point(a: Anchor): ModeledPoint {
    return { x: a.x, y: a.y, p: a.p, t: a.t };
  }

  /** Emits the settled segments: segment i (anchor i-1 -> i) needs anchor i+1 for its tangent. */
  private emit(final: boolean) {
    const A = this.anchors;
    if (!A.length) return;
    if (this.emitted === 0) {
      this.points.push(this.point(A[0]));
      this.emitted = 1;
    }
    while (this.emitted < A.length && (final || this.emitted + 1 < A.length)) {
      this.segment(A, this.emitted, final && this.emitted === A.length - 1, this.points);
      this.emitted++;
    }
  }

  /** Centripetal Catmull-Rom from A[i-1] to A[i], appended without its first point. */
  private segment(A: Anchor[], i: number, _last: boolean, out: ModeledPoint[]) {
    const p1 = A[i - 1], p2 = A[i];
    const p0 = A[i - 2] ?? reflect(p2, p1);
    const p3 = A[i + 1] ?? reflect(p1, p2);
    const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const n = Math.max(1, Math.ceil(len / NIB.STEP));
    if (len < 1e-6) {
      out.push(this.point(p2));
      return;
    }
    const k = (a: Anchor, b: Anchor) => Math.max(1e-4, Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y)));
    const t1 = k(p0, p1), t2 = t1 + k(p1, p2), t3 = t2 + k(p2, p3);
    for (let s = 1; s <= n; s++) {
      const f = s / n;
      if (s === n) {
        out.push(this.point(p2));
        break;
      }
      const u = t1 + (t2 - t1) * f;
      const x = cr(p0.x, p1.x, p2.x, p3.x, 0, t1, t2, t3, u);
      const y = cr(p0.y, p1.y, p2.y, p3.y, 0, t1, t2, t3, u);
      out.push({ x, y, p: p1.p + (p2.p - p1.p) * f, t: p1.t + (p2.t - p1.t) * f });
    }
  }

  // ----------------------------------------------------------------------------------- prediction
  private predict(from: Anchor): ModeledPoint[] {
    const r = this.raw;
    const n = r.length;
    if (n < 4) return [];
    const tl = r[n - 1].t;
    let a = n - 1;
    while (a > 0 && tl - r[a - 1].t <= NIB.PREDICT_WIN) a--;
    if (n - a < 4) return [];
    // The pen must really be moving: the end-point derivative alone can be made of noise (a dot).
    const travelled = Math.hypot(r[n - 1].x - r[a].x, r[n - 1].y - r[a].y) / Math.max(1e-6, tl - r[a].t);
    if (travelled < NIB.PREDICT_MIN_SPEED) return [];
    const m = motionAt(r, a, n - 1, tl, NIB.PREDICT_WIN);
    const speed = Math.hypot(m.vx, m.vy);
    if (speed < NIB.PREDICT_MIN_SPEED) return [];
    // Stop where the velocity along the current direction would reach zero (the pen slowing down).
    const along = (m.vx * m.ax + m.vy * m.ay) / speed;
    let horizon = NIB.HORIZON;
    if (along < 0) horizon = Math.min(horizon, (0.5 * speed) / -along);
    const out: ModeledPoint[] = [];
    const steps = Math.max(1, Math.ceil(horizon / 2));
    for (let s = 1; s <= steps; s++) {
      const tau = (horizon * s) / steps;
      const k = 0.5 * NIB.ACCEL * tau * tau;
      out.push({ x: from.x + m.vx * tau + k * m.ax, y: from.y + m.vy * tau + k * m.ay, p: from.p, t: from.t + tau });
    }
    return out;
  }
}

function reflect(a: Anchor, b: Anchor): Anchor {
  return { x: 2 * b.x - a.x, y: 2 * b.y - a.y, t: 2 * b.t - a.t, p: b.p };
}

/** Barry-Goldman evaluation of a non-uniform Catmull-Rom segment. */
function cr(P0: number, P1: number, P2: number, P3: number, t0: number, t1: number, t2: number, t3: number, t: number): number {
  const A1 = ((t1 - t) * P0 + (t - t0) * P1) / (t1 - t0);
  const A2 = ((t2 - t) * P1 + (t - t1) * P2) / (t2 - t1);
  const A3 = ((t3 - t) * P2 + (t - t2) * P3) / (t3 - t2);
  const B1 = ((t2 - t) * A1 + (t - t0) * A2) / (t2 - t0);
  const B2 = ((t3 - t) * A2 + (t - t1) * A3) / (t3 - t1);
  return ((t2 - t) * B1 + (t - t1) * B2) / (t2 - t1);
}

/**
 * Weighted local polynomial fit of samples a..b around time tc (tricube weights, half width h):
 * quadratic when there are samples on both sides, linear at the ends of the data (lower variance
 * where the window is one-sided), the sample itself when nothing else is near.
 */
function fitAt(r: Raw[], a: number, b: number, tc: number, h: number): { x: number; y: number } {
  if (a === b) return { x: r[a].x, y: r[a].y };
  let before = 0, after = 0;
  for (let j = a; j <= b; j++) {
    if (r[j].t < tc - 1e-6) before++;
    else if (r[j].t > tc + 1e-6) after++;
  }
  let span = 0;
  for (let j = a + 1; j <= b; j++) span = Math.max(span, Math.hypot(r[j].x - r[a].x, r[j].y - r[a].y));
  const degree = before >= 2 && after >= 2 && span >= NIB.LINEAR_BELOW ? 2 : 1;
  const c = polyFit(r, a, b, tc, h, degree);
  return { x: c.x[0], y: c.y[0] };
}

/** Velocity and acceleration at tc from a one-sided quadratic fit over a..b. */
export function motionAt(r: Raw[], a: number, b: number, tc: number, h: number) {
  const c = polyFit(r, a, b, tc, h * 1.2, b - a >= 3 ? 2 : 1);
  // Coefficients are in u = (t - tc) / h.
  const sh = h * 1.2;
  return { vx: c.x[1] / sh, vy: c.y[1] / sh, ax: (2 * (c.x[2] ?? 0)) / (sh * sh), ay: (2 * (c.y[2] ?? 0)) / (sh * sh) };
}

export function polyFit(r: Raw[], a: number, b: number, tc: number, h: number, degree: 1 | 2) {
  const m = degree + 1;
  const S = new Float64Array(2 * m - 1);
  const X = new Float64Array(m), Y = new Float64Array(m);
  for (let j = a; j <= b; j++) {
    const u = (r[j].t - tc) / h;
    const w = tricube(u * 0.999) + 1e-9;
    let pw = w;
    for (let k = 0; k < 2 * m - 1; k++) {
      S[k] += pw;
      if (k < m) {
        X[k] += pw * r[j].x;
        Y[k] += pw * r[j].y;
      }
      pw *= u;
    }
  }
  const M: number[][] = [];
  for (let i = 0; i < m; i++) M.push(Array.from({ length: m }, (_, k) => S[i + k]));
  const x = solve(M, Array.from(X)), y = solve(M, Array.from(Y));
  if (!x || !y) {
    // Degenerate (all samples at one time): weighted mean.
    return { x: [X[0] / S[0], 0, 0], y: [Y[0] / S[0], 0, 0] };
  }
  return { x, y };
}

function solve(M: number[][], v: number[]): number[] | null {
  const n = v.length;
  const A = M.map((row, i) => [...row, v[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (Math.abs(A[piv][c]) < 1e-10) return null;
    [A[c], A[piv]] = [A[piv], A[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k];
    }
  }
  return A.map((row, i) => row[n] / row[i]);
}

/** The full stroke as drawn when finished. */
export function nibStroke(points: Point[]): ModeledPoint[] {
  if (!points.length) return [];
  const m = new NibModeler();
  const times = sampleTimes(points);
  // Pencil strokes keep 0 = force unknown (lifting); strokes without pressure draw at 0.5.
  const real = hasRealPressure(points);
  points.forEach((p, i) => m.add(p.x, p.y, times[i], real ? p.pressure : 0.5));
  return m.finish();
}
