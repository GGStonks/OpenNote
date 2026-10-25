import { FillType, LineStyle, Point, ShapeKind, ShapeMode, Stroke } from '../types';
import { curveSegments } from '../ink/strokeRenderer';
import { flattenBeziers, XY } from '../ink/spline';
import { NibModeler } from '../ink/engine';

/**
 * Smart pen: PDEDraw's drawing engine (CanvasViewModel+Gestures / +Snapping) on OpenNote pages.
 *
 *  - curve: drawn by the ink engine (Nib, src/ink/engine) exactly like the pen, at uniform width.
 *    Ending near the start closes it ("potato"), shown by a snap dot at the start point. Its two
 *    ends snap to nearby shape points; in between it is never snapped sample by sample (that
 *    zig-zagged between the pen and the targets). Retracing: where it runs along the outline of
 *    an existing shape, it lies exactly on that outline.
 *  - line (angle lock every 15°), rectangle, ellipse from the centre (circle lock), point.
 *  - Snapping targets: key points of existing shapes (vertices, midpoints, centres, quadrant
 *    points), the closest point on their edges, and intersections of straight segments.
 *
 * Distances are given in screen pixels (as PDEDraw's) and divided by the zoom.
 *
 * While the pen is down the curve is shown as the ink engine's line itself (settled ink never
 * moves, as with the pen); the simplified spline it is stored as is made once, at lift-off, and
 * stays within SIMPLIFY px of that line. v1.9 re-simplified and re-splined the whole curve on every
 * frame, so the control points were picked again each frame and the line already drawn shifted
 * ("jitter"), and the cost grew with the curve's length.
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

export interface Edge extends Segment {
  /** Index of the stroke the edge belongs to. */
  owner: number;
}

export interface SnapCache {
  points: XY[];
  intersections: XY[];
  edges: Edge[];
  grid: number | null;
  /** Spatial index of the edges (cells of EDGE_CELL px), built on first use. */
  edgeIndex?: Map<string, number[]>;
}

export type SnapKind = 'shape' | 'grid';
/** What a shape snap landed on: a key point / crossing, or the closest point of an edge. */
export type SnapVia = 'point' | 'edge' | 'grid';

export const PX_PER_CM = 96 / 2.54;

const POINT_SNAP = 20;
const EDGE_SNAP = 16;
const CLOSE_DISTANCE = 18;
const CIRCLE_LOCK = 30;
const GRID_SNAP = 12;
/**
 * After snapping to a vertex, edges are not snapped to within this distance (screen px) of it:
 * leaving a vertex along one of its own edges used to catch that edge for a moment and leave a
 * tiny overlapping piece of line.
 */
const VERTEX_RELEASE = 40;

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
  return { points, intersections, edges: owned.map(({ a, b, owner }) => ({ a, b, owner })), grid };
}

/**
 * PDEDraw's findSnapPoint: intersections first, then key points (slight preference), then edges.
 * Without a shape target nearby, the paper's grid points (grid / dot paper) are used.
 * `avoid`: a vertex just snapped to; edge points within VERTEX_RELEASE of it are not taken.
 */
