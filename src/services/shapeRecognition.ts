import { FillType, Point, Stroke, ShapeKind } from '../types';
import { Bezier, catmullRomBeziers, fitBeziers, XY } from '../ink/spline';
import { arrowSize, strokeLine } from '../ink/strokeRenderer';
import { latexForDocument } from './latexRender';

/**
 * Shape snapping.
 *
 * Several independent detectors (line, arrow, ellipse, polygon, open polyline) each produce a
 * candidate with a confidence; the best candidate wins and is only accepted above a threshold.
 */

export interface SnappedShape {
  kind: ShapeKind;
  points: Point[];
  closed: boolean;
  confidence: number;
  /** A regular polygon (equilateral triangle, square, regular pentagon…): sized keeping it regular. */
  regular?: boolean;
  /** How far the line drawn lies from the shape (a share of its size), to compare detectors. */
  fitError?: number;
}

const P = (x: number, y: number, pressure = 0.5): Point => ({ x, y, pressure });

function pathLength(pts: Point[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return l;
}

function resample(pts: Point[], n: number): Point[] {
  const total = pathLength(pts);
  if (total === 0 || pts.length < 2) return pts.slice();
  const step = total / (n - 1);
  const out: Point[] = [pts[0]];
  let acc = 0;
  let prev = pts[0];
  for (let i = 1; i < pts.length; i++) {
    let cur = pts[i];
    let d = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    while (acc + d >= step && d > 0) {
      const t = (step - acc) / d;
      const q = P(prev.x + (cur.x - prev.x) * t, prev.y + (cur.y - prev.y) * t, prev.pressure);
      out.push(q);
      prev = q;
      d = Math.hypot(cur.x - prev.x, cur.y - prev.y);
      acc = 0;
    }
    acc += d;
    prev = cur;
  }
  while (out.length < n) out.push(pts[pts.length - 1]);
  return out.slice(0, n);
}

function distToSeg(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function rdp(pts: Point[], eps: number): Point[] {
  if (pts.length < 3) return pts.slice();
  let maxD = 0;
  let idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = distToSeg(pts[i], pts[0], pts[pts.length - 1]);
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD <= eps) return [pts[0], pts[pts.length - 1]];
  const left = rdp(pts.slice(0, idx + 1), eps);
  const right = rdp(pts.slice(idx), eps);
  return [...left.slice(0, -1), ...right];
}

function polylineError(pts: Point[], poly: Point[], closed: boolean): number {
  const segs: [Point, Point][] = [];
  for (let i = 1; i < poly.length; i++) segs.push([poly[i - 1], poly[i]]);
  if (closed) segs.push([poly[poly.length - 1], poly[0]]);
  let sum = 0;
  for (const p of pts) {
    let best = Infinity;
    for (const [a, b] of segs) best = Math.min(best, distToSeg(p, a, b));
    sum += best;
  }
  return sum / pts.length;
}

function angleAt(a: Point, b: Point, c: Point): number {
  const v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y;
  const m = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
  if (!m) return Math.PI;
  return Math.acos(Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / m)));
}

function bbox(pts: Point[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY, diag: Math.hypot(maxX - minX, maxY - minY) };
}

// --- detectors -------------------------------------------------------------------------------

function detectLine(pts: Point[], len: number): SnappedShape | null {
  const a = pts[0];
  const b = pts[pts.length - 1];
  const chord = Math.hypot(b.x - a.x, b.y - a.y);
  if (chord < 12) return null;
  let maxDev = 0;
  for (const p of pts) maxDev = Math.max(maxDev, distToSeg(p, a, b));
  const rel = maxDev / chord;
  const straightness = chord / len;
  // Forgiving: a slightly bowed or wobbly line still becomes a straight one.
  if (rel > 0.11 || straightness < 0.86) return null;
  // Snap near-horizontal / vertical lines.
  let end = b;
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const snapTol = (4 * Math.PI) / 180;
  for (const target of [0, Math.PI / 2, Math.PI, -Math.PI / 2, -Math.PI]) {
    if (Math.abs(ang - target) < snapTol) {
      end = Math.abs(Math.sin(target)) > 0.5 ? P(a.x, b.y) : P(b.x, a.y);
    }
  }
  return { kind: 'line', points: [P(a.x, a.y), P(end.x, end.y)], closed: false, confidence: 1 - rel / 0.11 * 0.8 };
}

