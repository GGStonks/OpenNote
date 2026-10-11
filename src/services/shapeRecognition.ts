import { Point, Stroke, ShapeKind, PAGE_HEIGHT } from '../types';

/**
 * Shape snapping.
 *
 * Modelled on Notability's ShapeDetection.framework (observed in the shipped binary): several
 * independent detectors (line, arrow, ellipse, polygon, open polyline) each produce a candidate
 * with a confidence; the best candidate wins and is only accepted above a threshold
 * (Notability uses confidence > 0.2 in ShapeDetector.detectShape()). The detectors below are an
 * independent implementation; Notability's exact fitting maths is not reproduced.
 */

export interface SnappedShape {
  kind: ShapeKind;
  points: Point[];
  closed: boolean;
  confidence: number;
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
  if (rel > 0.08 || straightness < 0.9) return null;
  // Snap near-horizontal / vertical lines.
  let end = b;
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const snapTol = (4 * Math.PI) / 180;
  for (const target of [0, Math.PI / 2, Math.PI, -Math.PI / 2, -Math.PI]) {
    if (Math.abs(ang - target) < snapTol) {
      end = Math.abs(Math.sin(target)) > 0.5 ? P(a.x, b.y) : P(b.x, a.y);
    }
  }
  return { kind: 'line', points: [P(a.x, a.y), P(end.x, end.y)], closed: false, confidence: 1 - rel / 0.08 * 0.8 };
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

function detectPolygon(pts: Point[], diag: number, closed: boolean): SnappedShape | null {
  const ring = closed ? [...pts, pts[0]] : pts;
  let v = rdp(ring, Math.max(4, diag * 0.06));
  if (closed) {
    v = v.slice(0, -1);
    // Merge the start vertex if it lies on a straight run.
    if (v.length > 3 && angleAt(v[v.length - 1], v[0], v[1]) > (155 * Math.PI) / 180) v = v.slice(1);
  }
  if (closed && (v.length < 3 || v.length > 8)) return null;
  if (!closed && (v.length < 3 || v.length > 6)) return null;
  const err = polylineError(pts, v, closed) / diag;
  if (err > (closed ? 0.035 : 0.025)) return null;

  let kind: ShapeKind = closed ? (v.length === 3 ? 'triangle' : 'polygon') : 'polyline';
  let out = v.map((p) => P(p.x, p.y));

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
  return { kind, points: out, closed, confidence: 1 - err / 0.035 };
}

/** Runs all detectors on one stroke and returns the best accepted shape, or null. */
export function detectShape(points: Point[]): SnappedShape | null {
  if (points.length < 3) return null;
  const len = pathLength(points);
  if (len < 16) return null;
  const pts = resample(points, 96);
  const box = bbox(pts);
  const gap = Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y);
  const closed = gap < Math.max(14, 0.2 * box.diag) && len > 2.2 * box.diag * 0.5;

  const candidates: SnappedShape[] = [];
  if (!closed) {
    const line = detectLine(pts, len);
    if (line) return line;
    // An arrow is also a valid open polyline; the arrow interpretation wins.
    const arrow = detectArrow(pts, box.diag);
    if (arrow) return arrow;
    const poly = detectPolygon(pts, box.diag, false);
    if (poly) candidates.push(poly);
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
  return { ...stroke, points: shape.points, isShape: true, closed: shape.closed, shapeKind: shape.kind };
}

// --- TikZ export of ink ------------------------------------------------------------------------

const PX_PER_CM = 96 / 2.54;

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

/**
 * Converts strokes to a compilable tikzpicture. Snapped shapes become exact TikZ primitives;
 * freehand ink becomes simplified smooth plots. Coordinates are in cm relative to the selection.
 */
export function convertStrokesToTikz(strokes: Stroke[], pageHeight: number = PAGE_HEIGHT): string {
  const ink = strokes.filter((s) => s.tool === 'pen' && s.points.length > 0);
  if (ink.length === 0) return '\\begin{tikzpicture}\n\\end{tikzpicture}';
  let minX = Infinity, maxY = -Infinity;
  for (const s of ink) for (const p of s.points) { minX = Math.min(minX, p.x); maxY = Math.max(maxY, p.y); }
  void pageHeight;
  const cx = (p: Point) => ((p.x - minX) / PX_PER_CM).toFixed(2);
  const cy = (p: Point) => ((maxY - p.y) / PX_PER_CM).toFixed(2);
  const c = (p: Point) => `(${cx(p)},${cy(p)})`;

  const lines: string[] = ['\\begin{tikzpicture}[line cap=round, line join=round]'];
  for (const s of ink) {
    const opts = [`draw=${tikzColor(s.color)}`, `line width=${(s.width * 0.55).toFixed(2)}pt`];
    if (s.lineStyle === 'dashed') opts.push('dashed');
    if (s.lineStyle === 'dotted') opts.push('dotted');
    const o = `[${opts.join(', ')}]`;
    const pts = s.points;
    switch (s.shapeKind) {
      case 'line':
        lines.push(`  \\draw${o} ${c(pts[0])} -- ${c(pts[pts.length - 1])};`);
        break;
      case 'arrow':
        lines.push(`  \\draw${o.slice(0, -1)}, -{Stealth[length=${(s.width * 2.4).toFixed(1)}pt]}] ${c(pts[0])} -- ${c(pts[1])};`);
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
        else lines.push(`  \\draw${o} ${center} ellipse [x radius=${a.toFixed(2)}, y radius=${b.toFixed(2)}, rotate=${rot.toFixed(1)}];`);
        break;
      }
      case 'rectangle':
      case 'triangle':
      case 'polygon':
        lines.push(`  \\draw${o} ${pts.map(c).join(' -- ')} -- cycle;`);
        break;
      case 'polyline':
        lines.push(`  \\draw${o} ${pts.map(c).join(' -- ')};`);
        break;
      default: {
        if (pts.length === 1) {
          lines.push(`  \\fill[${tikzColor(s.color)}] ${c(pts[0])} circle (${(s.width * 0.3).toFixed(1)}pt);`);
          break;
        }
        const simplified = rdp(pts, 1.2);
        if (simplified.length === 2) lines.push(`  \\draw${o} ${c(simplified[0])} -- ${c(simplified[1])};`);
        else lines.push(`  \\draw${o} plot[smooth, tension=0.5] coordinates {${simplified.map(c).join(' ')}};`);
      }
    }
  }
  lines.push('\\end{tikzpicture}');
  return lines.join('\n');
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
