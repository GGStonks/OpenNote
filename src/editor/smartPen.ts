import { FillType, LineStyle, Point, ShapeKind, ShapeMode, Stroke } from '../types';
import { curveSegments } from '../ink/strokeRenderer';
import { flattenBeziers, XY } from '../ink/spline';

/**
 * Smart pen: PDEDraw's drawing engine (CanvasViewModel+Gestures / +Snapping) on OpenNote pages.
 *
 *  - curve: smooth centripetal Catmull-Rom curve; ending near the start closes it ("potato"),
 *    shown by a snap dot at the start point. Every sample snaps to nearby shape points/edges.
 *  - line (angle lock every 15°), rectangle, ellipse from the centre (circle lock), point.
 *  - Snapping targets: key points of existing shapes (vertices, midpoints, centres, quadrant
 *    points), the closest point on their edges, and intersections of straight segments.
 *
 * Distances are given in screen pixels (as PDEDraw's) and divided by the zoom.
 */

export interface SmartPenOptions {
  mode: ShapeMode;
  color: string;
  width: number;
  fill: FillType;
  arrow: boolean;
  lineStyle: LineStyle;
  snap: boolean;
  /** Spacing of the paper's grid/dot lattice to snap to (null: no grid snapping). */
  grid: number | null;
}

interface Segment {
  a: XY;
  b: XY;
}

export interface SnapCache {
  points: XY[];
  intersections: XY[];
  edges: Segment[];
  grid: number | null;
}

export type SnapKind = 'shape' | 'grid';

export const PX_PER_CM = 96 / 2.54;

const POINT_SNAP = 20;
const EDGE_SNAP = 16;
const CLOSE_DISTANCE = 18;
const CURVE_SAMPLING = 4.5;
const CIRCLE_LOCK = 30;
const GRID_SNAP = 12;

const dist = (a: XY, b: XY) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a: XY, b: XY): XY => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

function project(p: XY, a: XY, b: XY): XY {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (!l2) return a;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return { x: a.x + t * dx, y: a.y + t * dy };
}

function intersect(p1: XY, p2: XY, p3: XY, p4: XY): XY | null {
  const d = (p1.x - p2.x) * (p3.y - p4.y) - (p1.y - p2.y) * (p3.x - p4.x);
  if (Math.abs(d) < 1e-9) return null;
  const t = ((p1.x - p3.x) * (p3.y - p4.y) - (p1.y - p3.y) * (p3.x - p4.x)) / d;
  const u = -((p1.x - p2.x) * (p1.y - p3.y) - (p1.y - p2.y) * (p1.x - p3.x)) / d;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y) };
}

function centroid(pts: XY[]): XY {
  let x = 0, y = 0;
  for (const p of pts) { x += p.x; y += p.y; }
  return { x: x / pts.length, y: y / pts.length };
}

interface OwnedSegment extends Segment {
  owner: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

const MAX_INTERSECTIONS = 4000;

/**
 * Snap targets of the shapes on a page (freehand handwriting is ignored): key points, edges, and
 * the crossings between any two shapes, curves and ellipses included. Crossings are found with a
 * sweep over the edges' x-extents, so pages with many curves stay fast.
 */
export function buildSnapCache(strokes: Stroke[], grid: number | null = null): SnapCache {
  const points: XY[] = [];
  const owned: OwnedSegment[] = [];
  const addEdge = (a: XY, b: XY, owner: number) =>
    owned.push({ a, b, owner, minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y) });
  strokes.forEach((s, owner) => {
    if (!s.isShape || s.tool !== 'pen' || !s.points.length) return;
    const pts = s.points;
    const closed = !!s.closed && pts.length > 2;
    const kind = s.shapeKind;
    if (kind === 'point') {
      points.push(pts[0]);
      return;
    }
    if (kind === 'ellipse' || kind === 'circle') {
      const n = pts.length;
      points.push(centroid(pts));
      for (let k = 0; k < 8; k++) points.push(pts[Math.round((k * n) / 8) % n]);
      for (let i = 0; i < n; i++) addEdge(pts[i], pts[(i + 1) % n], owner);
      return;
    }
    if (kind === 'curve') {
      const flat = flattenBeziers(curveSegments(pts, closed), 3);
      for (let i = 1; i < flat.length; i++) addEdge(flat[i - 1], flat[i], owner);
      if (pts.length <= 2) points.push(...pts);
      else {
        const step = Math.max(1, Math.floor(pts.length / 8));
        points.push(pts[0], pts[pts.length - 1]);
        for (let i = step; i < pts.length - 1; i += step) points.push(pts[i]);
      }
      return;
    }
    // Straight-sided shapes: line, arrow, polyline, triangle, rectangle, polygon.
    const verts = kind === 'arrow' ? pts.slice(0, 2) : pts;
    const segs: Segment[] = [];
    for (let i = 1; i < verts.length; i++) segs.push({ a: verts[i - 1], b: verts[i] });
    if (closed && kind !== 'arrow') segs.push({ a: verts[verts.length - 1], b: verts[0] });
    for (const seg of segs) points.push(mid(seg.a, seg.b));
    points.push(...verts);
    if (closed) points.push(centroid(verts));
    for (const seg of segs) addEdge(seg.a, seg.b, owner);
  });

