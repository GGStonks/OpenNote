import { FillType, Point, Stroke, PenStyle, LineStyle, ShapeKind } from '../types';
import { itemTime } from '../editor/zorder';
import { Bezier, catmullRomBeziers, endTangent, flattenBeziers, XY } from './spline';
import { ModeledPoint, capsulePath, capsuleSvg, hasRealPressure, nibStroke, pressureWidth, thinModeled } from './engine';

/**
 * Ink renderer.
 *
 * We keep the raw samples and render with Canvas2D. Handwriting (pen and highlighter) goes through the smart pen's
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
  /** A solid fill's own colour and opacity (Stroke.fillColor / fillOpacity). */
  fillColor?: string;
  fillOpacity?: number;
  arrow?: boolean;
  /** The points are already the modelled centre line (Stroke.modeled). */
  modeled?: 'variable' | 'uniform' | 'proportional';
  /** Start of the dash pattern (Stroke.dashOffset). */
  dashOffset?: number;
  /** Fill only, no outline (Stroke.fillOnly). */
  fillOnly?: boolean;
  /** Highlighters: how opaque (Stroke.highlightAlpha; missing: 0.35). */
  highlightAlpha?: number;
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

/** Creates the renderer's paths; swapped while a drawing is recorded for the app shell (inkRecorder.ts). */
let makePath: () => Path2D = () => new Path2D();
const newPath = () => makePath();

/** Runs `fn` with the renderer's paths made by `factory` (to record a live drawing as commands). */
export function withPathFactory<T>(factory: () => Path2D, fn: () => T): T {
  const prev = makePath;
  makePath = factory;
  try {
    return fn();
  } finally {
    makePath = prev;
  }
}

function centerlinePath(points: XY[], smooth: boolean, closed: boolean): Path2D {
  const path = newPath();
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
  const path = newPath();
  if (!segs.length) return path;
  path.moveTo(segs[0][0].x, segs[0][0].y);
  for (const [, c1, c2, e] of segs) path.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, e.x, e.y);
  if (closed) path.closePath();
  return path;
}

/** The ink engine's centre line of handwriting (stored modelled points are used as they are). */
export function modeledLine(points: Point[], modeled?: InkStyle['modeled']): ModeledPoint[] {
  if (modeled) return points.map((q) => ({ x: q.x, y: q.y, p: q.pressure, t: q.t ?? 0 }));
  return nibStroke(points);
}

/** Modelled centre line and per-point widths of a handwritten stroke (canvas, SVG and TikZ). */
export function inkGeometry(points: Point[], style: InkStyle): { pts: ModeledPoint[]; widths: number[] | null; width: number } {
  const pts = thinModeled(modeledLine(points, style.modeled));
  const width = style.tool === 'highlighter' ? style.width * 5.5 : strokeWidth(style);
  const pressured = style.modeled ? style.modeled !== 'uniform' : hasRealPressure(points);
  const share = style.modeled === 'proportional';
  const widths = isVariableWidth(style) && pressured ? pts.map((p) => (share ? width * Math.max(0.02, p.p) : pressureWidth(width, p.p))) : null;
  return { pts, widths, width };
}

type InkGeometry = ReturnType<typeof inkGeometry>;
const geometryCache = new WeakMap<Stroke, InkGeometry>();

/** The point a stroke's line continues to after the ink engine's end (Stroke.penEnd), or null. */
export function penEnd(s: Stroke): Point | null {
  return s.penEnd && !s.modeled && !s.isShape && s.points.length > 1 ? s.points[s.points.length - 1] : null;
}

/** The points the ink engine models: all but the pen end. */
function enginePoints(s: Stroke): Point[] {
  return penEnd(s) ? s.points.slice(0, -1) : s.points;
}

/**
 * The line continued straight to the pen end at its last point's width: what the shells drew from
 * the line's end to the Pencil (the lead) while the pen was down.
 */
function toPenEnd<G extends { pts: ModeledPoint[]; widths: number[] | null }>(g: G, end: Point | null): G {
  const last = g.pts[g.pts.length - 1];
  if (!end || !last || Math.hypot(end.x - last.x, end.y - last.y) < 0.05) return g;
  return {
    ...g,
    pts: [...g.pts, { x: end.x, y: end.y, p: last.p, t: last.t }],
    widths: g.widths ? [...g.widths, g.widths[g.widths.length - 1]] : null,
  };
}

/** The modelled centre line of a stroke, to its pen end (TikZ). */
export function strokeLine(s: Stroke): ModeledPoint[] {
  return toPenEnd({ pts: modeledLine(enginePoints(s), s.modeled), widths: null }, penEnd(s)).pts;
}

