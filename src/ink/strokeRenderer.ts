import { FillType, Point, Stroke, PenStyle, LineStyle, ShapeKind } from '../types';
import { Bezier, catmullRomBeziers, endTangent, flattenBeziers, XY } from './spline';
import { ModeledPoint, capsulePath, capsuleSvg, hasRealPressure, nibStroke, pressureWidth, thinModeled } from './engine';

/**
 * Ink renderer.
 *
 * Notability stores every curve as variable-width Bezier data (points + per-point fractional
 * width/force/altitude/azimuth, see InkObjectEncoder) and renders it with Metal. We keep the raw
 * samples and render with Canvas2D. Handwriting (pen and highlighter) goes through the smart pen's
 * spline engine (inkEngine.ts): thinned samples, centripetal Catmull-Rom curve, pressure-driven
 * width for the fountain pen. Shapes are drawn from their exact geometry.
 * Smart-pen curves (PDEDraw) are centripetal Catmull-Rom splines through their stored points;
 * closed strokes can be filled (solid, hatch patterns, or a "hole" that punches through fills).
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
  shapeKind?: ShapeKind;
  fill?: FillType;
  arrow?: boolean;
}

interface Built {
  path: Path2D;
  filled: boolean;
  /** Region used by fills (closed strokes only). */
  area: Path2D | null;
  arrow: Path2D | null;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

const cache = new WeakMap<Stroke, Built>();

function centerlinePath(points: XY[], smooth: boolean, closed: boolean): Path2D {
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

function bezierPath(segs: Bezier[], closed: boolean): Path2D {
  const path = new Path2D();
  if (!segs.length) return path;
  path.moveTo(segs[0][0].x, segs[0][0].y);
  for (const [, c1, c2, e] of segs) path.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, e.x, e.y);
  if (closed) path.closePath();
  return path;
}

/** Modelled centre line and per-point widths of a handwritten stroke (canvas, SVG and TikZ). */
export function inkGeometry(points: Point[], style: InkStyle): { pts: ModeledPoint[]; widths: number[] | null; width: number } {
  const pts = thinModeled(nibStroke(points));
  const width = style.tool === 'highlighter' ? style.width * 5.5 : strokeWidth(style);
  const widths = isVariableWidth(style) && hasRealPressure(points) ? pts.map((p) => pressureWidth(width, p.p)) : null;
  return { pts, widths, width };
}

function polylinePath(pts: XY[], closed = false): Path2D {
  const path = new Path2D();
  if (!pts.length) return path;
  path.moveTo(pts[0].x, pts[0].y);
  if (pts.length === 1) path.lineTo(pts[0].x + 0.01, pts[0].y);
  for (let i = 1; i < pts.length; i++) path.lineTo(pts[i].x, pts[i].y);
  if (closed) path.closePath();
  return path;
}

export function isVariableWidth(style: InkStyle): boolean {
  return style.tool === 'pen' && style.penStyle === 'fountain' && !style.isShape && (style.lineStyle ?? 'solid') === 'solid';
}

/** Spline segments of a smart-pen curve (exactly what is drawn and exported). */
export function curveSegments(points: XY[], closed: boolean): Bezier[] {
  return catmullRomBeziers(points, closed);
}

export function arrowSize(width: number): number {
  return Math.max(9, width * 4.6);
}

/** Arrowhead triangle (tip, wing, wing) at the end of an open stroke, 30° half-angle like PDEDraw. */
export function arrowHead(points: XY[], style: InkStyle): [XY, XY, XY] | null {
  let dir: { tip: XY; from: XY } | null = null;
  if (style.shapeKind === 'curve') dir = endTangent(curveSegments(points, false));
  else {
    const tip = points[points.length - 1];
    for (let i = points.length - 2; i >= 0; i--) {
      if (Math.hypot(points[i].x - tip.x, points[i].y - tip.y) > 2) {
        dir = { tip, from: points[i] };
        break;
      }
    }
  }
  if (!dir) return null;
  const ang = Math.atan2(dir.tip.y - dir.from.y, dir.tip.x - dir.from.x);
  const size = arrowSize(style.width);
  // Push the tip forward so the line's round cap ends inside the head instead of poking out.
  const ext = strokeWidth(style) * 0.9;
  const tip = { x: dir.tip.x + ext * Math.cos(ang), y: dir.tip.y + ext * Math.sin(ang) };
  const w = (a: number) => ({ x: tip.x - size * Math.cos(a), y: tip.y - size * Math.sin(a) });
  return [tip, w(ang - Math.PI / 6), w(ang + Math.PI / 6)];
}

