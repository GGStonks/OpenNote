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
 *  3. Curve: the same fit evaluated continuously between samples, every STEP px (weights that
 *     fade out smoothly in time and in distance make it a smooth curve; a spline through one
 *     point per sample would bend at every sample).
 *  4. Pressure: the Pencil's force smoothed the same way (zero phase); the first ATTACK ms take at
 *     least the force the pen settles at, because the first samples' force is an under-read
 *     estimate and real nibs ink at full width as they land; a drop of force is followed with
 *     the RELEASE time constant so strokes keep their body width as the pen eases off.
 *  4b. Lift-off: as the Pencil leaves the glass it keeps reporting samples, still moving, while its
 *     force fades to zero; a nib stops inking there. Trailing samples whose force is under
 *     LIFT_FORCE of the stroke's median (the last LIFT_MS / LIFT_PX at most) are not ink: they
 *     are held back while drawing (neither settled nor on the tail, since they may turn out to be
 *     the lift) and dropped when the stroke ends, so the ink stops where the pen stopped inking.
 *  5. Prediction (tail only, never stored): constant-acceleration extrapolation of the last
 *     PREDICT_WIN ms over HORIZON ms, stopped where the pen would come to rest and only at
 *     writing speed, so it covers the display latency without shooting past the end of a stroke.
 *
 * Input times are ms on any clock; output `t` is relative to the first sample.
 */