/**
 * The line of a committed stroke as it is drawn everywhere (canvas, SVG, eraser), cached per
 * stroke (a moved copy reuses its original's, moved): the ink engine's line, smoothed except its
 * last SMOOTH_SETTLE (settledSmooth). The live ink (SmoothLiveStroke, nativeInk.ts) draws the very
 * same line while the pen moves, so it neither shows straight pieces between samples (fast strokes
 * on Android looked segmented) nor shifts when the pen lifts. Pieces cut by the precision eraser
 * ('modeled') are already that line.
 */
export function strokeGeometry(s: Stroke): InkGeometry {
  let g = geometryCache.get(s);
  if (g) return g;
  const m = movedFrom.get(s);
  if (m && m.src.points.length === s.points.length) {
    const o = strokeGeometry(m.src);
    g = { ...o, pts: o.pts.map((q) => ({ ...q, x: q.x + m.dx, y: q.y + m.dy })) };
  } else {
    const style = styleOf(s);
    g = inkGeometry(enginePoints(s), style);
    if (!style.modeled && !s.isShape) g = settledSmooth(g);
    // After the smoothing, which is then the very line drawn live (the pen end is not smoothed in).
    g = toPenEnd(g, penEnd(s));
  }
  geometryCache.set(s, g);
  return g;
}

/**
 * Index of the first point less than SMOOTH_SETTLE (along the line) from its end: points before it
 * can no longer change when the line goes on (their smoothing window only reaches settled points).
 */
export function settledIndex(pts: readonly XY[]): number {
  let back = 0, i = pts.length - 1;
  while (i > 0 && back < SMOOTH_SETTLE) {
    back += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    i--;
  }
  return Math.max(0, i);
}

/** The line smoothed up to settledIndex: the same for a stroke being written and once finished. */
export function settledSmooth(g: InkGeometry): InkGeometry {
  return smoothLine(g, settledIndex(g.pts));
}

/** Smoothing of the zoomed-in line: Gaussian width along the line (page px). */
const SMOOTH_SIGMA = 1.6;
/** A turn sharper than this (degrees, over about a px either side) is a corner: the line is smoothed on either side of it. */
const CORNER_DEG = 55;

/**
 * The modelled line made smooth for zoomed-in display. The ink engine's line is nearly straight
 * between two Pencil samples (a few page px apart) and bends where they are; at 100% that is
 * invisible, but zoomed to 300-500% the ink showed as straight pieces joined at angles. Each point
 * is replaced by a Gaussian average (SMOOTH_SIGMA) of its neighbours along the line, its widths and
 * pressure likewise; the window narrows towards the ends so they stay where they are, and the line
 * is smoothed in pieces between sharp corners, so a cusp stays a cusp. Used for vector ink (zoomed
 * in, print, export) and the pinch overlay; the page canvases at ordinary zoom keep the engine's
 * line, as drawn live.
 */
export function smoothGeometry(g: InkGeometry): InkGeometry {
  return smoothLine(g, g.pts.length);
}

/** How far before the end of a line still being written its smooth line can change (page px). */
export const SMOOTH_SETTLE = 6 * SMOOTH_SIGMA;

/**
 * smoothGeometry for points [from, upTo) only (the rest as they are): a line still being written is
 * smoothed up to SMOOTH_SETTLE before its end (nativeInk.ts), where later points can no longer
 * change it, so the live ink is the same smooth line the committed stroke gets.
 */
export function smoothLine(g: InkGeometry, upTo: number, from = 0): InkGeometry {
  const P = g.pts, n = P.length;
  if (n < 5 || upTo <= 0) return g;
  const d = (a: XY, b: XY) => Math.hypot(a.x - b.x, a.y - b.y);
  const at = new Float64Array(n);
  for (let i = 1; i < n; i++) at[i] = at[i - 1] + d(P[i], P[i - 1]);
  // Corners split the line into pieces smoothed on their own.
  const cuts = [0];
  for (let i = 1; i < n - 1; i++) {
    let a = i, b = i;
    while (a > 0 && at[i] - at[a] < 1) a--;
    while (b < n - 1 && at[b] - at[i] < 1) b++;
    if (a === i || b === i) continue;
    const t1 = Math.atan2(P[i].y - P[a].y, P[i].x - P[a].x), t2 = Math.atan2(P[b].y - P[i].y, P[b].x - P[i].x);
    let turn = Math.abs(t2 - t1);
    if (turn > Math.PI) turn = 2 * Math.PI - turn;
    if ((turn * 180) / Math.PI > CORNER_DEG && at[i] - at[cuts[cuts.length - 1]] > 1) cuts.push(i);
  }
  cuts.push(n - 1);
  const pts: ModeledPoint[] = P.map((q) => ({ ...q }));
  const widths = g.widths ? g.widths.slice() : null;
  const sig = SMOOTH_SIGMA, inv = 1 / (2 * sig * sig);
  for (let c = 0; c < cuts.length - 1; c++) {
    const lo = cuts[c], hi = cuts[c + 1];
    if (hi <= from) continue;
    for (let i = Math.max(lo + 1, from); i < hi && i < upTo; i++) {
      // Symmetric window, no wider than the distance to either end of the piece.
      const half = Math.min(3 * sig, at[i] - at[lo], at[hi] - at[i]);
      if (half <= 0) continue;
      let sx = 0, sy = 0, sp = 0, sw = 0, ws = 0;
      for (let j = i; j >= lo && at[i] - at[j] <= half; j--) {
        const w = Math.exp(-((at[i] - at[j]) ** 2) * inv);
        sx += P[j].x * w; sy += P[j].y * w; sp += P[j].p * w; ws += w;
        if (widths) sw += g.widths![j] * w;
      }
      for (let j = i + 1; j <= hi && at[j] - at[i] <= half; j++) {
        const w = Math.exp(-((at[j] - at[i]) ** 2) * inv);
        sx += P[j].x * w; sy += P[j].y * w; sp += P[j].p * w; ws += w;
        if (widths) sw += g.widths![j] * w;
      }
      pts[i] = { x: sx / ws, y: sy / ws, p: sp / ws, t: P[i].t };
      if (widths) widths[i] = sw / ws;
    }
  }
  return { pts, widths, width: g.width };
}