/**
 * A parabola: an open line that bends one way and fits y = a x² + b x + c in some turned frame
 * (its axis any way round; snapped upright or level when within PARABOLA_AXIS_SNAP). The line must
 * run one way along the parabola (no going back), bend clearly (its sagitta at least
 * PARABOLA_BEND of its chord; lines are found before) and fit within PARABOLA_FIT of its size. A
 * line with a corner (a wide V) fits a few straight sides better than a parabola: detectShape
 * keeps the better fit of the two.
 * Kept as a smooth curve ('curve') through PARABOLA_POINTS points of it.
 */
const PARABOLA_FIT = 0.022;
const PARABOLA_BEND = 0.07;
const PARABOLA_AXIS_SNAP = (8 * Math.PI) / 180;
const PARABOLA_POINTS = 9;

function fitParabola(pts: Point[], ang: number) {
  const c = Math.cos(ang), s = Math.sin(ang);
  // u across the axis, v along it.
  const uv = pts.map((p) => [p.x * c + p.y * s, -p.x * s + p.y * c]);
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0;
  for (const [u, v] of uv) {
    const u2 = u * u;
    s0++; s1 += u; s2 += u2; s3 += u2 * u; s4 += u2 * u2;
    t0 += v; t1 += u * v; t2 += u2 * v;
  }
  // Normal equations for v = A u² + B u + C (Cramer's rule).
  const det3 = (m: number[]) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  const M = [s4, s3, s2, s3, s2, s1, s2, s1, s0];
  const d = det3(M);
  if (!Number.isFinite(d) || Math.abs(d) < 1e-9) return null;
  const A = det3([t2, s3, s2, t1, s2, s1, t0, s1, s0]) / d;
  const B = det3([s4, t2, s2, s3, t1, s1, s2, t0, s0]) / d;
  const C = det3([s4, s3, t2, s3, s2, t1, s2, s1, t0]) / d;
  let err = 0;
  for (const [u, v] of uv) err += (v - (A * u * u + B * u + C)) ** 2;
  return { A, B, C, c, s, uv, rms: Math.sqrt(err / uv.length) };
}

function detectParabola(pts: Point[], diag: number): SnappedShape | null {
  if (diag < 24) return null;
  const a = pts[0], b = pts[pts.length - 1];
  const chord = Math.hypot(b.x - a.x, b.y - a.y);
  let sag = 0;
  for (const p of pts) sag = Math.max(sag, distToSeg(p, a, b));
  if (sag < PARABOLA_BEND * Math.max(chord, 1)) return null;
  // The best axis direction, every 2°, then the nearest upright / level one if close.
  let best: ReturnType<typeof fitParabola> = null, bestAng = 0;
  for (let deg = 0; deg < 180; deg += 2) {
    const f = fitParabola(pts, (deg * Math.PI) / 180);
    if (f && (!best || f.rms < best.rms)) [best, bestAng] = [f, (deg * Math.PI) / 180];
  }
  if (!best) return null;
  for (const t of [0, Math.PI / 2, Math.PI]) {
    if (Math.abs(bestAng - t) < PARABOLA_AXIS_SNAP) {
      const f = fitParabola(pts, t % Math.PI);
      if (f && f.rms < best.rms * 1.25 + 0.002 * diag) [best, bestAng] = [f, t % Math.PI];
    }
  }
  const f = best;
  if (f.rms / diag > PARABOLA_FIT || Math.abs(f.A) < 1e-9) return null;
  // One way along it: the drawn line's travel across the axis is (nearly) its span.
  let travel = 0;
  for (let i = 1; i < f.uv.length; i++) travel += Math.abs(f.uv[i][0] - f.uv[i - 1][0]);
  const u0 = f.uv[0][0], u1 = f.uv[f.uv.length - 1][0];
  if (travel > 1.12 * Math.abs(u1 - u0) || Math.abs(u1 - u0) < 0.3 * diag) return null;
  const out = Array.from({ length: PARABOLA_POINTS }, (_, i) => {
    const u = u0 + ((u1 - u0) * i) / (PARABOLA_POINTS - 1);
    const v = f.A * u * u + f.B * u + f.C;
    return P(u * f.c - v * f.s, u * f.s + v * f.c);
  });
  // How far the line drawn is from the parabola, measured as polylines are (polylineError).
  const dense = Array.from({ length: 49 }, (_, i) => {
    const u = u0 + ((u1 - u0) * i) / 48;
    const v = f.A * u * u + f.B * u + f.C;
    return P(u * f.c - v * f.s, u * f.s + v * f.c);
  });
  const err = polylineError(pts, dense, false) / diag;
  return { kind: 'curve', points: out, closed: false, confidence: 1 - f.rms / diag / PARABOLA_FIT, fitError: err };
}

