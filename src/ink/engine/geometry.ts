/**
 * Ink engine geometry: the point types and the shape of pressure-sized ink (capsule unions).
 * No dependencies outside src/ink/engine.
 */

export interface XY {
  x: number;
  y: number;
}

/** An input sample: page px, force 0..1 (0 = unknown / lifting), ms (optional). */
export interface InkPoint extends XY {
  pressure: number;
  t?: number;
}

export interface ModeledPoint {
  x: number;
  y: number;
  /** Normalised pressure 0..1. */
  p: number;
  /** ms since the start of the stroke. */
  t: number;
}

/**
 * Sample times of a stroke. Strokes saved before v1.2 have no timestamps: they are synthesised
 * from the distance at an ordinary writing speed.
 */
export function sampleTimes(points: InkPoint[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (typeof p.t === 'number' && (i === 0 || typeof points[i - 1].t === 'number')) out.push(p.t);
    else if (i === 0) out.push(0);
    else out.push(out[i - 1] + Math.max(4, Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y) / 0.4));
  }
  return out;
}

export function hasRealPressure(points: InkPoint[]): boolean {
  for (const p of points) if (p.pressure !== 0.5 && p.pressure > 0) return true;
  return false;
}

/**
 * Fountain pen: width for a normalised force. Ordinary writing force (Safari reports ~0.15-0.4)
 * stays close to the nominal width; the range is 0.72x (barely touching) to 1.3x (pressed hard),
 * like Notability's pen, instead of the old 0.4x-1.6x that made light writing thin and fragile.
 */
export function pressureWidth(base: number, pressure: number): number {
  const p = Math.max(0, Math.min(1, pressure || 0.5));
  return base * (0.72 + 0.58 * Math.pow(p, 0.7));
}

/** Drops modelled points closer than `min` to the previous one (keeps the last). */
export function thinModeled(pts: ModeledPoint[], min = 0.35): ModeledPoint[] {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const l = out[out.length - 1];
    if (Math.hypot(pts[i].x - l.x, pts[i].y - l.y) >= min) out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/**
 * Appends to `path` the capsule swept by a circle moving from (a, ra) to (b, rb): the two outer
 * tangents and the two end arcs, always with the same winding so that a nonzero fill of many
 * capsules is their exact union.
 */
export function addCapsule(path: Path2D | CanvasRenderingContext2D, a: XY, ra: number, b: XY, rb: number): void {
  const dx = b.x - a.x, dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  if (d <= Math.abs(ra - rb) + 1e-6) {
    // One circle contains the other.
    const c = ra >= rb ? a : b, r = Math.max(ra, rb);
    path.moveTo(c.x + r, c.y);
    path.arc(c.x, c.y, r, 0, Math.PI * 2, true);
    path.closePath();
    return;
  }
  const th = Math.atan2(dy, dx);
  const ph = Math.acos((ra - rb) / d);
  path.moveTo(a.x + ra * Math.cos(th + ph), a.y + ra * Math.sin(th + ph));
  path.lineTo(b.x + rb * Math.cos(th + ph), b.y + rb * Math.sin(th + ph));
  path.arc(b.x, b.y, rb, th + ph, th - ph, true);
  path.lineTo(a.x + ra * Math.cos(th - ph), a.y + ra * Math.sin(th - ph));
  path.arc(a.x, a.y, ra, th - ph, th + ph - Math.PI * 2, true);
  path.closePath();
}

/** SVG path data of the same capsule (for vector export). */
export function capsuleSvg(a: XY, ra: number, b: XY, rb: number, f: (v: number) => string): string {
  const dx = b.x - a.x, dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  if (d <= Math.abs(ra - rb) + 1e-6) {
    const c = ra >= rb ? a : b, r = Math.max(ra, rb);
    return `M${f(c.x + r)} ${f(c.y)}A${f(r)} ${f(r)} 0 1 0 ${f(c.x - r)} ${f(c.y)}A${f(r)} ${f(r)} 0 1 0 ${f(c.x + r)} ${f(c.y)}Z`;
  }
  const th = Math.atan2(dy, dx);
  const ph = Math.acos((ra - rb) / d);
  const P = (c: XY, r: number, ang: number) => `${f(c.x + r * Math.cos(ang))} ${f(c.y + r * Math.sin(ang))}`;
  // Front arc spans 2*ph around b, back arc 2*pi - 2*ph around a; both counter-clockwise (sweep 0).
  return (
    `M${P(a, ra, th + ph)}L${P(b, rb, th + ph)}` +
    `A${f(rb)} ${f(rb)} 0 ${2 * ph > Math.PI ? 1 : 0} 0 ${P(b, rb, th - ph)}` +
    `L${P(a, ra, th - ph)}` +
    `A${f(ra)} ${f(ra)} 0 ${2 * Math.PI - 2 * ph > Math.PI ? 1 : 0} 0 ${P(a, ra, th + ph)}Z`
  );
}

/** Variable-width ink as the union of capsules between consecutive points (fill, nonzero). */
export function capsulePath(pts: XY[], widths: number[], from = 0, path: Path2D = new Path2D()): Path2D {
  for (let i = Math.max(1, from); i < pts.length; i++) addCapsule(path, pts[i - 1], widths[i - 1] / 2, pts[i], widths[i] / 2);
  if (pts.length === 1) addCapsule(path, pts[0], widths[0] / 2, pts[0], widths[0] / 2);
  return path;
}