/** smoothGeometry of a committed stroke, cached (a moved copy reuses its original's, moved). */
export function strokeGeometrySmooth(s: Stroke): InkGeometry {
  // Every stroke is drawn as its settled-smooth line now (strokeGeometry): no second smoothing.
  return strokeGeometry(s);
}

function polylinePath(pts: XY[], closed = false): Path2D {
  const path = newPath();
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

function build(points: Point[], style: InkStyle, last: boolean, stroke?: Stroke, smooth = false): Built {
  const closed = !!style.closed && points.length > 2;
  const fillable = closed && !!style.fill && style.fill !== 'none';
  let path: Path2D;
  let filled = false;
  let area: Path2D | null = null;
  if (style.shapeKind === 'point') {
    path = newPath();
    const p = points[0];
    path.arc(p.x, p.y, Math.max(2.5, style.width * 1.7), 0, Math.PI * 2);
    filled = true;
  } else if (style.shapeKind === 'curve') {
    path = bezierPath(curveSegments(points, closed), closed);
    if (fillable) area = path;
  } else if (!style.isShape) {
    // Handwriting: modelled stroke (inkEngine.ts).
    const g = stroke ? (smooth ? strokeGeometrySmooth(stroke) : strokeGeometry(stroke)) : inkGeometry(points, style);
    if (g.widths) {
      path = capsulePath(g.pts, g.widths, 0, newPath());
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
      arrow = newPath();
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
  /** Handwriting as the smooth line (smoothGeometry): page canvases zoomed in past SMOOTH_ZOOM. */
  smooth?: boolean;
  /** Every stroke in this colour instead of its own (the selection glow). */
  color?: string;
}

const HATCH_SPACING = 8;

function paintFill(ctx: CanvasRenderingContext2D, b: Built, style: InkStyle, opts: PaintOptions) {
  if (!b.area || !style.fill || style.fill === 'none') return;
  ctx.save();
  if (style.fill === 'solid') {
    ctx.globalAlpha = style.fillOpacity ?? 0.22;
    ctx.fillStyle = style.fillColor ?? style.color;
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

/**
 * A highlighter's dashes (imported: Notability dashes highlighters too), in its drawn width W
 * (5.5 x width): dashes W long, round ends, a gap of 0.6 W; dots W across, 1.6 W apart.
 */
export function highlighterDash(style: InkStyle): { on: number; off: number } | null {
  const ls = style.lineStyle ?? 'solid';
  if (style.tool !== 'highlighter' || ls === 'solid') return null;
  const w = style.width * 5.5;
  return ls === 'dashed' ? { on: w, off: w * 1.6 } : { on: 0.1, off: w * 1.6 };
}

function paintInk(ctx: CanvasRenderingContext2D, b: Built, style: InkStyle, opacity: number) {
  if (style.fillOnly) return;
  ctx.save();
  if (style.tool === 'highlighter') {
    ctx.globalAlpha = style.highlightAlpha ?? 0.35;
    ctx.strokeStyle = style.color;
    ctx.lineWidth = style.width * 5.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const dash = highlighterDash(style);
    if (dash) ctx.setLineDash([dash.on, dash.off]);
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
    if (ls !== 'solid' && style.dashOffset) ctx.lineDashOffset = style.dashOffset;
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
    fillColor: s.fillColor,
    fillOpacity: s.fillOpacity,
    arrow: s.arrow,
    modeled: s.modeled,
    dashOffset: s.dashOffset,
    fillOnly: s.fillOnly,
    highlightAlpha: s.highlightAlpha,
  };
}

/** Strokes that are another stroke moved by (dx, dy): their geometry is the original's, moved. */
const movedFrom = new WeakMap<Stroke, { src: Stroke; dx: number; dy: number }>();

/**
 * Records that `copy` is `src` moved by (dx, dy) (same style, every point moved): its geometry is
 * then the original's moved, instead of the ink engine modelling the whole stroke again. Page
 * thumbnails (every stroke moved into its page's frame), dropping a lasso selection, paste and
 * duplicate made long notes stall on modelling thousands of strokes again.
 */
export function markMoved(copy: Stroke, src: Stroke, dx: number, dy: number): Stroke {
  const m = movedFrom.get(src);
  movedFrom.set(copy, m ? { src: m.src, dx: m.dx + dx, dy: m.dy + dy } : { src, dx, dy });
  return copy;
}

function movedPath(p: Path2D, dx: number, dy: number): Path2D {
  const out = newPath();
  out.addPath(p, new DOMMatrix([1, 0, 0, 1, dx, dy]));
  return out;
}

/** The smooth line's paths (zoomed in), cached apart from the engine line's. */
const smoothBuilt = new WeakMap<Stroke, Built>();

function built(s: Stroke, smooth = false): Built {
  // Only handwriting has a smooth variant; shapes are the same either way.
  if (smooth && s.isShape) smooth = false;
  const store = smooth ? smoothBuilt : cache;
  let b = store.get(s);
  if (!b) {
    const m = movedFrom.get(s);
    if (m && m.src.points.length === s.points.length && typeof DOMMatrix !== 'undefined') {
      const o = built(m.src, smooth);
      b = {
        path: movedPath(o.path, m.dx, m.dy),
        filled: o.filled,
        area: o.area ? (o.area === o.path ? null : movedPath(o.area, m.dx, m.dy)) : null,
        arrow: o.arrow ? movedPath(o.arrow, m.dx, m.dy) : null,
        bounds: { minX: o.bounds.minX + m.dx, minY: o.bounds.minY + m.dy, maxX: o.bounds.maxX + m.dx, maxY: o.bounds.maxY + m.dy },
      };
      if (o.area === o.path) b.area = b.path;
    } else b = build(s.points, styleOf(s), true, s, smooth);
    store.set(s, b);
  }
  return b;
}

/**
 * Builds a committed stroke's geometry ahead of its first paint (cached like a paint would).
 * Returns false if it was already built.
 */
export function prepareStroke(s: Stroke): boolean {
  if (!s.points.length || cache.has(s)) return false;
  built(s);
  return true;
}

/** Whether painting the stroke (as the smooth line or not) can use built geometry (is cheap). */
export function strokeBuilt(s: Stroke, smooth = false): boolean {
  return (smooth && !s.isShape ? smoothBuilt : cache).has(s);
}

/** drawStrokes' fill pass for one stroke (to paint a list of strokes in slices). */
export function paintStrokeFill(ctx: CanvasRenderingContext2D, s: Stroke, opts: PaintOptions = {}) {
  if (s.points.length) paintFill(ctx, built(s, opts.smooth), styleOf(s), opts);
}

/** drawStrokes' ink pass for one stroke. */
export function paintStrokeInk(ctx: CanvasRenderingContext2D, s: Stroke, opts: PaintOptions = {}) {
  if (s.points.length) paintInk(ctx, built(s, opts.smooth), styleOf(s), s.opacity ?? 1);
}

/** The area a committed stroke paints (ink, fill, arrowhead), from its cached geometry. */
export function strokePaintBounds(s: Stroke): Built['bounds'] {
  return built(s).bounds;
}

export function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke, opts: PaintOptions = {}) {
  if (s.points.length === 0) return;
  const b = built(s, opts.smooth);
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
  const sm = opts.smooth;
  const style = (s: Stroke) => (opts.color ? { ...styleOf(s), color: opts.color } : styleOf(s));
  for (const s of strokes) if (s.tool === 'highlighter') paintInk(ctx, built(s, sm), style(s), s.opacity ?? 1);
  for (const s of strokes) if (s.tool !== 'highlighter' && s.fill && s.fill !== 'none' && s.points.length) paintFill(ctx, built(s, sm), style(s), opts);
  for (const s of strokes) if (s.tool !== 'highlighter' && s.points.length) paintInk(ctx, built(s, sm), style(s), s.opacity ?? 1);
}

// ---------------------------------------------------------------------------------------------
// GPU geometry (glInk.ts): the same ink as round-ended pieces.

/**
 * What a stroke paints, for the GPU renderer that draws the ink while two fingers zoom (glInk.ts):
 * `caps`, its ink as round-ended pieces (ax, ay, ra, bx, by, rb per piece, a circle of radius ra at
 * a to one of rb at b and the lines tangent to both: the engine's addCapsule); `area`, the polygon
 * a fill covers (even-odd); `arrow`, the arrowhead. Follows build() and paintInk() exactly: a
 * fountain line is its capsules, a stroked line round-capped and round-joined pieces of its width
 * (dashes and dots as pieces of their own), a highlighter 5.5 x its width.
 */
export function strokeGlGeometry(s: Stroke): { caps: number[]; area: XY[] | null; arrow: [XY, XY, XY] | null } {
  const style = styleOf(s);
  const points = s.points;
  const closed = !!style.closed && points.length > 2;
  const fillable = closed && !!style.fill && style.fill !== 'none';
  const caps: number[] = [];
  let area: XY[] | null = null;
  const highlighter = style.tool === 'highlighter';
  const stroked = (pts: XY[]) => strokeCaps(caps, pts, highlighter ? style.width * 5.5 : strokeWidth(style), style.lineStyle ?? 'solid', style);
  if (style.shapeKind === 'point') {
    const p = points[0], r = Math.max(2.5, style.width * 1.7);
    caps.push(p.x, p.y, r, p.x, p.y, r);
  } else if (style.shapeKind === 'curve') {
    const line = flattenBeziers(curveSegments(points, closed));
    if (closed && line.length > 1 && (line[0].x !== line[line.length - 1].x || line[0].y !== line[line.length - 1].y)) line.push(line[0]);
    stroked(line);
    if (fillable) area = line;
  } else if (!style.isShape) {
    const g = strokeGeometry(s);
    if (g.widths && !highlighter) chainCaps(caps, g.pts, g.widths.map((w) => w / 2));
    else stroked(g.pts);
    if (fillable) area = g.pts;
  } else {
    stroked(closed ? [...points, points[0]] : points);
    if (fillable) area = points;
  }
  const arrow = style.arrow && !closed && style.shapeKind !== 'point' && points.length > 1 ? arrowHead(points, style) : null;
  if (style.fillOnly && !highlighter) caps.length = 0;
  return { caps, area, arrow };
}

/**
 * How far (surface px) a merged piece may stray from the points it replaces, in place and width:
 * a sixth of a screen pixel at the highest zoom (5 x, 2 x pixel ratio): coarser, curves showed
 * their straight pieces at 500%.
 */
const GL_TOLERANCE = 0.015;

/**
 * The pieces from point to point, with the points that a straight piece passes within
 * GL_TOLERANCE of (place and radius) merged: the GPU computes each pixel of a piece, and the dense
 * points of handwriting under a wide pen made every pixel of ink computed many times over.
 */
function chainCaps(out: number[], pts: XY[], radii: number[]) {
  const n = pts.length;
  if (!n) return;
  if (n === 1) {
    out.push(pts[0].x, pts[0].y, radii[0], pts[0].x, pts[0].y, radii[0]);
    return;
  }
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    const a = pts[i], b = pts[j];
    const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
    let worst = -1, at = -1;
    for (let k = i + 1; k < j; k++) {
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((pts[k].x - a.x) * dx + (pts[k].y - a.y) * dy) / len2)) : 0;
      const ex = a.x + dx * t - pts[k].x, ey = a.y + dy * t - pts[k].y;
      const er = radii[i] + (radii[j] - radii[i]) * t - radii[k];
      const e = Math.max(Math.hypot(ex, ey), Math.abs(er));
      if (e > worst) [worst, at] = [e, k];
    }
    if (worst > GL_TOLERANCE) {
      keep[at] = 1;
      stack.push([i, at], [at, j]);
    }
  }
  let prev = 0;
  for (let k = 1; k < n; k++) {
    if (!keep[k]) continue;
    out.push(pts[prev].x, pts[prev].y, radii[prev], pts[k].x, pts[k].y, radii[k]);
    prev = k;
  }
}

/** A line `width` wide through pts, round-capped and round-joined, dashed as paintInk dashes it. */
function strokeCaps(out: number[], pts: XY[], width: number, ls: LineStyle, style: InkStyle) {
  if (!pts.length) return;
  let r = width / 2;
  if (pts.length === 1) {
    out.push(pts[0].x, pts[0].y, r, pts[0].x + 0.01, pts[0].y, r);
    return;
  }
  if (ls === 'solid') {
    chainCaps(out, pts, pts.map(() => r));
    return;
  }
  // Dashes: the canvas's pattern ([on, off], shifted by dashOffset) walked along the line.
  const hl = highlighterDash(style);
  const on = hl ? hl.on : ls === 'dashed' ? style.width * 4 : 0.1;
  const off = hl ? hl.off : style.width * 3;
  if (ls === 'dotted' && !hl) r = (style.width * 1.8) / 2;
  const period = on + off;
  let at = (((style.dashOffset ?? 0) % period) + period) % period;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    let d = 0;
    while (d < len) {
      const inOn = at < on;
      const step = Math.min(len - d, (inOn ? on : period) - at);
      if (inOn) {
        const t0 = d / len, t1 = (d + step) / len;
        out.push(a.x + (b.x - a.x) * t0, a.y + (b.y - a.y) * t0, r, a.x + (b.x - a.x) * t1, a.y + (b.y - a.y) * t1, r);
      }
      d += step;
      at = (at + step) % period;
      if (step <= 0) break;
    }
  }
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
  if (style.fill === 'solid') return `<path d="${areaD}" fill="${style.fillColor ?? style.color}" fill-opacity="${style.fillOpacity ?? 0.22}" fill-rule="evenodd" stroke="none"/>`;
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
  const { fill, ink } = svgParts(s, dy, paper);
  return fill + ink;
}

