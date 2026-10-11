import { getStroke } from 'perfect-freehand';
import { Point, Stroke, PenStyle, LineStyle } from '../types';

/**
 * Ink renderer.
 *
 * Notability stores every curve as variable-width Bezier data (points + per-point fractional
 * width/force/altitude/azimuth, see InkObjectEncoder) and renders it with Metal. We keep the raw
 * samples and render with Canvas2D: pressure-sensitive outlines (perfect-freehand) for the fountain
 * pen, constant-width stroked paths for ballpoint, shapes, dashes and highlighters.
 * Path2D objects are cached per immutable Stroke object so redraws stay cheap on long notes.
 */

export interface InkStyle {
  tool: 'pen' | 'highlighter';
  color: string;
  width: number;
  penStyle: PenStyle;
  lineStyle?: LineStyle;
  isShape?: boolean;
  closed?: boolean;
}

interface CachedPath {
  path: Path2D;
  filled: boolean;
}

const cache = new WeakMap<Stroke, CachedPath>();

function hasRealPressure(points: Point[]): boolean {
  for (const p of points) if (p.pressure !== 0.5 && p.pressure > 0) return true;
  return false;
}

function outlineToPath(outline: number[][]): Path2D {
  const path = new Path2D();
  if (outline.length < 2) return path;
  path.moveTo(outline[0][0], outline[0][1]);
  for (let i = 1; i < outline.length; i++) {
    const [x0, y0] = outline[i - 1];
    const [x1, y1] = outline[i];
    path.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  path.closePath();
  return path;
}

function centerlinePath(points: Point[], smooth: boolean, closed: boolean): Path2D {
  const path = new Path2D();
  if (points.length === 0) return path;
  path.moveTo(points[0].x, points[0].y);
  if (points.length === 1) {
    path.lineTo(points[0].x + 0.01, points[0].y);
    return path;
  }
  if (!smooth) {
    for (let i = 1; i < points.length; i++) path.lineTo(points[i].x, points[i].y);
  } else {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      path.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2);
    }
    const last = points[points.length - 1];
    path.lineTo(last.x, last.y);
  }
  if (closed) path.closePath();
  return path;
}

export function fountainOutline(points: Point[], width: number, last: boolean): number[][] {
  const realPressure = hasRealPressure(points);
  return getStroke(
    points.map((p) => [p.x, p.y, p.pressure > 0 ? p.pressure : 0.5]),
    {
      size: width * 1.8,
      thinning: 0.6,
      smoothing: 0.5,
      streamline: 0.4,
      simulatePressure: !realPressure,
      start: { taper: 0, cap: true },
      end: { taper: 0, cap: true },
      last,
    }
  );
}

function buildPath(points: Point[], style: InkStyle, last: boolean): CachedPath {
  const variable =
    style.tool === 'pen' && style.penStyle === 'fountain' && !style.isShape && (style.lineStyle ?? 'solid') === 'solid';
  if (variable) {
    return { path: outlineToPath(fountainOutline(points, style.width, last)), filled: true };
  }
  return { path: centerlinePath(points, !style.isShape, !!style.closed), filled: false };
}

function paint(ctx: CanvasRenderingContext2D, built: CachedPath, style: InkStyle, opacity: number) {
  ctx.save();
  if (style.tool === 'highlighter') {
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = style.color;
    ctx.lineWidth = style.width * 5.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(built.path);
    ctx.restore();
    return;
  }
  ctx.globalAlpha = opacity;
  if (built.filled) {
    ctx.fillStyle = style.color;
    ctx.fill(built.path);
  } else {
    ctx.strokeStyle = style.color;
    ctx.lineWidth = style.width * (style.penStyle === 'ballpoint' && !style.isShape ? 1.5 : 1.4);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const ls = style.lineStyle ?? 'solid';
    if (ls === 'dashed') ctx.setLineDash([style.width * 4, style.width * 3]);
    else if (ls === 'dotted') {
      ctx.setLineDash([0.1, style.width * 3]);
      ctx.lineWidth = style.width * 1.8;
    }
    ctx.stroke(built.path);
  }
  ctx.restore();
}

export function styleOf(s: Stroke): InkStyle {
  return {
    tool: s.tool,
    color: s.color,
    width: s.width,
    penStyle: s.penStyle ?? 'fountain',
    lineStyle: s.lineStyle,
    isShape: s.isShape,
    closed: s.closed,
  };
}

export function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke) {
  if (s.points.length === 0) return;
  let built = cache.get(s);
  if (!built) {
    built = buildPath(s.points, styleOf(s), true);
    cache.set(s, built);
  }
  paint(ctx, built, styleOf(s), s.opacity ?? 1);
}

/** Renders a stroke that is still being drawn (not cached). */
export function drawLiveStroke(ctx: CanvasRenderingContext2D, points: Point[], style: InkStyle) {
  if (points.length === 0) return;
  paint(ctx, buildPath(points, style, false), style, 1);
}