function detectArrow(pts: Point[], diag: number): SnappedShape | null {
  // Single-stroke arrow: a long shaft followed by a head drawn without lifting the pen.
  const v = rdp(pts, Math.max(4, diag * 0.05));
  if (v.length < 4 || v.length > 6) return null;
  const shaftLen = Math.hypot(v[1].x - v[0].x, v[1].y - v[0].y);
  const total = pathLength(v);
  if (shaftLen < 0.45 * total || shaftLen < 30) return null;
  const tip = v[1];
  const dir = Math.atan2(v[1].y - v[0].y, v[1].x - v[0].x);
  const wings: { p: Point; side: number }[] = [];
  for (const w of v.slice(2)) {
    const d = Math.hypot(w.x - tip.x, w.y - tip.y);
    if (d < 0.06 * shaftLen || d > 0.6 * shaftLen) continue;
    const back = Math.atan2(w.y - tip.y, w.x - tip.x) - (dir + Math.PI);
    const rel = Math.atan2(Math.sin(back), Math.cos(back));
    if (Math.abs(rel) > (12 * Math.PI) / 180 && Math.abs(rel) < (80 * Math.PI) / 180) wings.push({ p: w, side: Math.sign(rel) });
  }
  const left = wings.find((w) => w.side > 0);
  const right = wings.find((w) => w.side < 0);
  if (!left || !right) return null;
  const headLen = Math.min(shaftLen * 0.3, (Math.hypot(left.p.x - tip.x, left.p.y - tip.y) + Math.hypot(right.p.x - tip.x, right.p.y - tip.y)) / 2);
  const spread = (28 * Math.PI) / 180;
  const w1 = P(tip.x + headLen * Math.cos(dir + Math.PI - spread), tip.y + headLen * Math.sin(dir + Math.PI - spread));
  const w2 = P(tip.x + headLen * Math.cos(dir + Math.PI + spread), tip.y + headLen * Math.sin(dir + Math.PI + spread));
  return { kind: 'arrow', points: [P(v[0].x, v[0].y), P(tip.x, tip.y), w1, P(tip.x, tip.y), w2], closed: false, confidence: 0.8 };
}

function detectEllipse(pts: Point[], diag: number): SnappedShape | null {
  const n = pts.length;
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p.x; cy += p.y; }
  cx /= n; cy /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of pts) {
    const dx = p.x - cx, dy = p.y - cy;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  sxx /= n; syy /= n; sxy /= n;
  const tr = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc;
  const l2 = tr / 2 - disc;
  let theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let a = Math.sqrt(2 * l1);
  let b = Math.sqrt(2 * Math.max(l2, 0));
  if (a < 8 || b < 4) return null;
  let err = 0;
  const c = Math.cos(theta), s = Math.sin(theta);
  for (const p of pts) {
    const dx = p.x - cx, dy = p.y - cy;
    const u = (dx * c + dy * s) / a;
    const w = (-dx * s + dy * c) / b;
    err += Math.abs(Math.hypot(u, w) - 1);
  }
  err /= n;
  if (err > 0.16) return null;
  let kind: ShapeKind = 'ellipse';
  if (b / a > 0.86) {
    a = b = (a + b) / 2;
    theta = 0;
    kind = 'circle';
  } else {
    // Snap near-axis-aligned ellipses.
    const deg = ((theta * 180) / Math.PI + 180) % 90;
    if (deg < 7 || deg > 83) theta = Math.round(theta / (Math.PI / 2)) * (Math.PI / 2);
  }
  const out: Point[] = [];
  const steps = 72;
  const ct = Math.cos(theta), st = Math.sin(theta);
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const x = a * Math.cos(t), y = b * Math.sin(t);
    out.push(P(cx + x * ct - y * st, cy + x * st + y * ct));
  }
  void diag;
  return { kind, points: out, closed: true, confidence: 1 - err / 0.16 };
}