const svgPartsCache = new WeakMap<Stroke, { fill: string; ink: string }>();

/**
 * A stroke's SVG as its fill and its ink, cached: the page's vector ink (VectorInk in CanvasPage)
 * draws all fills under all ink, as drawStrokes does. "Hole" fills come out in white here (the
 * canvas punches them through): pages with one keep their canvas.
 */
export function strokeSvgParts(s: Stroke): { fill: string; ink: string } {
  let p = svgPartsCache.get(s);
  if (!p) {
    p = svgParts(s, 0, '#FFFFFF');
    svgPartsCache.set(s, p);
  }
  return p;
}

function svgParts(s: Stroke, dy: number, paper: string): { fill: string; ink: string } {
  const style = styleOf(s);
  const pts = s.points.map((p) => ({ ...p, y: p.y + dy }));
  if (pts.length === 0) return { fill: '', ink: '' };
  const closed = !!s.closed && pts.length > 2;
  const opacity = s.opacity ?? 1;

  if (s.shapeKind === 'point') {
    return { fill: '', ink: `<circle cx="${f2(pts[0].x)}" cy="${f2(pts[0].y)}" r="${f2(Math.max(2.5, s.width * 1.7))}" fill="${s.color}" fill-opacity="${opacity}"/>` };
  }
  let out = '';
  let lineD: string;
  let areaD: string;
  // SVG is the zoomed-in, printed and exported ink: the smooth line (see smoothGeometry).
  const geo = !s.isShape ? strokeGeometrySmooth(s) : null;
  const ink = geo && dy ? { ...geo, pts: geo.pts.map((q) => ({ ...q, y: q.y + dy })) } : geo;
  if (s.shapeKind === 'curve') {
    lineD = areaD = svgBezierD(curveSegments(pts, closed), closed);
  } else if (ink) {
    lineD = svgCenterlineD(ink.pts, false, false) + (ink.pts.length === 1 ? ' l0.01 0' : '');
    areaD = svgCenterlineD(ink.pts, false, true);
  } else {
    lineD = areaD = svgCenterlineD(pts, false, closed);
  }
  const fill = closed ? svgFill(style, areaD, pts, paper) : '';
  if (s.fillOnly) return { fill, ink: '' };

  if (ink?.widths && style.tool === 'pen') {
    let d = '';
    const w = ink.widths;
    for (let i = 1; i < ink.pts.length; i++) d += capsuleSvg(ink.pts[i - 1], w[i - 1] / 2, ink.pts[i], w[i] / 2, f2);
    if (ink.pts.length === 1) d = capsuleSvg(ink.pts[0], w[0] / 2, ink.pts[0], w[0] / 2, f2);
    out += `<path d="${d}" fill="${s.color}" fill-opacity="${opacity}" fill-rule="nonzero"/>`;
  } else if (style.tool === 'highlighter') {
    const dash = highlighterDash(style);
    out += `<path d="${lineD}" fill="none" stroke="${s.color}" stroke-opacity="${s.highlightAlpha ?? 0.35}" stroke-width="${s.width * 5.5}" stroke-linecap="round" stroke-linejoin="round"${dash ? ` stroke-dasharray="${f2(dash.on)},${f2(dash.off)}"` : ''}/>`;
  } else {
    const ls = style.lineStyle ?? 'solid';
    const dash =
      ls === 'dashed' ? ` stroke-dasharray="${s.width * 4},${s.width * 3}"` : ls === 'dotted' ? ` stroke-dasharray="0.1,${s.width * 3}"` : '';
    const w = ls === 'dotted' ? s.width * 1.8 : strokeWidth(style);
    const offset = dash && s.dashOffset ? ` stroke-dashoffset="${f2(s.dashOffset)}"` : '';
    out += `<path d="${lineD}" fill="none" stroke="${s.color}" stroke-opacity="${opacity}" stroke-width="${f2(w)}" stroke-linecap="round" stroke-linejoin="round"${dash}${offset}/>`;
  }
  if (s.arrow && !closed) {
    const h = arrowHead(pts, style);
    if (h) out += `<path d="M${f2(h[0].x)} ${f2(h[0].y)} L${f2(h[1].x)} ${f2(h[1].y)} L${f2(h[2].x)} ${f2(h[2].y)} Z" fill="${s.color}"/>`;
  }
  return { fill, ink: out };
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
  // The fill left of a shape whose outline was erased: touched anywhere on it.
  if (s.fillOnly && pts.length > 2 && insidePolygon(x, y, pts)) return true;
  if (pts.length === 1) return Math.hypot(pts[0].x - x, pts[0].y - y) <= r + (s.shapeKind === 'point' ? s.width : 0);
  for (let i = 1; i < pts.length; i++) if (distToSegment(x, y, pts[i - 1], pts[i]) <= r) return true;
  if (s.closed && pts.length > 2) {
    if (distToSegment(x, y, pts[pts.length - 1], pts[0]) <= r) return true;
    // Filled regions can be erased/picked by touching their inside.
    if (s.fill && s.fill !== 'none' && s.fill !== 'hole' && insidePolygon(x, y, pts)) return true;
  }
  return false;
}

