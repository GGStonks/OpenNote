/**
 * Curve geometry shared by the renderer, the SVG export and the TikZ export, so that all three
 * describe exactly the same shape.
 *
 *  - catmullRomBeziers: PDEDraw's "master spline engine" (centripetal Catmull-Rom, alpha 0.5,
 *    Path+Spline.swift) expressed as cubic Bezier segments. The smart pen stores the spline's
 *    control points; every consumer converts them with this function.
 *  - fitBeziers: least-squares cubic Bezier fitting (Schneider, "An Algorithm for Automatically
 *    Fitting Digitized Curves", Graphics Gems 1990) used to turn freehand ink into a few exact
 *    `.. controls ..` segments instead of a polyline.
 */

export interface XY {
  x: number;
  y: number;
}

/** A cubic Bezier segment: start, control 1, control 2, end. */
export type Bezier = [XY, XY, XY, XY];

const sub = (a: XY, b: XY): XY => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: XY, b: XY): XY => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: XY, k: number): XY => ({ x: a.x * k, y: a.y * k });
const dot = (a: XY, b: XY) => a.x * b.x + a.y * b.y;
const len = (a: XY) => Math.hypot(a.x, a.y);
const dist = (a: XY, b: XY) => Math.hypot(a.x - b.x, a.y - b.y);
const norm = (a: XY): XY => {
  const l = len(a);
  return l > 1e-9 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 };
};

/** Drops consecutive duplicates (they make the centripetal parametrisation degenerate). */
function dedupe(points: XY[], closed: boolean): XY[] {
  const out: XY[] = [];
  for (const p of points) if (!out.length || dist(out[out.length - 1], p) > 0.01) out.push({ x: p.x, y: p.y });
  if (closed) while (out.length > 2 && dist(out[0], out[out.length - 1]) < 0.01) out.pop();
  return out;
}

/** Centripetal Catmull-Rom spline through `points` as cubic Bezier segments (identical to PDEDraw). */
export function catmullRomBeziers(input: XY[], closed: boolean): Bezier[] {
  const pts = dedupe(input, closed);
  const n = pts.length;
  if (n < 2) return [];
  if (n === 2) {
    const [a, b] = pts;
    return [[a, { x: a.x + (b.x - a.x) / 3, y: a.y + (b.y - a.y) / 3 }, { x: a.x + (2 * (b.x - a.x)) / 3, y: a.y + (2 * (b.y - a.y)) / 3 }, b]];
  }
  const alpha = 0.5;
  const out: Bezier[] = [];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p1 = pts[i % n];
    const p2 = pts[(i + 1) % n];
    const p0 = closed ? pts[(i - 1 + n) % n] : i === 0 ? { x: 2 * p1.x - p2.x, y: 2 * p1.y - p2.y } : pts[i - 1];
    const p3 = closed ? pts[(i + 2) % n] : i >= n - 2 ? { x: 2 * p2.x - p1.x, y: 2 * p2.y - p1.y } : pts[i + 2];
    const d1 = Math.max(1e-4, dist(p0, p1));
    const d2 = Math.max(1e-4, dist(p1, p2));
    const d3 = Math.max(1e-4, dist(p2, p3));
    const t1 = Math.pow(d1, alpha), t2 = Math.pow(d2, alpha), t3 = Math.pow(d3, alpha);
    const t12 = t1 + t2, t23 = t2 + t3;
    const m1x = (p1.x - p0.x) / t1 - (p2.x - p0.x) / t12;
    const m1y = (p1.y - p0.y) / t1 - (p2.y - p0.y) / t12;
    const m2x = (p3.x - p2.x) / t3 - (p3.x - p1.x) / t23;
    const m2y = (p3.y - p2.y) / t3 - (p3.y - p1.y) / t23;
    const dx2 = p2.x - p1.x, dy2 = p2.y - p1.y;
    out.push([
      p1,
      { x: p1.x + (dx2 + t2 * m1x) / 3, y: p1.y + (dy2 + t2 * m1y) / 3 },
      { x: p2.x - (dx2 + t2 * m2x) / 3, y: p2.y - (dy2 + t2 * m2y) / 3 },
      p2,
    ]);
  }
  return out;
}

export function bezierPoint(b: Bezier, t: number): XY {
  const mt = 1 - t;
  const a = mt * mt * mt, c1 = 3 * mt * mt * t, c2 = 3 * mt * t * t, d = t * t * t;
  return { x: a * b[0].x + c1 * b[1].x + c2 * b[2].x + d * b[3].x, y: a * b[0].y + c1 * b[1].y + c2 * b[2].y + d * b[3].y };
}