  const intersections: XY[] = [];
  const sorted = owned.slice().sort((p, q) => p.minX - q.minX);
  outer: for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    for (let j = i + 1; j < sorted.length; j++) {
      const f = sorted[j];
      if (f.minX > e.maxX) break;
      if (f.owner === e.owner || f.minY > e.maxY || f.maxY < e.minY) continue;
      const p = intersect(e.a, e.b, f.a, f.b);
      if (!p) continue;
      const last = intersections[intersections.length - 1];
      if (last && dist(last, p) < 0.5) continue;
      intersections.push(p);
      if (intersections.length >= MAX_INTERSECTIONS) break outer;
    }
  }
  return { points, intersections, edges: owned.map(({ a, b }) => ({ a, b })), grid };
}

/**
 * PDEDraw's findSnapPoint: intersections first, then key points (slight preference), then edges.
 * Without a shape target nearby, the paper's grid points (grid / dot paper) are used.
 */
export function findSnapKind(cache: SnapCache, p: XY, zoom: number): { at: XY; kind: SnapKind } | null {
  const k = 1 / Math.max(0.3, zoom);
  const pointThr = POINT_SNAP * k, edgeThr = EDGE_SNAP * k;
  let best: XY | null = null;
  let score = Infinity;
  for (const q of cache.intersections) {
    const d = dist(p, q);
    if (d < pointThr && d < score) { best = q; score = d; }
  }
  for (const q of cache.points) {
    const d = dist(p, q);
    if (d < pointThr && d - 0.8 * k < score) { best = q; score = d - 0.8 * k; }
  }
  for (const e of cache.edges) {
    if (p.x < Math.min(e.a.x, e.b.x) - edgeThr || p.x > Math.max(e.a.x, e.b.x) + edgeThr) continue;
    if (p.y < Math.min(e.a.y, e.b.y) - edgeThr || p.y > Math.max(e.a.y, e.b.y) + edgeThr) continue;
    const q = project(p, e.a, e.b);
    const d = dist(p, q);
    if (d < edgeThr && d + 0.5 * k < score) { best = q; score = d + 0.5 * k; }
  }
  if (best) return { at: { x: best.x, y: best.y }, kind: 'shape' };
  if (cache.grid) {
    const g = cache.grid;
    const q = { x: Math.round(p.x / g) * g, y: Math.round(p.y / g) * g };
    if (dist(p, q) < Math.min(g * 0.3, GRID_SNAP * k)) return { at: q, kind: 'grid' };
  }
  return null;
}

export function findSnap(cache: SnapCache, p: XY, zoom: number): XY | null {
  return findSnapKind(cache, p, zoom)?.at ?? null;
}

// ---------------------------------------------------------------------------------------------
// Gesture state

export interface SmartPenState {
  mode: ShapeMode;
  zoom: number;
  cache: SnapCache | null;
  /** Curve control points / shape anchor. */
  points: XY[];
  start: XY | null;
  end: XY | null;
  /** Orange snap indicator. */
  snapDot: XY | null;
  snapKind: SnapKind | null;
  closing: boolean;
  snapping: boolean;
}

