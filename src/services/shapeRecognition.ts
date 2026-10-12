import { FillType, Point, Stroke, ShapeKind } from '../types';
import { Bezier, catmullRomBeziers, XY } from '../ink/spline';
import { inkControlPoints } from '../ink/inkEngine';
import { arrowSize } from '../ink/strokeRenderer';
import { latexForDocument } from './latexRender';

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
 * rendered (Catmull-Rom converted to `.. controls ..`), handwriting is the ink engine's own spline.
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
    const opts = [`draw=${color}`, `line width=${lw.toFixed(2)}pt`];
    if (ls === 'dashed') opts.push(`dash pattern=on ${(s.width * 4 * PT_PER_PX).toFixed(2)}pt off ${(s.width * 3 * PT_PER_PX).toFixed(2)}pt`);
    if (ls === 'dotted') opts.push(`dash pattern=on 0pt off ${(s.width * 3 * PT_PER_PX).toFixed(2)}pt`);
    let hatch: FillType | null = null;
    if (closed && s.fill && s.fill !== 'none') {
      opts.push('even odd rule');
      if (s.fill === 'solid') opts.push(`fill=${color}`, 'fill opacity=0.22');
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
        // Handwriting: the very spline the ink engine draws (thinned samples, Catmull-Rom).
        const segs = catmullRomBeziers(inkControlPoints(pts), closed);
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