function boundsOf(points: XY[], pad: number) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

function build(points: Point[], style: InkStyle, last: boolean): Built {
  const closed = !!style.closed && points.length > 2;
  const fillable = closed && !!style.fill && style.fill !== 'none';
  let path: Path2D;
  let filled = false;
  let area: Path2D | null = null;
  if (style.shapeKind === 'point') {
    path = new Path2D();
    const p = points[0];
    path.arc(p.x, p.y, Math.max(2.5, style.width * 1.7), 0, Math.PI * 2);
    filled = true;
  } else if (style.shapeKind === 'curve') {
    path = bezierPath(curveSegments(points, closed), closed);
    if (fillable) area = path;
  } else if (!style.isShape) {
    // Handwriting: modelled stroke (inkEngine.ts).
    const g = inkGeometry(points, style);
    if (g.widths) {
      path = capsulePath(g.pts, g.widths);
      filled = true;
    } else path = polylinePath(g.pts);
    if (fillable) area = polylinePath(g.pts, true);
  } else {
    path = centerlinePath(points, false, closed);
    if (fillable) area = path;
  }
  void last;
  let arrow: Path2D | null = null;
  if (style.arrow && !closed && style.shapeKind !== 'point' && points.length > 1) {
    const h = arrowHead(points, style);
    if (h) {
      arrow = new Path2D();
      arrow.moveTo(h[0].x, h[0].y);
      arrow.lineTo(h[1].x, h[1].y);
      arrow.lineTo(h[2].x, h[2].y);
      arrow.closePath();
    }
  }
  const pad = style.tool === 'highlighter' ? style.width * 3 : Math.max(style.width * 2, style.arrow ? arrowSize(style.width) : 0, 4);
  return { path, filled, area, arrow, bounds: boundsOf(points, pad) };
}

export interface PaintOptions {
  /** Paint "hole" fills with this colour instead of punching through the canvas (white-background rasters). */
  holeColor?: string;
}

const HATCH_SPACING = 8;

function paintFill(ctx: CanvasRenderingContext2D, b: Built, style: InkStyle, opts: PaintOptions) {
  if (!b.area || !style.fill || style.fill === 'none') return;
  ctx.save();
  if (style.fill === 'solid') {
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = style.color;
    ctx.fill(b.area, 'evenodd');
  } else if (style.fill === 'hole') {
    if (opts.holeColor) ctx.fillStyle = opts.holeColor;
    else {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = '#000';
    }
    ctx.fill(b.area, 'evenodd');
  } else {
    ctx.clip(b.area, 'evenodd');
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = style.color;
    ctx.lineWidth = 1.1;
    const { minX, minY, maxX, maxY } = b.bounds;
    const h = maxY - minY;
    ctx.beginPath();
    for (let x = minX - h; x < maxX + h; x += HATCH_SPACING) {
      if (style.fill === 'northEast' || style.fill === 'crosshatch') {
        ctx.moveTo(x, maxY);
        ctx.lineTo(x + h, minY);
      }
      if (style.fill === 'northWest' || style.fill === 'crosshatch') {
        ctx.moveTo(x, minY);
        ctx.lineTo(x + h, maxY);
      }
    }
    ctx.stroke();
  }
  ctx.restore();
}