export function beginSmartPen(raw: XY, opts: SmartPenOptions, strokes: Stroke[], zoom: number): SmartPenState {
  const cache = opts.snap || opts.grid ? buildSnapCache(opts.snap ? strokes : [], opts.grid) : null;
  const st: SmartPenState = { mode: opts.mode, zoom, cache, points: [], start: null, end: null, snapDot: null, snapKind: null, closing: false, snapping: false };
  const p = snapAt(st, raw);
  st.start = p;
  st.end = p;
  if (opts.mode === 'curve') st.points = [p];
  return st;
}

function snapAt(st: SmartPenState, raw: XY): XY {
  const s = st.cache ? findSnapKind(st.cache, raw, st.zoom) : null;
  st.snapDot = s?.at ?? null;
  st.snapKind = s?.kind ?? null;
  return s?.at ?? { x: raw.x, y: raw.y };
}

/** PDEDraw's appendCurvePoint: drops samples that only extend a straight run. */
function appendCurvePoint(pts: XY[], p: XY, sampling: number) {
  const last = pts[pts.length - 1];
  if (dist(p, last) < sampling) return;
  if (pts.length >= 2) {
    const prev = pts[pts.length - 2];
    const deviation = dist(p, project(p, prev, last));
    if (deviation < 0.27 * sampling && dist(p, last) < 2.2 * sampling) {
      pts[pts.length - 1] = p;
      return;
    }
  }
  pts.push(p);
}

/**
 * Feeds one input sample. Returns true when a shape snap just engaged (haptic tick; grid points
 * are passed too often to tick on each).
 */
export function moveSmartPen(st: SmartPenState, raw: XY): boolean {
  const k = 1 / Math.max(0.3, st.zoom);
  const wasSnapping = st.snapDot !== null && st.snapKind !== 'grid';
  switch (st.mode) {
    case 'curve': {
      const first = st.points[0];
      const last = st.points[st.points.length - 1];
      if (dist(raw, last) <= CURVE_SAMPLING * k) break;
      if (dist(raw, first) < CLOSE_DISTANCE * k && st.points.length > 5) {
        st.closing = true;
        st.snapDot = first;
        st.snapKind = 'shape';
      } else {
        st.closing = false;
        appendCurvePoint(st.points, snapAt(st, raw), CURVE_SAMPLING * k);
      }
      break;
    }
    case 'line': {
      const s = st.start!;
      const snapped = st.cache ? findSnapKind(st.cache, raw, st.zoom) : null;
      st.snapDot = snapped?.at ?? null;
      st.snapKind = snapped?.kind ?? null;
      if (snapped) st.end = snapped.at;
      else {
        const dx = raw.x - s.x, dy = raw.y - s.y;
        const d = Math.hypot(dx, dy), ang = Math.atan2(dy, dx);
        const step = Math.PI / 12;
        const locked = Math.round(ang / step) * step;
        const a = Math.abs(ang - locked) < 0.05 ? locked : ang;
        st.end = { x: s.x + d * Math.cos(a), y: s.y + d * Math.sin(a) };
      }
      break;
    }
    case 'ellipse': {
      const c = st.start!;
      const t = snapAt(st, raw);
      let dx = Math.abs(t.x - c.x), dy = Math.abs(t.y - c.y);
      if (Math.abs(dx - dy) < CIRCLE_LOCK * k) dx = dy = Math.max(dx, dy);
      st.end = { x: c.x + dx, y: c.y + dy };
      break;
    }
    default:
      st.end = snapAt(st, raw);
  }
  return st.snapDot !== null && st.snapKind !== 'grid' && !wasSnapping;
}

export function isCircle(st: SmartPenState): boolean {
  if (!st.start || !st.end) return false;
  return Math.abs(Math.abs(st.end.x - st.start.x) - Math.abs(st.end.y - st.start.y)) < 0.01;
}

const P = (p: XY): Point => ({ x: p.x, y: p.y, pressure: 0.5 });

export interface SmartShape {
  points: Point[];
  kind: ShapeKind;
  closed: boolean;
}