function lerpPoint(a: Point, b: Point, t: number): Point {
  const q: Point = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, pressure: a.pressure + (b.pressure - a.pressure) * t };
  if (typeof a.t === 'number' && typeof b.t === 'number') q.t = a.t + (b.t - a.t) * t;
  return q;
}

/** Where the segment from `a` (outside) to `b` crosses the circle (c, r): the point at the boundary. */
function circleCrossing(a: Point, b: Point, cx: number, cy: number, r: number): Point {
  const dx = b.x - a.x, dy = b.y - a.y;
  const fx = a.x - cx, fy = a.y - cy;
  const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - r * r;
  if (A < 1e-12) return a;
  const disc = Math.max(0, B * B - 4 * A * C);
  const t = (-B - Math.sqrt(disc)) / (2 * A);
  return lerpPoint(a, b, Math.max(0, Math.min(1, t)));
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
        out.push(lerpPoint(a, b, t));
      }
    }
    out.push(src[i]);
  }
  return out;
}

/** Where the segment a→b enters / leaves the circle (c, r): parameters strictly inside (0, 1). */
function circleCuts(a: XY, b: XY, cx: number, cy: number, r: number): number[] {
  const dx = b.x - a.x, dy = b.y - a.y;
  const fx = a.x - cx, fy = a.y - cy;
  const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - r * r;
  if (A < 1e-12) return [];
  const disc = B * B - 4 * A * C;
  if (disc <= 0) return [];
  const q = Math.sqrt(disc);
  return [(-B - q) / (2 * A), (-B + q) / (2 * A)].filter((t) => t > 1e-9 && t < 1 - 1e-9);
}