function paintInk(ctx: CanvasRenderingContext2D, b: Built, style: InkStyle, opacity: number) {
  ctx.save();
  if (style.tool === 'highlighter') {
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = style.color;
    ctx.lineWidth = style.width * 5.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(b.path);
    ctx.restore();
    return;
  }
  ctx.globalAlpha = opacity;
  if (b.filled) {
    ctx.fillStyle = style.color;
    ctx.fill(b.path);
  } else {
    ctx.strokeStyle = style.color;
    ctx.lineWidth = strokeWidth(style);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const ls = style.lineStyle ?? 'solid';
    if (ls === 'dashed') ctx.setLineDash([style.width * 4, style.width * 3]);
    else if (ls === 'dotted') {
      ctx.setLineDash([0.1, style.width * 3]);
      ctx.lineWidth = style.width * 1.8;
    }
    ctx.stroke(b.path);
  }
  if (b.arrow) {
    ctx.setLineDash([]);
    ctx.fillStyle = style.color;
    ctx.fill(b.arrow);
  }
  ctx.restore();
}

export function strokeWidth(style: InkStyle): number {
  return style.width * (style.penStyle === 'ballpoint' && !style.isShape ? 1.5 : 1.4);
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
    shapeKind: s.shapeKind,
    fill: s.fill,
    arrow: s.arrow,
  };
}

function built(s: Stroke): Built {
  let b = cache.get(s);
  if (!b) {
    b = build(s.points, styleOf(s), true);
    cache.set(s, b);
  }
  return b;
}

export function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke, opts: PaintOptions = {}) {
  if (s.points.length === 0) return;
  const b = built(s);
  paintFill(ctx, b, styleOf(s), opts);
  paintInk(ctx, b, styleOf(s), s.opacity ?? 1);
}

/** Renders a stroke that is still being drawn (not cached). Returns the area it covers. */
export function drawLiveStroke(ctx: CanvasRenderingContext2D, points: Point[], style: InkStyle): Built['bounds'] | null {
  if (points.length === 0) return null;
  const b = build(points, style, false);
  paintFill(ctx, b, style.fill === 'hole' ? { ...style, fill: 'solid' } : style, {});
  paintInk(ctx, b, style, 1);
  return b.bounds;
}

/**
 * Draws a page's strokes: highlighters first (behind ink, Notability's default), then fills
 * (so holes cut through fills and highlighters but never through ink), then ink.
 */
export function drawStrokes(ctx: CanvasRenderingContext2D, strokes: Stroke[], opts: PaintOptions = {}) {
  for (const s of strokes) if (s.tool === 'highlighter') paintInk(ctx, built(s), styleOf(s), s.opacity ?? 1);
  for (const s of strokes) if (s.tool !== 'highlighter' && s.fill && s.fill !== 'none' && s.points.length) paintFill(ctx, built(s), styleOf(s), opts);
  for (const s of strokes) if (s.tool !== 'highlighter' && s.points.length) paintInk(ctx, built(s), styleOf(s), s.opacity ?? 1);
}

// ---------------------------------------------------------------------------------------------
// SVG export (same geometry as the canvas renderer).

const f2 = (v: number) => v.toFixed(2);

function svgBezierD(segs: Bezier[], closed: boolean): string {
  if (!segs.length) return '';
  let d = `M${f2(segs[0][0].x)} ${f2(segs[0][0].y)}`;
  for (const [, c1, c2, e] of segs) d += ` C${f2(c1.x)} ${f2(c1.y)} ${f2(c2.x)} ${f2(c2.y)} ${f2(e.x)} ${f2(e.y)}`;
  return d + (closed ? ' Z' : '');
}

function svgCenterlineD(pts: XY[], smooth: boolean, closed: boolean): string {
  if (!pts.length) return '';
  let d = `M${f2(pts[0].x)} ${f2(pts[0].y)}`;
  if (!smooth || pts.length < 3) d += pts.slice(1).map((p) => ` L${f2(p.x)} ${f2(p.y)}`).join('');
  else {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      d += ` Q${f2(a.x)} ${f2(a.y)} ${f2((a.x + b.x) / 2)} ${f2((a.y + b.y) / 2)}`;
    }
    d += ` L${f2(pts[pts.length - 1].x)} ${f2(pts[pts.length - 1].y)}`;
  }
  return d + (closed ? ' Z' : '');
}