/** Points along Bezier segments (for hit-testing and polygon tests), about one every `step` units. */
export function flattenBeziers(segs: Bezier[], step = 3): XY[] {
  const out: XY[] = [];
  for (const b of segs) {
    const l = dist(b[0], b[1]) + dist(b[1], b[2]) + dist(b[2], b[3]);
    const n = Math.max(2, Math.ceil(l / step));
    for (let i = out.length ? 1 : 0; i <= n; i++) out.push(bezierPoint(b, i / n));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Bezier fitting (Schneider).

function bezierD1(b: Bezier, t: number): XY {
  const mt = 1 - t;
  return add(add(mul(sub(b[1], b[0]), 3 * mt * mt), mul(sub(b[2], b[1]), 6 * mt * t)), mul(sub(b[3], b[2]), 3 * t * t));
}

function bezierD2(b: Bezier, t: number): XY {
  return add(mul(add(sub(b[2], mul(b[1], 2)), b[0]), 6 * (1 - t)), mul(add(sub(b[3], mul(b[2], 2)), b[1]), 6 * t));
}

function chordParams(pts: XY[]): number[] {
  const u = [0];
  for (let i = 1; i < pts.length; i++) u.push(u[i - 1] + dist(pts[i], pts[i - 1]));
  const total = u[u.length - 1] || 1;
  return u.map((v) => v / total);
}

function generateBezier(pts: XY[], u: number[], tHat1: XY, tHat2: XY): Bezier {
  const first = pts[0], last = pts[pts.length - 1];
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let i = 0; i < pts.length; i++) {
    const t = u[i], mt = 1 - t;
    const b0 = mt * mt * mt, b1 = 3 * mt * mt * t, b2 = 3 * mt * t * t, b3 = t * t * t;
    const a1 = mul(tHat1, b1), a2 = mul(tHat2, b2);
    c00 += dot(a1, a1);
    c01 += dot(a1, a2);
    c11 += dot(a2, a2);
    const tmp = sub(pts[i], add(mul(first, b0 + b1), mul(last, b2 + b3)));
    x0 += dot(a1, tmp);
    x1 += dot(a2, tmp);
  }
  const det = c00 * c11 - c01 * c01;
  let alpha1 = det !== 0 ? (x0 * c11 - x1 * c01) / det : 0;
  let alpha2 = det !== 0 ? (c00 * x1 - c01 * x0) / det : 0;
  const segLen = dist(first, last);
  const eps = 1e-6 * segLen;
  if (alpha1 < eps || alpha2 < eps || alpha1 > segLen * 2 || alpha2 > segLen * 2) alpha1 = alpha2 = segLen / 3;
  return [first, add(first, mul(tHat1, alpha1)), add(last, mul(tHat2, alpha2)), last];
}

function reparameterize(b: Bezier, pts: XY[], u: number[]): number[] {
  return u.map((t, i) => {
    const d = sub(bezierPoint(b, t), pts[i]);
    const d1 = bezierD1(b, t), d2 = bezierD2(b, t);
    const den = dot(d1, d1) + dot(d, d2);
    if (Math.abs(den) < 1e-12) return t;
    return Math.max(0, Math.min(1, t - dot(d, d1) / den));
  });
}

function maxError(b: Bezier, pts: XY[], u: number[]): { err: number; index: number } {
  let err = 0, index = Math.floor(pts.length / 2);
  for (let i = 1; i < pts.length - 1; i++) {
    const d = dist(bezierPoint(b, u[i]), pts[i]);
    if (d > err) { err = d; index = i; }
  }
  return { err, index };
}

function fitCubic(pts: XY[], tHat1: XY, tHat2: XY, tol: number, out: Bezier[], depth: number) {
  if (pts.length === 2) {
    const l = dist(pts[0], pts[1]) / 3;
    out.push([pts[0], add(pts[0], mul(tHat1, l)), add(pts[1], mul(tHat2, l)), pts[1]]);
    return;
  }
  let u = chordParams(pts);
  let b = generateBezier(pts, u, tHat1, tHat2);
  let { err, index } = maxError(b, pts, u);
  if (err <= tol) { out.push(b); return; }
  if (err <= tol * 4) {
    for (let k = 0; k < 6; k++) {
      u = reparameterize(b, pts, u);
      b = generateBezier(pts, u, tHat1, tHat2);
      ({ err, index } = maxError(b, pts, u));
      if (err <= tol) { out.push(b); return; }
    }
  }
  if (depth > 24) { out.push(b); return; }
  index = Math.max(1, Math.min(pts.length - 2, index));
  const center = norm(sub(pts[index - 1], pts[index + 1]));
  fitCubic(pts.slice(0, index + 1), tHat1, center, tol, out, depth + 1);
  fitCubic(pts.slice(index), mul(center, -1), tHat2, tol, out, depth + 1);
}

/**
 * Fits cubic Beziers to a sampled curve with maximum deviation `tol` (same units as the points).
 * Closed curves are fitted from their first point back to it.
 */
export function fitBeziers(input: XY[], tol: number, closed = false): Bezier[] {
  const pts = dedupe(input, false);
  if (closed && pts.length > 2 && dist(pts[0], pts[pts.length - 1]) > 0.01) pts.push(pts[0]);
  if (pts.length < 2) return [];
  const n = pts.length;
  const tangent = (a: XY, b: XY) => norm(sub(b, a));
  let t1: XY, t2: XY;
  if (closed && n > 3) {
    const c = norm(sub(pts[1], pts[n - 2]));
    t1 = c;
    t2 = mul(c, -1);
  } else {
    t1 = tangent(pts[0], pts[Math.min(n - 1, 2)]);
    t2 = tangent(pts[n - 1], pts[Math.max(0, n - 3)]);
  }
  const out: Bezier[] = [];
  fitCubic(pts, t1, t2, tol, out, 0);
  return out;
}

/** Direction of the curve at its end (for arrowheads): from the last control handle to the end point. */
export function endTangent(segs: Bezier[]): { tip: XY; from: XY } | null {
  const last = segs[segs.length - 1];
  if (!last) return null;
  for (const c of [last[2], last[1], last[0]]) if (dist(c, last[3]) > 0.5) return { tip: last[3], from: c };
  return null;
}
