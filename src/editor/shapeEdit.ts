import { Point, Stroke } from '../types';
import { XY } from '../ink/spline';

/**
 * Editing of shapes after they are drawn (PDEDraw's control-point editing): a lasso selection of a
 * single shape shows handles that reshape it while it stays the same kind of shape.
 *
 *  - line, polyline, triangle, polygon, point: one handle per vertex.
 *  - arrow (snapped single-stroke arrow): tail and tip; the head follows the shaft.
 *  - rectangle: four corners, keeping right angles (also for rotated rectangles).
 *  - ellipse: centre, end of the first axis (length and rotation) and end of the second axis;
 *    circle: centre and radius.
 *  - curve: at most ~12 handles spread along the spline; dragging one bends the neighbouring
 *    control points with a smooth falloff, so dense PDEDraw curves reshape without kinks.
 * Freehand ink has no handles.
 */

export type HandleRole = 'vertex' | 'center' | 'axisA' | 'axisB' | 'curve';

export interface ShapeHandle {
  x: number;
  y: number;
  role: HandleRole;
  /** Index of the stroke point this handle stands for. */
  index: number;
}

const MAX_CURVE_HANDLES = 12;

const dist = (a: XY, b: XY) => Math.hypot(a.x - b.x, a.y - b.y);

function centroid(pts: XY[]): XY {
  let x = 0, y = 0;
  for (const p of pts) { x += p.x; y += p.y; }
  return { x: x / pts.length, y: y / pts.length };
}

/** Control-point indices that carry a handle on a curve. */
function curveHandleIndices(n: number, closed: boolean): number[] {
  if (n <= MAX_CURVE_HANDLES) return Array.from({ length: n }, (_, i) => i);
  const count = closed ? MAX_CURVE_HANDLES : MAX_CURVE_HANDLES - 1;
  const out: number[] = [];
  for (let k = 0; k < count; k++) out.push(Math.round((k * (closed ? n : n - 1)) / count));
  if (!closed) out.push(n - 1);
  return [...new Set(out)];
}

export function shapeHandles(s: Stroke): ShapeHandle[] | null {
  if (!s.isShape || s.tool !== 'pen' || !s.points.length) return null;
  const pts = s.points;
  const h = (p: XY, role: HandleRole, index: number): ShapeHandle => ({ x: p.x, y: p.y, role, index });
  switch (s.shapeKind) {
    case 'point':
    case 'line':
    case 'polyline':
    case 'triangle':
    case 'polygon':
    case 'rectangle':
      return pts.map((p, i) => h(p, 'vertex', i));
    case 'arrow':
      return pts.length >= 2 ? [h(pts[0], 'vertex', 0), h(pts[1], 'vertex', 1)] : null;
    case 'circle':
      return [h(centroid(pts), 'center', -1), h(pts[0], 'axisA', 0)];
    case 'ellipse':
      return [h(centroid(pts), 'center', -1), h(pts[0], 'axisA', 0), h(pts[Math.round(pts.length / 4)], 'axisB', Math.round(pts.length / 4))];
    case 'curve': {
      const closed = !!s.closed && pts.length > 2;
      return curveHandleIndices(pts.length, closed).map((i) => h(pts[i], 'curve', i));
    }
    default:
      return null;
  }
}

const P = (p: XY, like?: Point): Point => ({ ...(like ?? { pressure: 0.5 }), x: p.x, y: p.y });

function ellipsePoints(c: XY, a: XY, rb: number, n: number): Point[] {
  // `a` is the first semi-axis as a vector; the second is perpendicular with length rb.
  const ra = Math.hypot(a.x, a.y);
  const ux = ra ? a.x / ra : 1, uy = ra ? a.y / ra : 0;
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const x = ra * Math.cos(t), y = rb * Math.sin(t);
    out.push(P({ x: c.x + x * ux - y * uy, y: c.y + x * uy + y * ux }));
  }
  return out;
}

/**
 * Reshapes `orig` (the stroke as it was when the drag started) so that `handle` ends up at `to`.
 * Always computed from the original so that a drag never accumulates rounding.
 */