let svgIds = 0;

function svgFill(style: InkStyle, areaD: string, pts: XY[], paper: string): string {
  if (!style.fill || style.fill === 'none') return '';
  if (style.fill === 'solid') return `<path d="${areaD}" fill="${style.color}" fill-opacity="0.22" fill-rule="evenodd" stroke="none"/>`;
  if (style.fill === 'hole') return `<path d="${areaD}" fill="${paper}" fill-rule="evenodd" stroke="none"/>`;
  const id = `onh${(svgIds++).toString(36)}`;
  const b = boundsOf(pts, 0);
  const h = b.maxY - b.minY;
  let lines = '';
  for (let x = b.minX - h; x < b.maxX + h; x += HATCH_SPACING) {
    if (style.fill === 'northEast' || style.fill === 'crosshatch') lines += `M${f2(x)} ${f2(b.maxY)} L${f2(x + h)} ${f2(b.minY)} `;
    if (style.fill === 'northWest' || style.fill === 'crosshatch') lines += `M${f2(x)} ${f2(b.minY)} L${f2(x + h)} ${f2(b.maxY)} `;
  }
  return `<clipPath id="${id}"><path d="${areaD}" clip-rule="evenodd"/></clipPath><path d="${lines.trim()}" clip-path="url(#${id})" stroke="${style.color}" stroke-opacity="0.5" stroke-width="1.1" fill="none"/>`;
}