/** A corner flatter than this (degrees) is not a corner: the side was just drawn a little bowed. */
const STRAIGHT_CORNER = 150;
/** A side shorter than this share of the outline is a slip of the pen (e.g. at the closing point). */
const MIN_SIDE = 0.07;

/**
 * Removes vertices that do not make a shape: corners on a nearly straight run (a bowed side
 * came out as two sides) and very short sides (the pen ending a little past or short of the start
 * left a tiny extra side there).
 */
function cleanVertices(v: Point[], closed: boolean): Point[] {
  let out = v.slice();
  const flat = (STRAIGHT_CORNER * Math.PI) / 180;
  for (let changed = true; changed && out.length > (closed ? 3 : 2); ) {
    changed = false;
    const n = out.length;
    let perim = 0;
    for (let i = closed ? 0 : 1; i < n; i++) perim += Math.hypot(out[i].x - out[(i - 1 + n) % n].x, out[i].y - out[(i - 1 + n) % n].y);
    // Flattest corner first.
    let worst = -1, worstAng = flat;
    for (let i = closed ? 0 : 1; i < (closed ? n : n - 1); i++) {
      const a = angleAt(out[(i - 1 + n) % n], out[i], out[(i + 1) % n]);
      if (a > worstAng) { worstAng = a; worst = i; }
    }
    if (worst >= 0) {
      out.splice(worst, 1);
      changed = true;
      continue;
    }
    // Shortest side next: its two ends become one vertex.
    let short = -1, shortLen = MIN_SIDE * perim;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const a = out[i], b = out[(i + 1) % n];
      const l = Math.hypot(b.x - a.x, b.y - a.y);
      if (l < shortLen) { shortLen = l; short = i; }
    }
    if (short >= 0) {
      const j = (short + 1) % n;
      if (!closed && short === 0) out.splice(1, 1);
      else if (!closed && j === n - 1) out.splice(short, 1);
      else {
        out[short] = P((out[short].x + out[j].x) / 2, (out[short].y + out[j].y) / 2);
        out.splice(j, 1);
      }
      changed = true;
    }
  }
  return out;
}

/**
 * A closed polygon drawn nearly regular becomes the regular polygon: an equilateral triangle, a
 * square, a regular pentagon, hexagon… The candidate is the regular polygon of the drawing's own
 * centre, perimeter and turn (the corners' directions averaged n-fold, so one corner found a little
 * off does not turn it); it is taken when the corners found are nearly regular (the longest side
 * at most REGULAR_RATIO x the shortest, every corner within REGULAR_CORNER of the regular one: a
 * 1.25 : 1 rectangle stays a rectangle) or when it
 * fits the line drawn within REGULAR_FIT (a corner found off where the pen started and ended made
 * a drawn regular hexagon fail the first test). Turned to stand on a side (or a corner up) when
 * within REGULAR_TURN of it.
 */
const REGULAR_RATIO = 1.16;
const REGULAR_CORNER = (13 * Math.PI) / 180;
const REGULAR_FIT = 0.026;
const REGULAR_TURN = (9 * Math.PI) / 180;

function regularPolygon(v: Point[], pts: Point[], diag: number): Point[] | null {
  const n = v.length;
  if (n < 3) return null;
  const sides = v.map((p, i) => Math.hypot(v[(i + 1) % n].x - p.x, v[(i + 1) % n].y - p.y));
  const corner = (Math.PI * (n - 2)) / n;
  const nearlyRegular =
    Math.min(...sides) > 0 &&
    Math.max(...sides) <= REGULAR_RATIO * Math.min(...sides) &&
    v.every((p, i) => Math.abs(angleAt(v[(i - 1 + n) % n], p, v[(i + 1) % n]) - corner) <= REGULAR_CORNER);
  // Centre and size from the line drawn (evenly spaced points): its mean and its perimeter.
  let cx = 0, cy = 0, len = 0;
  for (let i = 0; i < pts.length; i++) {
    cx += pts[i].x / pts.length;
    cy += pts[i].y / pts.length;
    const q = pts[(i + 1) % pts.length];
    len += Math.hypot(q.x - pts[i].x, q.y - pts[i].y);
  }
  let area = 0, sx = 0, sy = 0;
  for (let i = 0; i < n; i++) {
    area += v[i].x * v[(i + 1) % n].y - v[(i + 1) % n].x * v[i].y;
    const a = n * Math.atan2(v[i].y - cy, v[i].x - cx);
    sx += Math.cos(a);
    sy += Math.sin(a);
  }
  let phase = Math.atan2(sy, sx) / n;
  // Standing on a side or on a corner (a corner straight up, or a side flat on top): every π/n.
  const up = -Math.PI / 2, every = Math.PI / n;
  const snapped = up + Math.round((phase - up) / every) * every;
  if (Math.abs(phase - snapped) < REGULAR_TURN) phase = snapped;
  const step = (Math.sign(area) || 1) * ((2 * Math.PI) / n);
  const r = len / (2 * n * Math.sin(Math.PI / n));
  const out = Array.from({ length: n }, (_, i) => P(cx + r * Math.cos(phase + i * step), cy + r * Math.sin(phase + i * step)));
  return nearlyRegular || polylineError(pts, out, true) / diag <= REGULAR_FIT ? out : null;
}