export function dragHandle(orig: Stroke, handle: ShapeHandle, to: XY): Stroke {
  const pts = orig.points;
  const kind = orig.shapeKind;
  const dx = to.x - handle.x, dy = to.y - handle.y;
  switch (kind) {
    case 'point':
    case 'line':
    case 'polyline':
    case 'triangle':
    case 'polygon':
      return { ...orig, points: pts.map((p, i) => (i === handle.index ? P(to, p) : p)) };

    case 'arrow': {
      // [tail, tip, wing, tip, wing]: rebuild the head around the new shaft direction.
      const tail = handle.index === 0 ? to : pts[0];
      const tip = handle.index === 1 ? to : pts[1];
      if (pts.length < 5) return { ...orig, points: [P(tail, pts[0]), P(tip, pts[1]), ...pts.slice(2)] };
      const headLen = dist(pts[2], pts[1]);
      // Keep the head's opening angle (measured on the original arrow).
      const dir0 = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x);
      const rel = Math.atan2(pts[2].y - pts[1].y, pts[2].x - pts[1].x) - dir0 - Math.PI;
      const spread = Math.abs(Math.atan2(Math.sin(rel), Math.cos(rel))) || (28 * Math.PI) / 180;
      const dir = Math.atan2(tip.y - tail.y, tip.x - tail.x);
      const wing = (sgn: number) => ({ x: tip.x + headLen * Math.cos(dir + Math.PI - sgn * spread), y: tip.y + headLen * Math.sin(dir + Math.PI - sgn * spread) });
      return { ...orig, points: [P(tail, pts[0]), P(tip, pts[1]), P(wing(1), pts[2]), P(tip, pts[3]), P(wing(-1), pts[4])] };
    }

    case 'rectangle': {
      if (pts.length !== 4) return { ...orig, points: pts.map((p, i) => (i === handle.index ? P(to, p) : p)) };
      // Local frame of the rectangle: u along side 0->1, v along side 0->3.
      const o = pts[0];
      const lu = dist(pts[1], o) || 1;
      const u = { x: (pts[1].x - o.x) / lu, y: (pts[1].y - o.y) / lu };
      const v = { x: -u.y, y: u.x };
      const loc = (p: XY) => ({ x: (p.x - o.x) * u.x + (p.y - o.y) * u.y, y: (p.x - o.x) * v.x + (p.y - o.y) * v.y });
      const L = pts.map(loc);
      const d = L[handle.index];
      const n = loc(to);
      const eps = 1e-6 + 1e-6 * lu;
      const moved = L.map((q) => ({ x: Math.abs(q.x - d.x) < eps ? n.x : q.x, y: Math.abs(q.y - d.y) < eps ? n.y : q.y }));
      return { ...orig, points: moved.map((q, i) => P({ x: o.x + q.x * u.x + q.y * v.x, y: o.y + q.x * u.y + q.y * v.y }, pts[i])) };
    }

    case 'circle':
    case 'ellipse': {
      const c = centroid(pts);
      const n = pts.length;
      const a = { x: pts[0].x - c.x, y: pts[0].y - c.y };
      const qb = pts[Math.round(n / 4) % n];
      const rb = Math.hypot(qb.x - c.x, qb.y - c.y);
      if (handle.role === 'center') return { ...orig, points: pts.map((p) => P({ x: p.x + dx, y: p.y + dy }, p)) };
      if (handle.role === 'axisA') {
        const na = { x: to.x - c.x, y: to.y - c.y };
        const ra = Math.hypot(na.x, na.y);
        if (ra < 2) return orig;
        return { ...orig, points: ellipsePoints(c, na, kind === 'circle' ? ra : rb, n) };
      }
      // Second axis: its length is the distance of the handle from the first axis' line.
      const ra = Math.hypot(a.x, a.y) || 1;
      const nb = Math.abs(((to.x - c.x) * -a.y + (to.y - c.y) * a.x) / ra);
      if (nb < 2) return orig;
      return { ...orig, points: ellipsePoints(c, a, nb, n) };
    }

    case 'curve': {
      const closed = !!orig.closed && pts.length > 2;
      const n = pts.length;
      const handles = curveHandleIndices(n, closed);
      const hi = handles.indexOf(handle.index);
      // Influence reaches the neighbouring handles; cosine falloff in index space.
      const prev = hi > 0 ? handles[hi - 1] : closed ? handles[handles.length - 1] - n : handle.index;
      const next = hi < handles.length - 1 ? handles[hi + 1] : closed ? handles[0] + n : handle.index;
      const left = Math.max(1, handle.index - prev), right = Math.max(1, next - handle.index);
      return {
        ...orig,
        points: pts.map((p, i) => {
          let off = i - handle.index;
          if (closed) {
            if (off > n / 2) off -= n;
            if (off < -n / 2) off += n;
          }
          const span = off < 0 ? left : right;
          const t = Math.abs(off) / span;
          if (t >= 1) return p;
          const w = 0.5 * (1 + Math.cos(Math.PI * t));
          return P({ x: p.x + dx * w, y: p.y + dy * w }, p);
        }),
      };
    }

    default:
      return orig;
  }
}