/** SVG for vector export. `paper` is the colour used for "hole" fills. */
export function strokeToSvg(s: Stroke, dy = 0, paper = '#FFFFFF'): string {
  const style = styleOf(s);
  const pts = s.points.map((p) => ({ ...p, y: p.y + dy }));
  if (pts.length === 0) return '';
  const closed = !!s.closed && pts.length > 2;
  const opacity = s.opacity ?? 1;

  if (s.shapeKind === 'point') {
    return `<circle cx="${f2(pts[0].x)}" cy="${f2(pts[0].y)}" r="${f2(Math.max(2.5, s.width * 1.7))}" fill="${s.color}" fill-opacity="${opacity}"/>`;
  }
  let out = '';
  let lineD: string;
  let areaD: string;
  const ink = !s.isShape ? inkGeometry(pts, style) : null;
  if (s.shapeKind === 'curve') {
    lineD = areaD = svgBezierD(curveSegments(pts, closed), closed);
  } else if (ink) {
    lineD = svgCenterlineD(ink.pts, false, false) + (ink.pts.length === 1 ? ' l0.01 0' : '');
    areaD = svgCenterlineD(ink.pts, false, true);
  } else {
    lineD = areaD = svgCenterlineD(pts, false, closed);
  }
  if (closed) out += svgFill(style, areaD, pts, paper);

  if (ink?.widths && style.tool === 'pen') {
    let d = '';
    const w = ink.widths;
    for (let i = 1; i < ink.pts.length; i++) d += capsuleSvg(ink.pts[i - 1], w[i - 1] / 2, ink.pts[i], w[i] / 2, f2);
    if (ink.pts.length === 1) d = capsuleSvg(ink.pts[0], w[0] / 2, ink.pts[0], w[0] / 2, f2);
    out += `<path d="${d}" fill="${s.color}" fill-opacity="${opacity}" fill-rule="nonzero"/>`;
  } else if (style.tool === 'highlighter') {
    out += `<path d="${lineD}" fill="none" stroke="${s.color}" stroke-opacity="0.35" stroke-width="${s.width * 5.5}" stroke-linecap="round" stroke-linejoin="round"/>`;
  } else {
    const ls = style.lineStyle ?? 'solid';
    const dash =
      ls === 'dashed' ? ` stroke-dasharray="${s.width * 4},${s.width * 3}"` : ls === 'dotted' ? ` stroke-dasharray="0.1,${s.width * 3}"` : '';
    const w = ls === 'dotted' ? s.width * 1.8 : strokeWidth(style);
    out += `<path d="${lineD}" fill="none" stroke="${s.color}" stroke-opacity="${opacity}" stroke-width="${f2(w)}" stroke-linecap="round" stroke-linejoin="round"${dash}/>`;
  }
  if (s.arrow && !closed) {
    const h = arrowHead(pts, style);
    if (h) out += `<path d="M${f2(h[0].x)} ${f2(h[0].y)} L${f2(h[1].x)} ${f2(h[1].y)} L${f2(h[2].x)} ${f2(h[2].y)} Z" fill="${s.color}"/>`;
  }
  return out;
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

function distToSegment(px: number, py: number, a: XY, b: XY): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - a.x) * dx + (py - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

function insidePolygon(x: number, y: number, poly: XY[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function strokeHitTest(s: Stroke, x: number, y: number, radius: number): boolean {
  const b = strokeBounds(s);
  if (x < b.minX - radius || x > b.maxX + radius || y < b.minY - radius || y > b.maxY + radius) return false;
  const r = radius + (s.tool === 'highlighter' ? s.width * 2.75 : s.width * 0.9);
  const pts = s.points;
  if (pts.length === 1) return Math.hypot(pts[0].x - x, pts[0].y - y) <= r + (s.shapeKind === 'point' ? s.width : 0);
  for (let i = 1; i < pts.length; i++) if (distToSegment(x, y, pts[i - 1], pts[i]) <= r) return true;
  if (s.closed && pts.length > 2) {
    if (distToSegment(x, y, pts[pts.length - 1], pts[0]) <= r) return true;
    // Filled regions can be erased/picked by touching their inside.
    if (s.fill && s.fill !== 'none' && s.fill !== 'hole' && insidePolygon(x, y, pts)) return true;
  }
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

/** Keeps roughly one point every `spacing` units (always keeping both ends). */
function thin(points: Point[], spacing: number): Point[] {
  if (points.length < 3) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const l = out[out.length - 1];
    if (Math.hypot(points[i].x - l.x, points[i].y - l.y) >= spacing) out.push(points[i]);
  }
  out.push(points[points.length - 1]);
  return out;
}

/**
 * Precision eraser (Notability's partial eraser): removes only the part of each stroke under the
 * eraser and splits the remainder into separate strokes. Smart-pen curves are cut along the
 * drawn spline and stay curves; other shapes become open polylines.
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
    if (s.shapeKind === 'point') continue;
    const r = radius + s.width * 0.6;
    const curve = s.shapeKind === 'curve';
    const closed = !!s.closed && s.points.length > 2;
    const pts: Point[] = curve
      ? flattenBeziers(curveSegments(s.points, closed), 1.5).map((p) => ({ x: p.x, y: p.y, pressure: 0.5 }))
      : densify(s.points, closed, Math.max(1.5, radius / 3));
    const lastIndex = pts.length - 1;
    let run: Point[] = [];
    let runEnd = -1;
    const flush = () => {
      if (run.length >= 2) {
        const keepsEnd = runEnd === lastIndex && !closed;
        out.push({
          ...s,
          id: makeId(),
          points: curve ? thin(run, 4.5) : run,
          closed: false,
          fill: undefined,
          arrow: keepsEnd ? s.arrow : undefined,
          ...(s.isShape && !curve ? { shapeKind: 'polyline' as ShapeKind } : {}),
        });
      }
      run = [];
    };
    pts.forEach((p, i) => {
      if (Math.hypot(p.x - x, p.y - y) <= r) flush();
      else {
        run.push(p);
        runEnd = i;
      }
    });
    flush();
  }
  return { strokes: changed ? out : strokes, changed };
}