function detectPolygon(pts: Point[], diag: number, closed: boolean): SnappedShape | null {
  const ring = closed ? [...pts, pts[0]] : pts;
  let v = rdp(ring, Math.max(5, diag * 0.085));
  if (closed) v = v.slice(0, -1);
  v = cleanVertices(v, closed);
  if (closed && (v.length < 3 || v.length > 8)) return null;
  if (!closed && (v.length < 3 || v.length > 6)) return null;
  const err = polylineError(pts, v, closed) / diag;
  if (err > (closed ? 0.05 : 0.035)) return null;

  let kind: ShapeKind = closed ? (v.length === 3 ? 'triangle' : 'polygon') : 'polyline';
  let out = v.map((p) => P(p.x, p.y));

  const regular = closed ? regularPolygon(v, pts, diag) : null;
  if (regular) return { kind: v.length === 4 ? 'rectangle' : kind, points: regular, closed, confidence: 1 - err / 0.05, regular: true };

  if (closed && v.length === 4) {
    const right = [0, 1, 2, 3].every((i) => Math.abs(angleAt(v[(i + 3) % 4], v[i], v[(i + 1) % 4]) - Math.PI / 2) < (18 * Math.PI) / 180);
    if (right) {
      kind = 'rectangle';
      // Orientation from the longest edge; snap to axis when close.
      let best = 0, ang = 0;
      for (let i = 0; i < 4; i++) {
        const a = v[i], b = v[(i + 1) % 4];
        const l = Math.hypot(b.x - a.x, b.y - a.y);
        if (l > best) { best = l; ang = Math.atan2(b.y - a.y, b.x - a.x); }
      }
      ang = ((ang % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
      if (ang < (8 * Math.PI) / 180 || ang > (82 * Math.PI) / 180) ang = 0;
      const c = Math.cos(ang), s = Math.sin(ang);
      let mx = 0, my = 0;
      for (const p of v) { mx += p.x / 4; my += p.y / 4; }
      let minU = Infinity, maxU = -Infinity, minW = Infinity, maxW = -Infinity;
      for (const p of pts) {
        const u = (p.x - mx) * c + (p.y - my) * s;
        const w = -(p.x - mx) * s + (p.y - my) * c;
        minU = Math.min(minU, u); maxU = Math.max(maxU, u);
        minW = Math.min(minW, w); maxW = Math.max(maxW, w);
      }
      const back = (u: number, w: number) => P(mx + u * c - w * s, my + u * s + w * c);
      out = [back(minU, minW), back(maxU, minW), back(maxU, maxW), back(minU, maxW)];
    }
  }
  return { kind, points: out, closed, confidence: 1 - err / 0.05 };
}

/** Runs all detectors on one stroke and returns the best accepted shape, or null. */
export function detectShape(points: Point[]): SnappedShape | null {
  if (points.length < 3) return null;
  const len = pathLength(points);
  if (len < 16) return null;
  let pts = resample(points, 96);
  const box = bbox(pts);
  // Closed when the pen comes back near the start, a little short of it or past it.
  const start = pts[0];
  let near = pts.length - 1;
  for (let i = Math.floor(pts.length * 0.6); i < pts.length; i++) {
    if (Math.hypot(pts[i].x - start.x, pts[i].y - start.y) < Math.hypot(pts[near].x - start.x, pts[near].y - start.y)) near = i;
  }
  const gap = Math.hypot(start.x - pts[near].x, start.y - pts[near].y);
  const closed = gap < Math.max(24, 0.28 * box.diag) && len > 2.2 * box.diag * 0.5;
  // An overshoot past the start is cut off, so it cannot become an extra side.
  if (closed && near < pts.length - 1) pts = resample(pts.slice(0, near + 1), 96);

  const candidates: SnappedShape[] = [];
  if (!closed) {
    const line = detectLine(pts, len);
    if (line) return line;
    // An arrow is also a valid open polyline; the arrow interpretation wins.
    const arrow = detectArrow(pts, box.diag);
    if (arrow) return arrow;
    const poly = detectPolygon(pts, box.diag, false);
    if (poly) candidates.push(poly);
    const parabola = detectParabola(pts, box.diag);
    // The better fit of a parabola and a few straight sides (a wide V is not a parabola; a
    // parabola is only roughly a few sides).
    if (parabola && (!poly || (parabola.fitError ?? 1) <= polylineError(pts, poly.points, false) / box.diag)) return parabola;
  } else {
    const ell = detectEllipse(pts, box.diag);
    if (ell) candidates.push(ell);
    const poly = detectPolygon(pts, box.diag, true);
    if (poly) candidates.push(poly);
  }
  candidates.sort((a, b) => b.confidence - a.confidence);
  const best = candidates[0];
  return best && best.confidence > 0.2 ? best : null;
}

export function snapStroke(stroke: Stroke): Stroke {
  if (stroke.tool !== 'pen' || stroke.isShape) return stroke;
  const shape = detectShape(stroke.points);
  if (!shape) return stroke;
  return { ...stroke, points: shape.points, isShape: true, closed: shape.closed, shapeKind: shape.kind, modeled: undefined, penEnd: undefined };
}

// --- TikZ export of ink ------------------------------------------------------------------------

const PX_PER_CM = 96 / 2.54;
const PT_PER_PX = 0.75;

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function tikzColor(hex: string): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return 'black';
  if (rgb[0] < 30 && rgb[1] < 30 && rgb[2] < 30) return 'black';
  return `{rgb,255:red,${rgb[0]};green,${rgb[1]};blue,${rgb[2]}}`;
}

/** Typed content placed into the picture as a TikZ node (top-left anchored, page px). */
export interface TikzLabel {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Plain text (escaped) or LaTeX source (used as is). */
  text: string;
  latex: boolean;
  color?: string;
  /** Rendered font size in px. */
  fontPx: number;
}

function escapeTex(t: string): string {
  return t
    .replace(/\\/g, '\u0000')
    .replace(/([#$%&_{}])/g, '\\$1')
    .replace(/\^/g, '\\^{}')
    .replace(/~/g, '\\~{}')
    .replace(/\u0000/g, '\\textbackslash{}');
}

/** Body of a node for a label: text lines, inline/display math, or LaTeX notes. */
function labelNode(l: TikzLabel): { body: string; opts: string[] } {
  // TeX's 10pt base vs. the rendered size on the page.
  const scale = (l.fontPx * PT_PER_PX) / 10;
  const opts = ['anchor=north west', 'inner sep=0pt'];
  if (Math.abs(scale - 1) > 0.02) opts.push(`scale=${scale.toFixed(2)}`);
  if (!l.latex) {
    const lines = l.text.split('\n').map(escapeTex);
    if (lines.length > 1) opts.push('align=left');
    return { body: lines.join(' \\\\ '), opts };
  }
  const tex = latexForDocument(l.text).trim();
  const display = /^\\\[\s*([\s\S]*?)\s*\\\]$/.exec(tex);
  if (display && !/\\begin\{/.test(display[1])) return { body: `$\\displaystyle ${display[1].replace(/\s*\n\s*/g, ' ')}$`, opts };
  // Mixed notes or environments: typeset in a box as wide as the block.
  opts.push(`text width=${(l.width / PX_PER_CM / scale).toFixed(2)}cm`, 'align=left');
  return { body: tex, opts };
}

/** Hatch spacing of the canvas renderer (8 px) in cm. */
const HATCH_CM = 8 / PX_PER_CM;

/**
 * Converts strokes to a compilable tikzpicture describing exactly what is drawn on the page:
 * shapes become TikZ primitives, smart-pen curves become the very Bezier segments that are
 * rendered (Catmull-Rom converted to `.. controls ..`), handwriting is the ink engine's modelled line.
 * Fills, hatchings, holes, dashes and arrowheads are kept. Hatchings are drawn as
 * clipped line families (no `patterns` library: identical to the canvas and rendered by TikZJax,
 * whose SVG driver ignores PGF patterns). Coordinates are in cm from the lower-left corner.
 */
export function convertStrokesToTikz(strokes: Stroke[], labels: TikzLabel[] = []): string {
  const ink = strokes.filter((s) => s.tool === 'pen' && s.points.length > 0);
  if (ink.length === 0 && labels.length === 0) return '\\begin{tikzpicture}\n\\end{tikzpicture}';
  let minX = Infinity, maxY = -Infinity;
  for (const s of ink) for (const p of s.points) { minX = Math.min(minX, p.x); maxY = Math.max(maxY, p.y); }
  for (const l of labels) { minX = Math.min(minX, l.x); maxY = Math.max(maxY, l.y + l.height); }
  const num = (v: number) => {
    const t = v.toFixed(2);
    return t === '-0.00' ? '0.00' : t;
  };
  const cx = (p: XY) => num((p.x - minX) / PX_PER_CM);
  const cy = (p: XY) => num((maxY - p.y) / PX_PER_CM);
  const c = (p: XY) => `(${cx(p)},${cy(p)})`;
  const curve = (segs: Bezier[], closed: boolean) => {
    if (!segs.length) return '';
    let out = c(segs[0][0]);
    segs.forEach(([, c1, c2, e], i) => {
      const last = i === segs.length - 1;
      out += ` .. controls ${c(c1)} and ${c(c2)} .. ${closed && last ? c(segs[0][0]) : c(e)}`;
    });
    return closed ? `${out} -- cycle` : out;
  };

  const lines: string[] = [];
  for (const s of ink) {
    const pts = s.points;
    const color = tikzColor(s.color);
    const closed = !!s.closed && pts.length > 2;
    if (s.shapeKind === 'point' || pts.length === 1) {
      const r = s.shapeKind === 'point' ? Math.max(2.5, s.width * 1.7) : s.width * 0.7;
      lines.push(`  \\fill[${color}] ${c(pts[0])} circle (${(r * PT_PER_PX).toFixed(2)}pt);`);
      continue;
    }
    const ls = s.lineStyle ?? 'solid';
    const lw = (ls === 'dotted' ? s.width * 1.8 : s.width * 1.4) * PT_PER_PX;
    // A shape's fill without its outline (left by the precision eraser): draw=none.
    const opts = s.fillOnly ? ['draw=none'] : [`draw=${color}`, `line width=${lw.toFixed(2)}pt`];
    if (!s.fillOnly && ls === 'dashed') opts.push(`dash pattern=on ${(s.width * 4 * PT_PER_PX).toFixed(2)}pt off ${(s.width * 3 * PT_PER_PX).toFixed(2)}pt`);
    if (!s.fillOnly && ls === 'dotted') opts.push(`dash pattern=on 0pt off ${(s.width * 3 * PT_PER_PX).toFixed(2)}pt`);
    if (!s.fillOnly && ls !== 'solid' && s.dashOffset) opts.push(`dash phase=${(s.dashOffset * PT_PER_PX).toFixed(2)}pt`);
    let hatch: FillType | null = null;
    if (closed && s.fill && s.fill !== 'none') {
      opts.push('even odd rule');
      if (s.fill === 'solid') opts.push(`fill=${s.fillColor ? tikzColor(s.fillColor) : color}`, `fill opacity=${s.fillOpacity ?? 0.22}`);
      else if (s.fill === 'hole') opts.push('fill=white');
      else hatch = s.fill;
    }
    const arrowKind = s.shapeKind === 'arrow';
    if ((s.arrow && !closed) || arrowKind) {
      const size = arrowKind ? s.width * 2.4 / PT_PER_PX : arrowSize(s.width);
      opts.push(`-{Stealth[length=${(size * Math.cos(Math.PI / 6) * PT_PER_PX).toFixed(2)}pt, width=${(size * PT_PER_PX).toFixed(2)}pt]}`);
    }
    const o = `[${opts.join(', ')}]`;
    const before = lines.length;
    switch (s.shapeKind) {
      case 'line':
        lines.push(`  \\draw${o} ${c(pts[0])} -- ${c(pts[pts.length - 1])};`);
        break;
      case 'arrow':
        lines.push(`  \\draw${o} ${c(pts[0])} -- ${c(pts[1])};`);
        break;
      case 'circle':
      case 'ellipse': {
        let mx = 0, my = 0;
        for (const p of pts) { mx += p.x / pts.length; my += p.y / pts.length; }
        const a = Math.hypot(pts[0].x - mx, pts[0].y - my) / PX_PER_CM;
        const q = pts[Math.floor(pts.length / 4)];
        const b = Math.hypot(q.x - mx, q.y - my) / PX_PER_CM;
        const rot = (-Math.atan2(pts[0].y - my, pts[0].x - mx) * 180) / Math.PI;
        const center = c(P(mx, my));
        if (s.shapeKind === 'circle') lines.push(`  \\draw${o} ${center} circle (${a.toFixed(2)});`);
        else if (Math.abs(rot) < 0.05) lines.push(`  \\draw${o} ${center} ellipse (${a.toFixed(2)} and ${b.toFixed(2)});`);
        else lines.push(`  \\draw${o} ${center} ellipse [x radius=${a.toFixed(2)}, y radius=${b.toFixed(2)}, rotate=${rot.toFixed(1)}];`);
        break;
      }
      case 'rectangle':
      case 'triangle':
      case 'polygon':
        lines.push(`  \\draw${o} ${pts.map(c).join(' -- ')} -- cycle;`);
        break;
      case 'polyline':
        lines.push(`  \\draw${o} ${pts.map(c).join(' -- ')}${closed ? ' -- cycle' : ''};`);
        break;
      case 'curve':
        lines.push(`  \\draw${o} ${curve(catmullRomBeziers(pts, closed), closed)};`);
        break;
      default: {
        // Handwriting: the modelled centre line the ink engine draws, as cubic Beziers within 0.08 mm.
        const segs = fitBeziers(strokeLine(s), 0.3, closed);
        lines.push(`  \\draw${o} ${segs.length ? curve(segs, closed) : `${c(pts[0])} -- ${c(pts[pts.length - 1])}`};`);
      }
    }
    if (hatch && lines.length === before + 1) {
      // \draw[opts] PATH;  ->  clipped hatch lines, then the outline.
      const stmt = lines[before];
      const path = stmt.slice(stmt.indexOf(o) + o.length + 1, -1);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const p of pts) {
        const x = (p.x - minX) / PX_PER_CM, y = (maxY - p.y) / PX_PER_CM;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
      y0 -= 0.2; y1 += 0.2;
      const h = y1 - y0;
      const from = x0 - 0.2 - h, to = x1 + 0.2;
      const range = `{${num(from)},${num(from + HATCH_CM)},...,${num(to)}}`;
      const lineOpts = `draw=${color}, line width=0.83pt, draw opacity=0.5`;
      const fam: string[] = [];
      if (hatch === 'northEast' || hatch === 'crosshatch') fam.push(`    \\foreach \\i in ${range} \\draw[${lineOpts}] (\\i,${num(y0)}) -- ++(${num(h)},${num(h)});`);
      if (hatch === 'northWest' || hatch === 'crosshatch') fam.push(`    \\foreach \\i in ${range} \\draw[${lineOpts}] (\\i,${num(y1)}) -- ++(${num(h)},${num(-h)});`);
      lines.splice(before, 0, '  \\begin{scope}', `    \\clip ${path};`, ...fam, '  \\end{scope}');
    }
  }
  for (const l of labels) {
    const { body, opts } = labelNode(l);
    if (!body.trim()) continue;
    if (l.color) opts.push(`text=${tikzColor(l.color)}`);
    lines.push(`  \\node[${opts.join(', ')}] at ${c(l)} {${body}};`);
  }
  return ['\\begin{tikzpicture}[line cap=round, line join=round]', ...lines, '\\end{tikzpicture}'].join('\n');
}

/** Ray-casting point-in-polygon test. */
export function isPointInPolygon(pt: { x: number; y: number }, poly: { x: number; y: number }[]): boolean {
  if (poly.length < 3) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if (yi > pt.y !== yj > pt.y && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