export function findSnapKind(cache: SnapCache, p: XY, zoom: number, avoid: XY | null = null): { at: XY; kind: SnapKind; via: SnapVia } | null {
  const k = 1 / Math.max(0.3, zoom);
  const pointThr = POINT_SNAP * k, edgeThr = EDGE_SNAP * k, release = VERTEX_RELEASE * k;
  let best: XY | null = null;
  let via: SnapVia = 'point';
  let score = Infinity;
  for (const q of cache.intersections) {
    const d = dist(p, q);
    if (d < pointThr && d < score) { best = q; score = d; via = 'point'; }
  }
  for (const q of cache.points) {
    const d = dist(p, q);
    if (d < pointThr && d - 0.8 * k < score) { best = q; score = d - 0.8 * k; via = 'point'; }
  }
  for (const e of cache.edges) {
    if (p.x < Math.min(e.a.x, e.b.x) - edgeThr || p.x > Math.max(e.a.x, e.b.x) + edgeThr) continue;
    if (p.y < Math.min(e.a.y, e.b.y) - edgeThr || p.y > Math.max(e.a.y, e.b.y) + edgeThr) continue;
    const q = project(p, e.a, e.b);
    if (avoid && dist(q, avoid) < release) continue;
    const d = dist(p, q);
    if (d < edgeThr && d + 0.5 * k < score) { best = q; score = d + 0.5 * k; via = 'edge'; }
  }
  if (best) return { at: { x: best.x, y: best.y }, kind: 'shape', via };
  if (cache.grid) {
    const g = cache.grid;
    const q = { x: Math.round(p.x / g) * g, y: Math.round(p.y / g) * g };
    if (dist(p, q) < Math.min(g * 0.3, GRID_SNAP * k)) return { at: q, kind: 'grid', via: 'grid' };
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
  start: XY | null;
  /** The pen came down on another shape's point (start is that point, not where the pen landed). */
  startSnapped: boolean;
  end: XY | null;
  /** Orange snap indicator. */
  snapDot: XY | null;
  snapKind: SnapKind | null;
  closing: boolean;
  snapping: boolean;
  /** Curve mode: the ink engine modelling the stroke. */
  ink: NibModeler | null;
  /** Curve mode: length of the pen's path so far (px). */
  length: number;
  lastRaw: XY | null;
  lastT: number;
  /** Curve mode: the engine's settled line so far (it never changes once settled). */
  settled: XY[];
  /** Curve mode: the outline next to each settled point (retracing), looked up once per point. */
  settledNear: (Near | null)[];
  /** Time (ms) of the last snap haptic. */
  lastTickT: number;
  /** The vertex last snapped to (see VERTEX_RELEASE), until the pen is far enough from it. */
  vertex: XY | null;
}

/** A pen sample for the smart pen: page px, ms since the stroke started, force (0 = lifting). */
export interface PenSample extends XY {
  t?: number;
  pressure?: number;
}

/** Snap caches by page content (the strokes array changes identity on every edit). */
const snapCaches = new WeakMap<Stroke[], Map<string, SnapCache>>();

/**
 * The snap targets of a page, built once per page content and reused by every stroke until the
 * page changes: building them (crossings included) at pen-down delayed the first ink of each shape
 * on full pages. CanvasPage also builds them ahead of time when the shape tool is picked.
 */
export function snapCacheFor(strokes: Stroke[], snap: boolean, grid: number | null): SnapCache | null {
  if (!snap && !grid) return null;
  let byKey = snapCaches.get(strokes);
  if (!byKey) snapCaches.set(strokes, (byKey = new Map()));
  const key = `${snap}|${grid}`;
  let c = byKey.get(key);
  if (!c) {
    c = buildSnapCache(snap ? strokes : [], grid);
    edgeIndex(c);
    byKey.set(key, c);
  }
  return c;
}

export function beginSmartPen(raw: PenSample, opts: SmartPenOptions, strokes: Stroke[], zoom: number): SmartPenState {
  const cache = snapCacheFor(strokes, opts.snap, opts.grid);
  const st: SmartPenState = {
    mode: opts.mode, zoom, cache, start: null, startSnapped: false, end: null, snapDot: null, snapKind: null, closing: false, snapping: false,
    ink: null, length: 0, lastRaw: null, lastT: 0, settled: [], settledNear: [], lastTickT: -Infinity, vertex: null,
  };
  const p = snapAt(st, raw);
  st.start = p;
  st.startSnapped = dist(p, raw) > 0.01;
  st.end = p;
  if (opts.mode === 'curve') {
    st.ink = new NibModeler();
    feedInk(st, raw);
  }
  return st;
}

/** Curve mode: one sample into the ink engine (uniform width; a force-less sample is the pen in the air). */
function feedInk(st: SmartPenState, raw: PenSample) {
  const t = raw.t ?? st.lastT + 1000 / 240;
  st.lastT = t;
  st.ink!.add(raw.x, raw.y, t, raw.pressure === 0 ? 0 : 0.5);
  if (st.lastRaw) st.length += dist(raw, st.lastRaw);
  st.lastRaw = { x: raw.x, y: raw.y };
}

/** Snap lookup that remembers the vertex snapped to, and keeps off its edges while near it. */
function snapLookup(st: SmartPenState, raw: XY) {
  if (!st.cache) return null;
  const k = 1 / Math.max(0.3, st.zoom);
  if (st.vertex && dist(raw, st.vertex) > VERTEX_RELEASE * k) st.vertex = null;
  const s = findSnapKind(st.cache, raw, st.zoom, st.vertex);
  if (s?.via === 'point') st.vertex = s.at;
  return s;
}

function snapAt(st: SmartPenState, raw: XY): XY {
  const s = snapLookup(st, raw);
  st.snapDot = s?.at ?? null;
  st.snapKind = s?.kind ?? null;
  return s?.at ?? { x: raw.x, y: raw.y };
}

/**
 * Feeds one input sample. Returns true when a shape snap just engaged (haptic tick; grid points
 * are passed too often to tick on each).
 */
export function moveSmartPen(st: SmartPenState, raw: PenSample): boolean {
  const k = 1 / Math.max(0.3, st.zoom);
  const wasSnapping = st.snapDot !== null && st.snapKind !== 'grid';
  switch (st.mode) {
    case 'curve': {
      feedInk(st, raw as PenSample);
      const start = st.start!;
      // Back at the start closes the curve; drawing on a little past it (an overshoot) keeps it closing.
      const d0 = dist(raw, start);
      if (st.length > CLOSE_MIN_LENGTH * k && (d0 < CLOSE_DISTANCE * k || (st.closing && d0 < CLOSE_KEEP * CLOSE_DISTANCE * k))) {
        st.closing = true;
        st.snapDot = start;
        st.snapKind = 'shape';
      } else {
        // Shown only (the ends snap, and the line follows an outline it retraces). The curve's own
        // line counts as a target too (self-snapping).
        st.closing = false;
        const s = snapLookup(st, raw);
        st.snapDot = s?.kind === 'shape' ? s.at : st.cache ? ownSnap(st, raw, k)?.at ?? null : null;
        st.snapKind = st.snapDot ? 'shape' : null;
      }
      break;
    }
    case 'line': {
      const s = st.start!;
      const snapped = snapLookup(st, raw);
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
  // One tick per snap, not a buzz while the pen runs along the edge of the snap distance.
  const tick = st.snapDot !== null && st.snapKind !== 'grid' && !wasSnapping;
  const t = raw.t ?? st.lastT;
  if (tick && t - st.lastTickT < SNAP_TICK_MS) return false;
  if (tick) st.lastTickT = t;
  return tick;
}

/** Shortest time between two snap haptics (ms). */
const SNAP_TICK_MS = 250;

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
    case 'curve':
      return curveShape(st, final, k);
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
      // Direction from the start, counterclockwise in [0°, 360°): right 0°, up 90°, left 180°, down 270°.
      const deg = (-Math.atan2(e.y - s.y, e.x - s.x) * 180) / Math.PI;
      let r = Math.round((((deg % 360) + 360) % 360) * 10) / 10;
      if (r >= 360) r = 0;
      return { text: `${r % 1 ? r.toFixed(1) : r.toFixed(0)}° · ${cm(l)} cm`, at: e };
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

// ---------------------------------------------------------------------------------------------
// Curve mode: the ink engine's line, auto-closing, end snapping and retracing

/** A curve that comes back within CLOSE_DISTANCE of its start after this much line closes. */
const CLOSE_MIN_LENGTH = 4 * CLOSE_DISTANCE;
/** Once closing, the pen may go on this many CLOSE_DISTANCEs past the start (an overshoot) and it still closes. */
const CLOSE_KEEP = 3;
/** Retracing: line within this distance (screen px) of a shape's outline, for at least TRACE_MIN px, lies on it. */
const TRACE_DIST = 8;
const TRACE_MIN = 20;
/** Length (screen px) over which the line eases onto and off an outline, and onto snapped ends. */
const BLEND = 6;
/** Stored control points: the line simplified to this tolerance (px). */
const SIMPLIFY = 0.12;
const EDGE_CELL = 24;

function curveShape(st: SmartPenState, final: boolean, k: number): SmartShape | null {
  const ink = st.ink;
  if (!ink) return null;
  let pts: XY[];
  let near: (Near | null)[] | null = null;
  if (final) pts = ink.finish().map((q) => ({ x: q.x, y: q.y }));
  else {
    // Live: the settled line is kept (and its outline lookups) and only the settling end is new.
    const settled = ink.points;
    for (let i = st.settled.length; i < settled.length; i++) st.settled.push({ x: settled[i].x, y: settled[i].y });
    pts = st.settled.concat(ink.tail().map((q) => ({ x: q.x, y: q.y })));
    if (st.cache?.edges.length) {
      const thr = TRACE_DIST * k;
      for (let i = st.settledNear.length; i < st.settled.length; i++) st.settledNear.push(nearestOutline(st.cache, st.settled[i], thr));
      near = st.settledNear.slice();
      for (let i = st.settled.length; i < pts.length; i++) near.push(nearestOutline(st.cache, pts[i], thr));
    }
  }
  if (pts.length < 2 || pathLength(pts) < 2 * k) return null;

  // Auto-close: back near the start after enough line. Cut where the line passes closest to the
  // start (it may overshoot it or stop short), and let the closed curve join the ends smoothly.
  const start = pts[0];
  let closed = false;
  if (st.length > CLOSE_MIN_LENGTH * k && (st.closing || dist(pts[pts.length - 1], start) < CLOSE_DISTANCE * k)) {
    let best = pts.length - 1;
    for (let i = Math.floor(pts.length * 0.7); i < pts.length; i++) if (dist(pts[i], start) < dist(pts[best], start)) best = i;
    pts = pts.slice(0, best + 1);
    if (pts.length > 2 && dist(pts[pts.length - 1], start) < 1) pts.pop();
    if (near) near = near.slice(0, pts.length);
    closed = pts.length > 2;
  }
  // Where the curve closes, the pen's landing (often a little hook) and its overshoot or gap were
  // joined as they were, which showed as a kink or a wiggle at the seam: both ends are cut back a
  // little and joined by a smooth bridge that follows the line's direction on either side. Not when
  // the start snapped to another shape's point: the curve then keeps passing through it.
  const startSnapped = st.startSnapped;
  if (closed && !startSnapped) {
    const seam = closeSeam(pts, near, k);
    pts = seam.pts;
    near = seam.near;
  }

  if (st.cache) {
    pts = retrace(pts, st.cache, k, closed, near);
    // The ends snap to shape points nearby (the start was looked up when the pen came down).
    if (st.start && (startSnapped || !closed) && dist(st.start, pts[0]) > 0.01) pts = ease(pts, st.start, BLEND * k, false);
    if (final && !closed) {
      const tip = pts[pts.length - 1];
      const end = findSnapKind(st.cache, tip, st.zoom, st.vertex && dist(tip, st.vertex) <= VERTEX_RELEASE * k ? st.vertex : null);
      const own = end?.kind === 'shape' ? null : ownSnap(st, tip, k, pts);
      const to = end?.kind === 'shape' ? end.at : own?.at;
      if (to) pts = ease(pts, to, BLEND * k, true);
    }
  }

  // Live: the line as drawn (a polyline of the engine's 0.5 px steps).
  if (!final) return { points: pts.map(P), kind: 'polyline', closed };
  const ctrl = simplify(pts, SIMPLIFY, closed);
  if (ctrl.length === 2 && !closed) return { points: ctrl.map(P), kind: 'line', closed: false };
  return { points: ctrl.map(P), kind: 'curve', closed };
}

/** Seam of a closed curve: the start is cut back by this much (screen px; the pen's landing hook). */
const SEAM_TRIM = 7;
/** Smoothing of the seam: Gaussian width and the stretch on either side it fades out over (screen px). */
const SEAM_SIGMA = 7;
const SEAM_SPAN = 34;

/**
 * Where a closed curve joins: its start is cut back (the hook where the pen landed), the gap to the
 * end is filled in a straight line, and the line is then smoothed about the seam (a Gaussian over
 * the line, fading out over SEAM_SPAN on either side), so a hook, a gap or an end that drifted
 * outward becomes a smooth join instead of a kink or an S-bend. The rest of the curve is untouched.
 */
function closeSeam(pts: XY[], near: (Near | null)[] | null, k: number): { pts: XY[]; near: (Near | null)[] | null } {
  const total = pathLength(pts);
  const trim = Math.min(SEAM_TRIM * k, total * 0.05);
  let a = 0, s = 0;
  while (a < pts.length - 3 && s + dist(pts[a], pts[a + 1]) <= trim) s += dist(pts[a], pts[++a]);
  const body = pts.slice(a);
  if (body.length < 4) return { pts, near };
  const E = body[body.length - 1], S = body[0];
  const gap = dist(E, S);
  const fill: XY[] = [];
  const nf = Math.floor(gap / 0.5);
  for (let i = 1; i < nf; i++) fill.push({ x: E.x + ((S.x - E.x) * i) / nf, y: E.y + ((S.y - E.y) * i) / nf });
  const loop = body.concat(fill);
  const n = loop.length;
  // Arc position of every point; the seam is the middle of the filled gap (or the join itself).
  const at = new Float64Array(n);
  for (let i = 1; i < n; i++) at[i] = at[i - 1] + dist(loop[i - 1], loop[i]);
  const T = at[n - 1] + dist(loop[n - 1], loop[0]);
  const seam = body.length - 1 >= 0 ? at[body.length - 1] + gap / 2 : 0;
  const sigma = SEAM_SIGMA * k, span = Math.min(SEAM_SPAN * k + gap, T / 4);
  const around = (x: number, y: number) => {
    const d = Math.abs(x - y) % T;
    return Math.min(d, T - d);
  };
  let cur = loop;
  for (let pass = 0; pass < 2; pass++) {
    const next = cur.slice();
    for (let i = 0; i < n; i++) {
      const ds = around(at[i], seam);
      if (ds >= span) continue;
      let sx = 0, sy = 0, sw = 0;
      // Neighbours within 3 sigma along the loop (both ways, wrapping).
      for (let step = -1; step <= 1; step += 2) {
        for (let j = step < 0 ? i : (i + 1) % n, c = 0; c < n; j = (j + step + n) % n, c++) {
          const d = around(at[j], at[i]);
          if (d > 3 * sigma) break;
          const w = Math.exp(-(d * d) / (2 * sigma * sigma));
          sx += cur[j].x * w;
          sy += cur[j].y * w;
          sw += w;
        }
      }
      const f = 1 - smooth(ds / span);
      next[i] = { x: cur[i].x + (sx / sw - cur[i].x) * f, y: cur[i].y + (sy / sw - cur[i].y) * f };
    }
    cur = next;
  }
  return { pts: cur, near: near ? near.slice(a).concat(fill.map(() => null)) : null };
}

/** Line drawn more than this (screen px) before the pen counts as a target for self-snapping. */
const OWN_GAP = 60;

/**
 * Self-snapping: the curve's own line, except its last OWN_GAP px (where the pen is), as a target:
 * its corners first (points where it turns sharply), then the closest point on it.
 */
function ownSnap(st: SmartPenState, p: XY, k: number, line: XY[] = st.settled): { at: XY } | null {
  if (line.length < 3) return null;
  let i = line.length - 1, back = 0;
  while (i > 0 && back < OWN_GAP * k) {
    back += dist(line[i], line[i - 1]);
    i--;
  }
  if (i < 1) return null;
  const pointThr = POINT_SNAP * k, edgeThr = EDGE_SNAP * k;
  // Corners: turning by more than 50° over ~6 px each way.
  const span = Math.max(2, Math.round(6 * k / 0.5));
  let best: XY | null = null, bd = Infinity;
  for (let j = span; j <= i - span; j += 2) {
    const d = dist(p, line[j]);
    if (d >= pointThr || d >= bd) continue;
    const a = line[j - span], b = line[j], c = line[j + span];
    const t1 = Math.atan2(b.y - a.y, b.x - a.x), t2 = Math.atan2(c.y - b.y, c.x - b.x);
    if (Math.abs(Math.atan2(Math.sin(t2 - t1), Math.cos(t2 - t1))) > (50 * Math.PI) / 180) { best = b; bd = d; }
  }
  if (best) return { at: { x: best.x, y: best.y } };
  for (let j = 1; j <= i; j++) {
    const q = project(p, line[j - 1], line[j]);
    const d = dist(p, q);
    if (d < edgeThr && d < bd) { best = q; bd = d; }
  }
  return best ? { at: best } : null;
}

function pathLength(pts: XY[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += dist(pts[i], pts[i - 1]);
  return l;
}

const smooth = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

/** Moves one end of the line onto `target`, easing the shift out over `len` px of line. */
function ease(pts: XY[], target: XY, len: number, atEnd: boolean): XY[] {
  const out = pts.slice();
  const n = out.length;
  const i0 = atEnd ? n - 1 : 0, step = atEnd ? -1 : 1;
  const dx = target.x - out[i0].x, dy = target.y - out[i0].y;
  let s = 0;
  for (let i = i0; i >= 0 && i < n; i += step) {
    if (i !== i0) s += dist(pts[i], pts[i - step]);
    const w = 1 - smooth(s / len);
    if (w <= 0) break;
    out[i] = { x: out[i].x + dx * w, y: out[i].y + dy * w };
  }
  return out;
}

function edgeIndex(cache: SnapCache): Map<string, number[]> {
  if (cache.edgeIndex) return cache.edgeIndex;
  const idx = new Map<string, number[]>();
  cache.edges.forEach((e, i) => {
    const x0 = Math.floor(Math.min(e.a.x, e.b.x) / EDGE_CELL), x1 = Math.floor(Math.max(e.a.x, e.b.x) / EDGE_CELL);
    const y0 = Math.floor(Math.min(e.a.y, e.b.y) / EDGE_CELL), y1 = Math.floor(Math.max(e.a.y, e.b.y) / EDGE_CELL);
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
      const key = `${cx},${cy}`;
      const list = idx.get(key);
      if (list) list.push(i);
      else idx.set(key, [i]);
    }
  });
  cache.edgeIndex = idx;
  return idx;
}

interface Near {
  at: XY;
  d: number;
  owner: number;
}

/** The closest point on any shape outline within `thr` of p. */
function nearestOutline(cache: SnapCache, p: XY, thr: number): Near | null {
  const idx = edgeIndex(cache);
  let best: Near | null = null;
  const x0 = Math.floor((p.x - thr) / EDGE_CELL), x1 = Math.floor((p.x + thr) / EDGE_CELL);
  const y0 = Math.floor((p.y - thr) / EDGE_CELL), y1 = Math.floor((p.y + thr) / EDGE_CELL);
  for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
    for (const i of idx.get(`${cx},${cy}`) ?? []) {
      const e = cache.edges[i];
      const q = project(p, e.a, e.b);
      const d = dist(p, q);
      if (d < thr && (!best || d < best.d)) best = { at: q, d, owner: e.owner };
    }
  }
  return best;
}

/**
 * Retracing: stretches of the line that follow one shape's outline (within TRACE_DIST, for at
 * least TRACE_MIN of line) are put exactly on that outline, easing on and off over BLEND.
 */
function retrace(pts: XY[], cache: SnapCache, k: number, closed: boolean, known: (Near | null)[] | null = null): XY[] {
  if (!cache.edges.length) return pts;
  const thr = TRACE_DIST * k, minLen = TRACE_MIN * k, blend = BLEND * k;
  const near = known && known.length === pts.length ? known : pts.map((p) => nearestOutline(cache, p, thr));
  const out = pts.slice();
  let i = 0;
  while (i < pts.length) {
    if (!near[i]) { i++; continue; }
    const owner = near[i]!.owner;
    let j = i;
    while (j + 1 < pts.length && near[j + 1] && near[j + 1]!.owner === owner) j++;
    const len = pathLength(pts.slice(i, j + 1));
    if (len >= minLen) {
      // Arc length from each end of the run, for the easing (none where the run is a stroke end,
      // or wraps round a closed curve).
      const fromStart: number[] = [], fromEnd: number[] = [];
      let s = 0;
      for (let m = i; m <= j; m++) { if (m > i) s += dist(pts[m], pts[m - 1]); fromStart.push(s); }
      for (let m = i; m <= j; m++) fromEnd.push(len - fromStart[m - i]);
      const easeIn = !(i === 0 && !closed), easeOut = !(j === pts.length - 1 && !closed);
      for (let m = i; m <= j; m++) {
        const w = Math.min(easeIn ? smooth(fromStart[m - i] / blend) : 1, easeOut ? smooth(fromEnd[m - i] / blend) : 1);
        const q = near[m]!.at;
        out[m] = { x: pts[m].x + (q.x - pts[m].x) * w, y: pts[m].y + (q.y - pts[m].y) * w };
      }
    }
    i = j + 1;
  }
  return out;
}

/** Ramer-Douglas-Peucker: the fewest points that keep the line within `tol`. */
function simplify(pts: XY[], tol: number, closed: boolean): XY[] {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let far = -1, fd = tol;
    for (let i = a + 1; i < b; i++) {
      const d = dist(pts[i], project(pts[i], pts[a], pts[b]));
      if (d > fd) { fd = d; far = i; }
    }
    if (far >= 0) {
      keep[far] = 1;
      stack.push([a, far], [far, b]);
    }
  }
  const out = pts.filter((_, i) => keep[i]);
  // A closed curve needs its shape even when it is drawn as a near-straight there-and-back.
  return closed && out.length < 3 ? pts.filter((_, i) => i % Math.max(1, Math.floor(pts.length / 3)) === 0) : out;
}