/**
 * Precision eraser on a shape (Draw tool, snapped shapes): the outline is cut exactly where it
 * crosses the eraser circle, and every piece keeps the outline's exact geometry (straight edges
 * stay the same segments; a smart curve is its own spline, flattened finely), its width, colour,
 * line style (dashes continue where they were, Stroke.dashOffset), opacity and rotation, and its
 * place in the stacking order. A piece that keeps the end of an open shape keeps its arrowhead.
 * The pieces of a closed shape join across its starting point. A filled shape keeps its fill as a
 * separate fill-only stroke. Returns null when nothing of the outline is under the eraser.
 */
function eraseShape(s: Stroke, x: number, y: number, r: number, makeId: () => string): Stroke[] | null {
  const closed = !!s.closed && s.points.length > 2;
  const src: Point[] =
    s.shapeKind === 'curve'
      ? flattenBeziers(curveSegments(s.points, closed), 0.2).map((p) => ({ x: p.x, y: p.y, pressure: 0.5 }))
      : closed
        ? [...s.points, s.points[0]]
        : s.points;
  if (src.length < 2) return null;
  const inside = (p: XY) => Math.hypot(p.x - x, p.y - y) <= r;
  type Run = { points: Point[]; offset: number; first: boolean; last: boolean };
  const runs: Run[] = [];
  let cur: Run | null = inside(src[0]) ? null : { points: [src[0]], offset: 0, first: true, last: false };
  let cut = false;
  let at = 0;
  for (let i = 1; i < src.length; i++) {
    const a = src[i - 1], b = src[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    for (const t of circleCuts(a, b, x, y, r)) {
      const p = lerpPoint(a, b, t);
      cut = true;
      if (cur) {
        // Going under the eraser: the piece ends on its edge.
        cur.points.push(p);
        runs.push(cur);
        cur = null;
      } else cur = { points: [p], offset: at + len * t, first: false, last: false };
    }
    if (cur && !inside(b)) cur.points.push(b);
    else if (cur) {
      // Ends inside without a crossing (rounding): close the piece here.
      runs.push(cur);
      cur = null;
      cut = true;
    } else if (!inside(b) && !cur) {
      cur = { points: [b], offset: at + len, first: false, last: false };
    }
    at += len;
  }
  if (cur) {
    cur.last = true;
    runs.push(cur);
  }
  if (!cut && runs.length === 1 && runs[0].first && runs[0].last) return null;
  // A closed outline: the piece through its starting point is one piece.
  if (closed && runs.length > 1 && runs[0].first && runs[runs.length - 1].last) {
    const tail = runs.pop()!, head = runs.shift()!;
    runs.unshift({ points: [...tail.points, ...head.points.slice(1)], offset: tail.offset, first: false, last: false });
  }
  const created = itemTime(s);
  const dashed = (s.lineStyle ?? 'solid') !== 'solid';
  const out: Stroke[] = [];
  if (closed && s.fill && s.fill !== 'none') out.push({ ...s, id: makeId(), createdAt: created, fillOnly: true, arrow: undefined });
  for (const run of runs) {
    let length = 0;
    for (let i = 1; i < run.points.length; i++) length += Math.hypot(run.points[i].x - run.points[i - 1].x, run.points[i].y - run.points[i - 1].y);
    if (run.points.length < 2 || length < 0.5) continue;
    const piece: Stroke = {
      ...s,
      id: makeId(),
      createdAt: created,
      points: run.points,
      isShape: true,
      shapeKind: 'polyline',
      closed: false,
      fill: undefined,
      fillOnly: undefined,
      arrow: run.last && !closed ? s.arrow : undefined,
    };
    if (dashed) piece.dashOffset = (s.dashOffset ?? 0) + run.offset;
    else delete piece.dashOffset;
    out.push(piece);
  }
  return out;
}

/**
 * Precision eraser (Notability's partial eraser): removes only the part of each stroke under the
 * eraser and splits the remainder into separate strokes. Smart-pen curves are cut along the
 * drawn spline and stay curves; other shapes become open polylines.
 *
 * Handwriting is cut along the line the ink engine drew, not its raw samples: the pieces keep
 * that modelled line and its pressure (Stroke.modeled) and are drawn as they are. Running the
 * engine again on a piece of the raw samples changed the ink: every cut end got the engine's
 * pen-down and lift-off treatment (a tapered or swollen end), a piece without real pressure
 * switched to the uniform width, and the fitted line moved near the cut. The cut is placed exactly
 * where the line crosses the eraser circle.
 */
export function eraseStrokesPartial(
  strokes: Stroke[],
  x: number,
  y: number,
  radius: number,
  makeId: () => string,
  /** Fill-only strokes left by this same eraser gesture: kept (the eraser was cutting their outline). */
  keep?: ReadonlySet<string>
): { strokes: Stroke[]; changed: boolean } {
  let changed = false;
  const out: Stroke[] = [];
  for (const s of strokes) {
    if (!strokeHitTest(s, x, y, radius) || (s.fillOnly && keep?.has(s.id))) {
      out.push(s);
      continue;
    }
    if (s.shapeKind === 'point' || s.fillOnly) {
      changed = true;
      continue;
    }
    const r = radius + s.width * 0.6;
    if (s.isShape) {
      const pieces = eraseShape(s, x, y, r, makeId);
      if (!pieces) out.push(s);
      else {
        changed = true;
        out.push(...pieces);
      }
      continue;
    }
    // Handwriting.
    const closed = !!s.closed && s.points.length > 2;
    const g = strokeGeometry(s);
    const modeled: Stroke['modeled'] = s.modeled === 'proportional' && g.widths ? 'proportional' : g.widths ? 'variable' : 'uniform';
    const pts = densify(g.pts.map((q) => ({ x: q.x, y: q.y, pressure: q.p, t: q.t })), false, 1);
    const inside = (p: Point) => Math.hypot(p.x - x, p.y - y) <= r;
    if (!pts.some(inside)) {
      // Touched the outline's padding only: nothing of the line is under the eraser.
      out.push(s);
      continue;
    }
    changed = true;
    const lastIndex = pts.length - 1;
    let run: Point[] = [];
    let runEnd = -1;
    const flush = () => {
      if (run.length >= 2) {
        const keepsEnd = runEnd === lastIndex && !closed;
        out.push({
          ...s,
          id: makeId(),
          createdAt: itemTime(s),
          points: run,
          closed: false,
          fill: undefined,
          arrow: keepsEnd ? s.arrow : undefined,
          modeled,
          penEnd: undefined,
        });
      }
      run = [];
    };
    pts.forEach((p, i) => {
      const prev = i > 0 ? pts[i - 1] : null;
      if (inside(p)) {
        // Leaving the kept line: end it exactly on the eraser's edge.
        if (prev && !inside(prev) && run.length) run.push(circleCrossing(prev, p, x, y, r));
        flush();
      } else {
        // Coming out from under the eraser: start exactly on its edge.
        if (prev && inside(prev)) run.push(circleCrossing(p, prev, x, y, r));
        run.push(p);
        runEnd = i;
      }
    });
    flush();
  }
  return { strokes: changed ? out : strokes, changed };
}