export const NIB = {
  /** Half window, in px of line, of the anchor fit. */
  ARC: 5,
  /** Half window limits in ms. */
  MIN_HALF: 14,
  MAX_HALF: 70,
  /**
   * The window also stops at samples farther than this from the centre sample: where the pen
   * slows down into a corner the time window grows, and without this it would reach round the
   * corner and cut it.
   */
  CHORD: 6,
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
  /** Prediction never reaches further than this (px): a pen can lift at any moment. */
  PREDICT_MAX_PX: 3,
  /** No prediction below this speed (px/ms). */
  PREDICT_MIN_SPEED: 0.12,
  /** Lift-off trimming: force fraction of the stroke median, and the most that is trimmed. */
  LIFT_FORCE: 0.5,
  LIFT_MS: 30,
  LIFT_PX: 18,
  /** No prediction once the force falls under this share of its recent peak (the pen is lifting). */
  PREDICT_FORCE_DROP: 0.85,
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
  /** Half window (ms) of the fit at this sample. */
  h: number;
  /** Distance limit (px) of the fit at this sample. */
  cr: number;
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
  /** Known forces, sorted (median of the stroke's force). */
  private forces: number[] = [];

  add(x: number, y: number, t: number, p: number): void {
    if (Number.isNaN(this.t0)) this.t0 = t;
    let tt = t - this.t0;
    const last = this.raw[this.raw.length - 1];
    if (last && tt <= last.t) tt = last.t + 0.25;
    const f = p > 0 ? Math.min(1, p) : 0;
    this.raw.push({ x, y, t: tt, f });
    if (f > 0) {
      const fs = this.forces;
      let lo = 0, hi = fs.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (fs[mid] < f) lo = mid + 1;
        else hi = mid;
      }
      fs.splice(lo, 0, f);
    }
    this.settle(false);
  }

  /** Settles everything (the pen has lifted); the lift-off samples are dropped. */
  finish(): ModeledPoint[] {
    // Settled ink stays (it is already drawn); everything after the ink end goes.
    this.raw.length = Math.max(this.inkEnd(), this.anchors.length, 1);
    this.settle(true);
    this.emit(true);
    return this.points;
  }

  /**
   * Number of samples that are ink: the trailing samples after it are the lift-off (force under
   * LIFT_FORCE of the median, within the last LIFT_MS and LIFT_PX) and may be dropped.
   */
  private inkEnd(): number {
    const r = this.raw, n = r.length, fs = this.forces;
    if (!fs.length) return n;
    // A sample without force is the pen in the air: never ink, however far away it is. (At speed
    // the Pencil can lift with its force still high and report the lift 15-25 ms later, tens of
    // px further on: that drew a straight line out to the pen in the air.)
    let k = n;
    while (k > 1 && !(r[k - 1].f > 0)) k--;
    if (k < 6) return k;
    const limit = NIB.LIFT_FORCE * fs[fs.length >> 1];
    const tEnd = r[k - 1].t;
    let len = 0;
    while (k > 4) {
      const i = k - 1;
      if (r[i].f >= limit || tEnd - r[i].t > NIB.LIFT_MS) break;
      len += Math.hypot(r[i].x - r[i - 1].x, r[i].y - r[i - 1].y);
      if (len > NIB.LIFT_PX) break;
      k--;
    }
    return k;
  }

  /**
   * The provisional rest of the stroke after `points`: the unsettled anchors and, with `predict`,
   * the predicted continuation. Recomputed every frame, never stored.
   */
  tail(predict = false): ModeledPoint[] {
    if (!this.raw.length) return [];
    // Possible lift-off samples are not drawn.
    const n = this.inkEnd();
    const provisional: Anchor[] = [];
    let env = this.env;
    const latest = this.raw[this.raw.length - 1].t;
    for (let i = this.anchors.length; i < n; i++) {
      const a = this.fitAnchor(i, provisional, env);
      env = a.p;
      const q = this.provisional(a.x, a.y, this.raw[i].x, this.raw[i].y, a.t, a.h, latest);
      provisional.push({ ...a, x: q.x, y: q.y });
    }
    const all = provisional.length ? this.anchors.concat(provisional) : this.anchors;
    const out: ModeledPoint[] = [];
    for (let i = Math.max(1, this.emitted); i < all.length; i++) this.segment(all, i, true, out, i >= this.anchors.length - 1 ? latest : null);
    if (this.emitted === 0 && all.length) out.unshift(this.point(all[0]));
    if (predict && n === this.raw.length && all.length) out.push(...this.predict(all[all.length - 1]));
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
    // Samples that may be the lift-off wait: once ink, they settle; if the pen lifts, they go.
    const end = final ? r.length : this.inkEnd();
    while (this.anchors.length < end) {
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
    // The distance limit guards corners, where the pen slows down and the time window grows; at
    // speed it must not shrink the window below its time span.
    const cr = Math.max(NIB.CHORD, 1.2 * this.speedAt(i) * h);
    const pos = this.smoothAt(ti, r[i].x, r[i].y, i, h, cr);

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
    return { x: pos.x, y: pos.y, t: ti, p, h, cr };
  }

  /**
   * The smoothed pen position at time t: a local fit around sample `c` (the sample nearest t),
   * weighted by time (half width h) and by distance from (cx, cy), the raw pen position at t.
   * Both weights fade to zero at the edge of the window, so the curve is continuous and smooth
   * in t: samples never switch on or off abruptly.
   */
  private smoothAt(t: number, cx: number, cy: number, c: number, h: number, cr: number): { x: number; y: number } {
    const r = this.raw;
    const near = (j: number) => Math.hypot(r[j].x - cx, r[j].y - cy) < cr;
    let a = c, b = c;
    while (a > 0 && t - r[a - 1].t < h && near(a - 1)) a--;
    while (b < r.length - 1 && r[b + 1].t - t < h && near(b + 1)) b++;
    return fitAt(r, a, b, t, h, cx, cy, cr);
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

  /**
   * The curve from A[i-1] to A[i] (one sample interval), appended without its first point: the
   * smoothed position evaluated every STEP px along the way, not a spline through the anchors
   * (a spline through one point per sample bends at every point: visible as a fine wiggle).
   */
  private segment(A: Anchor[], i: number, _last: boolean, out: ModeledPoint[], latest: number | null = null) {
    const p1 = A[i - 1], p2 = A[i];
    const r = this.raw;
    const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const n = Math.max(1, Math.ceil(len / NIB.STEP));
    for (let s = 1; s < n; s++) {
      const f = s / n;
      const t = p1.t + (p2.t - p1.t) * f;
      const cx = r[i - 1].x + (r[i].x - r[i - 1].x) * f, cy = r[i - 1].y + (r[i].y - r[i - 1].y) * f;
      const h = p1.h + (p2.h - p1.h) * f;
      let q = this.smoothAt(t, cx, cy, f < 0.5 ? i - 1 : i, h, p1.cr + (p2.cr - p1.cr) * f);
      if (latest !== null) q = this.provisional(q.x, q.y, cx, cy, t, h, latest);
      out.push({ x: q.x, y: q.y, p: p1.p + (p2.p - p1.p) * f, t });
    }
    out.push(this.point(p2));
  }

  /**
   * Unsettled ink near the pen: the fit at time t is still missing its future samples and would
   * swing from frame to frame (the tip wagging on fast strokes). It is shown as a blend from the
   * raw pen position (which never moves) towards the fit, by how much of its window has arrived,
   * so the ink settles into its final shape gradually instead of jumping.
   */
  private provisional(fx: number, fy: number, rx: number, ry: number, t: number, h: number, latest: number): { x: number; y: number } {
    const c = Math.max(0, Math.min(1, (latest - t) / Math.max(1e-6, h)));
    const k = c * c * (3 - 2 * c);
    return { x: rx + (fx - rx) * k, y: ry + (fy - ry) * k };
  }

  // ----------------------------------------------------------------------------------- prediction
  private predict(from: Anchor): ModeledPoint[] {
    const r = this.raw;
    const n = r.length;
    // At least ~25 ms of stroke: the first samples alone are too few to extrapolate from.
    if (n < 7) return [];
    const tl = r[n - 1].t;
    let a = n - 1;
    while (a > 0 && tl - r[a - 1].t <= NIB.PREDICT_WIN) a--;
    if (n - a < 4) return [];
    // The force is falling: the pen may be lifting, and ink must not run on past the lift.
    let peak = 0;
    for (let j = a; j < n; j++) peak = Math.max(peak, r[j].f);
    if (peak > 0 && r[n - 1].f < NIB.PREDICT_FORCE_DROP * peak) return [];
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
    // Never further than the pen went in the same time just before (a bound on the acceleration).
    const reach = Math.min(NIB.PREDICT_MAX_PX, travelled * horizon * 1.25);
    const out: ModeledPoint[] = [];
    const steps = Math.max(1, Math.ceil(horizon / 2));
    for (let s = 1; s <= steps; s++) {
      const tau = (horizon * s) / steps;
      const k = 0.5 * NIB.ACCEL * tau * tau;
      const q = { x: from.x + m.vx * tau + k * m.ax, y: from.y + m.vy * tau + k * m.ay, p: from.p, t: from.t + tau };
      if (Math.hypot(q.x - from.x, q.y - from.y) > reach) break;
      out.push(q);
    }
    return out;
  }
}

/**
 * Weighted local polynomial fit of samples a..b around time tc (tricube weights, half width h):
 * quadratic when there are samples on both sides, linear at the ends of the data (lower variance
 * where the window is one-sided), the sample itself when nothing else is near.
 */
function fitAt(r: Raw[], a: number, b: number, tc: number, h: number, cx: number, cy: number, cr: number): { x: number; y: number } {
  if (a === b) return { x: r[a].x, y: r[a].y };
  let before = 0, after = 0;
  for (let j = a; j <= b; j++) {
    if (r[j].t < tc - 1e-6) before++;
    else if (r[j].t > tc + 1e-6) after++;
  }
  const degree = before >= 2 && after >= 2 ? 2 : 1;
  const c = polyFit(r, a, b, tc, h, degree, { x: cx, y: cy, r: cr });
  return { x: c.x[0], y: c.y[0] };
}

/** Velocity and acceleration at tc from a one-sided quadratic fit over a..b. */
export function motionAt(r: Raw[], a: number, b: number, tc: number, h: number) {
  const c = polyFit(r, a, b, tc, h * 1.2, b - a >= 3 ? 2 : 1);
  // Coefficients are in u = (t - tc) / h.
  const sh = h * 1.2;
  return { vx: c.x[1] / sh, vy: c.y[1] / sh, ax: (2 * (c.x[2] ?? 0)) / (sh * sh), ay: (2 * (c.y[2] ?? 0)) / (sh * sh) };
}

export function polyFit(r: Raw[], a: number, b: number, tc: number, h: number, degree: 1 | 2, near?: { x: number; y: number; r: number }) {
  const m = degree + 1;
  const S = new Float64Array(2 * m - 1);
  const X = new Float64Array(m), Y = new Float64Array(m);
  for (let j = a; j <= b; j++) {
    const u = (r[j].t - tc) / h;
    let w = tricube(u * 0.999);
    if (near) w *= tricube((0.999 * Math.hypot(r[j].x - near.x, r[j].y - near.y)) / near.r);
    w += 1e-9;
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