/** Draws highlighters first (behind ink), like Notability's "highlighter behind text" default. */
export function drawStrokes(ctx: CanvasRenderingContext2D, strokes: Stroke[]) {
  for (const s of strokes) if (s.tool === 'highlighter') drawStroke(ctx, s);
  for (const s of strokes) if (s.tool !== 'highlighter') drawStroke(ctx, s);
}

/** SVG path data for vector export. */
export function strokeToSvg(s: Stroke, dy = 0): string {
  const style = styleOf(s);
  const pts = s.points.map((p) => ({ ...p, y: p.y + dy }));
  if (pts.length === 0) return '';
  if (style.tool === 'pen' && style.penStyle === 'fountain' && !style.isShape && (style.lineStyle ?? 'solid') === 'solid') {
    const outline = fountainOutline(pts, style.width, true);
    if (outline.length < 2) return '';
    let d = `M${outline[0][0].toFixed(2)} ${outline[0][1].toFixed(2)}`;
    for (let i = 1; i < outline.length; i++) {
      const [x0, y0] = outline[i - 1];
      const [x1, y1] = outline[i];
      d += ` Q${x0.toFixed(2)} ${y0.toFixed(2)} ${((x0 + x1) / 2).toFixed(2)} ${((y0 + y1) / 2).toFixed(2)}`;
    }
    return `<path d="${d} Z" fill="${s.color}" fill-opacity="${s.opacity ?? 1}"/>`;
  }
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ') + (s.closed ? ' Z' : '');
  if (style.tool === 'highlighter') {
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-opacity="0.35" stroke-width="${s.width * 5.5}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  const ls = style.lineStyle ?? 'solid';
  const dash =
    ls === 'dashed' ? ` stroke-dasharray="${s.width * 4},${s.width * 3}"` : ls === 'dotted' ? ` stroke-dasharray="0.1,${s.width * 3}"` : '';
  return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width * 1.4}" stroke-linecap="round" stroke-linejoin="round"${dash}/>`;
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers shared by the eraser and lasso.

export function strokeBounds(s: Stroke) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of s.points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const pad = s.tool === 'highlighter' ? s.width * 3 : s.width;
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

function distToSegment(px: number, py: number, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - a.x) * dx + (py - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

export function strokeHitTest(s: Stroke, x: number, y: number, radius: number): boolean {
  const b = strokeBounds(s);
  if (x < b.minX - radius || x > b.maxX + radius || y < b.minY - radius || y > b.maxY + radius) return false;
  const r = radius + (s.tool === 'highlighter' ? s.width * 2.75 : s.width * 0.9);
  const pts = s.points;
  if (pts.length === 1) return Math.hypot(pts[0].x - x, pts[0].y - y) <= r;
  for (let i = 1; i < pts.length; i++) if (distToSegment(x, y, pts[i - 1], pts[i]) <= r) return true;
  if (s.closed && pts.length > 2 && distToSegment(x, y, pts[pts.length - 1], pts[0]) <= r) return true;
  return false;
}

/** Inserts samples so no two consecutive points are further apart than `step` (needed for partial erasing of shapes). */
function densify(points: Point[], closed: boolean, step: number): Point[] {
  const src = closed && points.length > 2 ? [...points, points[0]] : points;
  const out: Point[] = [];
  for (let i = 0; i < src.length; i++) {
    if (i > 0) {
      const a = src[i - 1];
      const b = src[i];
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      const n = Math.floor(d / step);
      for (let k = 1; k < n; k++) {
        const t = k / n;
        out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, pressure: a.pressure + (b.pressure - a.pressure) * t });
      }
    }
    out.push(src[i]);
  }
  return out;
}

/**
 * Precision eraser (Notability's partial eraser): removes only the part of each stroke under the
 * eraser and splits the remainder into separate strokes.
 */
export function eraseStrokesPartial(
  strokes: Stroke[],
  x: number,
  y: number,
  radius: number,
  makeId: () => string
): { strokes: Stroke[]; changed: boolean } {
  let changed = false;
  const out: Stroke[] = [];
  for (const s of strokes) {
    if (!strokeHitTest(s, x, y, radius)) {
      out.push(s);
      continue;
    }
    changed = true;
    const r = radius + s.width * 0.6;
    const pts = densify(s.points, !!s.closed, Math.max(1.5, radius / 3));
    let run: Point[] = [];
    const flush = () => {
      if (run.length >= 2) out.push({ ...s, id: makeId(), points: run, closed: false });
      run = [];
    };
    for (const p of pts) {
      if (Math.hypot(p.x - x, p.y - y) <= r) flush();
      else run.push(p);
    }
    flush();
  }
  return { strokes: changed ? out : strokes, changed };
}