/** Geometry of the shape being drawn (live preview and final stroke). Null while degenerate. */
export function smartPenShape(st: SmartPenState, final: boolean): SmartShape | null {
  const k = 1 / Math.max(0.3, st.zoom);
  switch (st.mode) {
    case 'curve': {
      const pts = st.points;
      if (pts.length < 2) return null;
      const first = pts[0], last = pts[pts.length - 1];
      const closed = pts.length > 2 && (st.closing || (final && dist(first, last) < CLOSE_DISTANCE * k));
      if (pts.length === 2) return { points: pts.map(P), kind: 'line', closed: false };
      const ctrl = closed && dist(first, last) < CURVE_SAMPLING * k ? pts.slice(0, -1) : pts;
      return { points: ctrl.map(P), kind: 'curve', closed };
    }
    case 'line': {
      if (!st.start || !st.end || dist(st.start, st.end) < 2 * k) return null;
      return { points: [P(st.start), P(st.end)], kind: 'line', closed: false };
    }
    case 'rectangle': {
      const s = st.start, e = st.end;
      if (!s || !e || Math.abs(e.x - s.x) < 2 * k || Math.abs(e.y - s.y) < 2 * k) return null;
      return { points: [P(s), P({ x: e.x, y: s.y }), P(e), P({ x: s.x, y: e.y })], kind: 'rectangle', closed: true };
    }
    case 'ellipse': {
      const c = st.start, e = st.end;
      if (!c || !e) return null;
      const rx = Math.abs(e.x - c.x), ry = Math.abs(e.y - c.y);
      if (rx < 2 * k || ry < 2 * k) return null;
      const out: Point[] = [];
      const steps = 72;
      for (let i = 0; i < steps; i++) {
        const t = (i / steps) * Math.PI * 2;
        out.push(P({ x: c.x + rx * Math.cos(t), y: c.y + ry * Math.sin(t) }));
      }
      return { points: out, kind: isCircle(st) ? 'circle' : 'ellipse', closed: true };
    }
    case 'point': {
      const p = st.end ?? st.start;
      return p ? { points: [P(p)], kind: 'point', closed: false } : null;
    }
  }
}

export function smartPenStroke(st: SmartPenState, opts: SmartPenOptions, id: string): Stroke | null {
  const shape = smartPenShape(st, true);
  if (!shape) return null;
  return {
    id,
    tool: 'pen',
    color: opts.color,
    width: opts.width,
    opacity: 1,
    penStyle: 'ballpoint',
    lineStyle: shape.kind === 'point' ? 'solid' : opts.lineStyle,
    points: shape.points,
    isShape: true,
    closed: shape.closed,
    shapeKind: shape.kind,
    ...(shape.closed && opts.fill !== 'none' ? { fill: opts.fill } : {}),
    ...(!shape.closed && opts.arrow && shape.kind !== 'point' ? { arrow: true } : {}),
  };
}

const cm = (px: number) => (px / PX_PER_CM).toFixed(px / PX_PER_CM < 10 ? 2 : 1);

/** Live dimensions of the shape being drawn (shown next to the pen), or null. */
export function smartPenMeasure(st: SmartPenState): { text: string; at: XY } | null {
  const s = st.start, e = st.end;
  if (!s || !e) return null;
  switch (st.mode) {
    case 'line': {
      const l = dist(s, e);
      if (l < 4) return null;
      let deg = (-Math.atan2(e.y - s.y, e.x - s.x) * 180) / Math.PI;
      if (deg < 0) deg += 360;
      return { text: `${cm(l)} cm · ${deg.toFixed(deg % 1 ? 1 : 0)}°`, at: e };
    }
    case 'rectangle': {
      const w = Math.abs(e.x - s.x), h = Math.abs(e.y - s.y);
      if (w < 4 && h < 4) return null;
      return { text: `${cm(w)} × ${cm(h)} cm`, at: e };
    }
    case 'ellipse': {
      const rx = Math.abs(e.x - s.x), ry = Math.abs(e.y - s.y);
      if (rx < 4 && ry < 4) return null;
      return { text: isCircle(st) ? `r ${cm(rx)} cm` : `${cm(rx)} × ${cm(ry)} cm`, at: e };
    }
    default:
      return null;
  }
}
