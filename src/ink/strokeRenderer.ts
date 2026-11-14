import { FillType, Point, Stroke, PenStyle, LineStyle, ShapeKind } from '../types';
import { itemTime } from '../editor/zorder';
import { Bezier, catmullRomBeziers, endTangent, flattenBeziers, XY } from './spline';
import { ModeledPoint, addCapsule, capsuleSvg, hasRealPressure, nibStroke, thinModeled } from './engine';
import { WIDTH_AHEAD, inkWidths } from './inkWidth';

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
  const line = modeledLine(points, style.modeled);
  const pts = thinModeled(line);
  const width = style.tool === 'highlighter' ? style.width * 5.5 : strokeWidth(style);
  const pressured = style.modeled ? style.modeled !== 'uniform' : hasRealPressure(points);
  const share = style.modeled === 'proportional';
  let widths: number[] | null = null;
  if (isVariableWidth(style) && pressured) {
    if (share) widths = pts.map((p) => width * Math.max(0.02, p.p)); // imported widths, kept exactly
    else {
      // The fountain pen's follow its pressure and speed (inkWidth.ts), measured on the whole
      // modelled line, as the live stroke does (smoothLiveStroke), then thinned with it: the
      // speed of a thinned line differs, and the ink changed width when the pen lifted.
      const all = inkWidths(line, width);
      widths = pts === line ? all : thinnedWidths(line, pts, all);
    }
  }
  return { pts, widths, width };
}

/** The widths of the points thinModeled kept (`kept` is in `line`'s order, a subsequence of it). */
function thinnedWidths(line: readonly ModeledPoint[], kept: readonly ModeledPoint[], widths: readonly number[]): number[] {
  const out: number[] = [];
  let j = 0;
  for (const q of kept) {
    while (j < line.length && line[j] !== q) j++;
    out.push(widths[Math.min(j, widths.length - 1)]);
  }
  return out;
}

export type InkGeometry = ReturnType<typeof inkGeometry>;
const geometryCache = new WeakMap<Stroke, InkGeometry>();

/** Whether strokeGeometry has the stroke's drawn line already. */
export function hasStrokeGeometry(s: Stroke): boolean {
  return geometryCache.has(s);
}

/**
 * Gives strokeGeometry a stroke's drawn line computed elsewhere: by the app's Rust library
 * (services/rustCore.ts), which computes this very line point for point (crates/ink/tests/reference.rs).
 */
export function setStrokeGeometry(s: Stroke, g: InkGeometry): void {
  geometryCache.set(s, g);
}

/** The point a stroke's line continues to after the ink engine's end (Stroke.penEnd), or null. */
export function penEnd(s: Stroke): Point | null {
  return s.penEnd && !s.modeled && !s.isShape && s.points.length > 1 ? s.points[s.points.length - 1] : null;
}

/**
 * The points the ink engine models: all but the pen end, and without the trailing samples that
 * have no force (the Pencil in the air after it lifted; the densifier fills the gap up to its lift
 * sample with more of them). The engine never inks those, but they still took part in settling its
 * last point: a fast stroke ending at speed got a last point several px back, the line's end
 * hooking back on itself (5.8 px on a recorded flick). Strokes without real pressure (mouse,
 * finger) keep them: their zero-force last sample is ink.
 */
export function enginePoints(s: Stroke): Point[] {
  const pts = penEnd(s) ? s.points.slice(0, -1) : s.points;
  if (s.modeled || s.isShape) return pts;
  if (!hasRealPressure(pts)) return withoutBackwardLift(pts);
  let k = pts.length;
  while (k > 1 && !(pts[k - 1].pressure > 0)) k--;
  return k === pts.length ? pts : pts.slice(0, k);
}

/** A lift sample turning more than this from the line's last direction is left out (cosine). */
const LIFT_TURN_COS = 0.0;

/**
 * Strips backward lift-off hooks (turning > 90° from preceding trajectory) while preserving
 * forward-moving lift contacts.
 */
function withoutBackwardLift(pts: Point[]): Point[] {
  const n = pts.length;
  if (n < 3) return pts;
  let endIdx = n;
  while (endIdx > 1 && !(pts[endIdx - 1].pressure > 0)) endIdx--;
  const liftIdx = endIdx < n ? endIdx : n - 1;
  if (liftIdx < 2 || !(pts[liftIdx - 1].pressure > 0)) return pts;
  let j = liftIdx - 1, d = 0;
  while (j > 0 && d < 6) {
    d += Math.hypot(pts[j].x - pts[j - 1].x, pts[j].y - pts[j - 1].y);
    j--;
  }
  const bx = pts[liftIdx - 1].x - pts[j].x, by = pts[liftIdx - 1].y - pts[j].y, bl = Math.hypot(bx, by);
  const lx = pts[n - 1].x - pts[liftIdx - 1].x, ly = pts[n - 1].y - pts[liftIdx - 1].y, ll = Math.hypot(lx, ly);
  if (bl < 1 || ll < 0.05) return pts;
  return (bx * lx + by * ly) / (bl * ll) < LIFT_TURN_COS ? pts.slice(0, liftIdx) : pts;
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
    g = computeStrokeGeometry(s);
  }
  geometryCache.set(s, g);
  return g;
}

/** strokeGeometry's line computed here and now, without its cache (Diagnostics' Rust check). */
export function computeStrokeGeometry(s: Stroke): InkGeometry {
  const style = styleOf(s);
  let g = inkGeometry(enginePoints(s), style);
  if (!style.modeled && !s.isShape) g = settledSmooth(g);
  // After the smoothing, which is then the very line drawn live (the pen end is not smoothed in).
  return toPenEnd(g, penEnd(s));
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

/** Smoothing of the zoomed-in line: the widest Gaussian along the line (page px). */
const SMOOTH_SIGMA = 1.6;
/**
 * The smoothing is as wide as the pen's samples are apart there (SIGMA_PER_GAP times the gap,
 * from SMOOTH_SIGMA_MIN up to SMOOTH_SIGMA): it rounds off the corners the engine's line has at
 * the samples and leaves the hand's own line alone. At one width for all, ink written zoomed in
 * (samples 0.3 page px apart at 500%) lost real detail to a 16 device px blur, and since a point is
 * smoothed only once the line has gone SMOOTH_SETTLE past it, the line near the pen visibly jumped
 * to its smoothed place while writing (the "serpent": 5 device px over the last 1.5 cm at 500%).
 * The gap is the line's speed (over SPEED_PX either side, from the modelled points' times) times
 * the Pencil's sample interval: the same on the live line and the finished stroke, and within
 * SMOOTH_SETTLE.
 */
const SIGMA_PER_GAP = 1.25;
const SMOOTH_SIGMA_MIN = 0.25;
const SAMPLE_MS = 1000 / 240;
const SPEED_PX = 2;

/** The smoothing width at point i of P (`at`: arc length). */
function smoothSigma(P: readonly ModeledPoint[], at: Float64Array, i: number): number {
  let a = i, b = i;
  while (a > 0 && at[i] - at[a] < SPEED_PX) a--;
  while (b < P.length - 1 && at[b] - at[i] < SPEED_PX) b++;
  const dt = P[b].t - P[a].t;
  if (!(dt > 0)) return SMOOTH_SIGMA;
  const gap = ((at[b] - at[a]) / dt) * SAMPLE_MS;
  return Math.max(SMOOTH_SIGMA_MIN, Math.min(SMOOTH_SIGMA, SIGMA_PER_GAP * gap));
}
/** A turn sharper than this (degrees, over about a px either side) is a corner: the line is smoothed on either side of it. */
const CORNER_DEG = 55;
const CORNER_CHORD = 2.5;

/**
 * The modelled line made smooth for zoomed-in display. The ink engine's line is nearly straight
 * between two Pencil samples (a few page px apart) and bends where they are; at 100% that is
 * invisible, but zoomed to 300-500% the ink showed as straight pieces joined at angles. Each point
 * is replaced by a Gaussian average (SMOOTH_SIGMA) of its neighbours along the line, its pressure
 * likewise (its width stays as inkWidth.ts made it, already smooth along the line); the window narrows towards the ends so they stay where they are, and the line
 * is smoothed in pieces between sharp corners, so a cusp stays a cusp. Used for vector ink (zoomed
 * in, print, export) and the pinch overlay; the page canvases at ordinary zoom keep the engine's
 * line, as drawn live.
 */
export function smoothGeometry(g: InkGeometry): InkGeometry {
  return smoothLine(g, g.pts.length);
}

/** How far before the end of a line still being written its smooth line can change (page px). */
// A point's smoothed place depends on the line within 3 sigma of it (and the corner test a px
// beyond), its width on the line WIDTH_AHEAD after it (inkWidth.ts; until 2.9.2 the widths were
// smoothed here too, so the reach was 3 sigma + WIDTH_AHEAD: kept, the lines' shapes unchanged); at
// least 6 sigma, as before. The last SMOOTH_SETTLE of a line stays as modelled, here and live: smoothing
// it too (2.9.1 trials) turned curled stroke ends into hooks (bench:hooks) or made the end swing.
export const SMOOTH_SETTLE = Math.max(6 * SMOOTH_SIGMA, 3 * SMOOTH_SIGMA + Math.max(1, WIDTH_AHEAD) + 0.5);

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
    while (a > 0 && at[i] - at[a] < CORNER_CHORD) a--;
    while (b < n - 1 && at[b] - at[i] < CORNER_CHORD) b++;
    if (a === i || b === i) continue;
    const t1 = Math.atan2(P[i].y - P[a].y, P[i].x - P[a].x), t2 = Math.atan2(P[b].y - P[i].y, P[b].x - P[i].x);
    let turn = Math.abs(t2 - t1);
    if (turn > Math.PI) turn = 2 * Math.PI - turn;
    if ((turn * 180) / Math.PI > CORNER_DEG && at[i] - at[cuts[cuts.length - 1]] > 1) cuts.push(i);
  }
  cuts.push(n - 1);
  const pts: ModeledPoint[] = P.map((q) => ({ ...q }));
  for (let c = 0; c < cuts.length - 1; c++) {
    const lo = cuts[c], hi = cuts[c + 1];
    if (hi <= from) continue;
    for (let i = Math.max(lo + 1, from); i < hi && i < upTo; i++) {
      const sig = smoothSigma(P, at, i), inv = 1 / (2 * sig * sig);
      // Symmetric window, no wider than the distance to either end of the piece.
      const half = Math.min(3 * sig, at[i] - at[lo], at[hi] - at[i]);
      if (half <= 0) continue;
      let sx = 0, sy = 0, sp = 0, ws = 0;
      for (let j = i; j >= lo && at[i] - at[j] <= half; j--) {
        const w = Math.exp(-((at[i] - at[j]) ** 2) * inv);
        sx += P[j].x * w; sy += P[j].y * w; sp += P[j].p * w; ws += w;
      }
      for (let j = i + 1; j <= hi && at[j] - at[i] <= half; j++) {
        const w = Math.exp(-((at[j] - at[i]) ** 2) * inv);
        sx += P[j].x * w; sy += P[j].y * w; sp += P[j].p * w; ws += w;
      }
      pts[i] = { x: sx / ws, y: sy / ws, p: sp / ws, t: P[i].t };
    }
  }
  return { pts, widths: g.widths, width: g.width };
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
  // Dashed and dotted handwriting keeps the fountain pen's width in its dashes (2.9.3; before, any
  // line style made the pen's ink a uniform stroked line).
  return style.tool === 'pen' && style.penStyle === 'fountain' && !style.isShape;
}

// ---------------------------------------------------------------------------------------------
// Line styles: one pattern for the canvas, the SVG, the GPU and the live ink.

/** An "on" this short is a dot: a round end only. */
const DOT = 0.1;
/** Dots of handwriting: this many times the ink's radius there (a dot as wide as the line looked thin). */
const HAND_DOT = 1.25;

/**
 * A line style's pattern for a line of nominal width `w` (Stroke.width): lengths along the line, on,
 * off, on, off… (page px); an "on" of DOT is a dot. The dashes' round ends reach `radius` past them,
 * so the gaps look shorter than drawn here.
 */
export function dashPattern(ls: LineStyle | undefined, w: number): number[] | null {
  switch (ls) {
    case 'dashed':
      return [w * 4, w * 3];
    case 'dotted':
      return [DOT, w * 3];
    case 'dashdot':
      return [w * 4, w * 2.4, DOT, w * 2.4];
    case 'longdash':
      return [w * 9, w * 3.5];
    default:
      return null;
  }
}

/**
 * The pieces of a line drawn with `pattern` (shifted by `offset` along it: Stroke.dashOffset): each
 * dash as a run of the line's points with their radii, cut exactly at the pattern's ends; each dot as
 * a run of one point, `dotScale` x the radius there (with a dotScale of 1, a dash DOT long).
 */
export function dashRuns(pts: readonly XY[], radii: readonly number[], pattern: readonly number[], offset: number, dotScale: number): { pts: XY[]; radii: number[] }[] {
  const runs: { pts: XY[]; radii: number[] }[] = [];
  const n = pts.length, m = pattern.length;
  const period = pattern.reduce((a, b) => a + b, 0);
  if (!n || !(period > 0)) return runs;
  let phase = ((offset % period) + period) % period;
  let k = 0;
  while (phase >= pattern[k]) {
    phase -= pattern[k];
    k = (k + 1) % m;
  }
  /** What is left of pattern element k. */
  let left = pattern[k] - phase;
  const on = () => k % 2 === 0;
  // Dots grown past the line (handwriting) are a point; otherwise a dash DOT long, as the canvas's
  // round-capped dash, so stroked lines on the GPU match the canvas to the pixel.
  const dot = () => dotScale !== 1 && pattern[k] <= DOT;
  let cur: { pts: XY[]; radii: number[] } | null = null;
  if (on()) {
    if (dot()) runs.push({ pts: [pts[0]], radii: [radii[0] * dotScale] });
    else cur = { pts: [pts[0]], radii: [radii[0]] };
  }
  for (let i = 1; i < n; i++) {
    const a = pts[i - 1], b = pts[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    let d = 0;
    while (len - d > left) {
      d += left;
      const t = d / len;
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      const r = radii[i - 1] + (radii[i] - radii[i - 1]) * t;
      if (cur) {
        cur.pts.push(p);
        cur.radii.push(r);
        runs.push(cur);
        cur = null;
      }
      k = (k + 1) % m;
      left = pattern[k];
      if (on()) {
        if (dot()) runs.push({ pts: [p], radii: [r * dotScale] });
        else cur = { pts: [p], radii: [r] };
      }
    }
    left -= len - d;
    if (cur) {
      cur.pts.push(b);
      cur.radii.push(radii[i]);
    }
  }
  if (cur) runs.push(cur);
  return runs;
}

/** A pen's line style for handwriting being written (SmoothLiveStroke), or null when it is solid. */
export function handDash(ls: LineStyle | undefined, width: number): { pattern: number[]; dotScale: number } | null {
  const pattern = dashPattern(ls, width);
  return pattern ? { pattern, dotScale: HAND_DOT } : null;
}

/** Handwriting's dashes and dots (pen strokes with a line style), or null when it is solid. */
export function inkRuns(g: InkGeometry, style: InkStyle): { pts: XY[]; radii: number[] }[] | null {
  const pattern = style.tool === 'pen' && !style.isShape ? dashPattern(style.lineStyle, style.width) : null;
  if (!pattern) return null;
  const radii = g.widths ? g.widths.map((w) => w / 2) : g.pts.map(() => g.width / 2);
  return dashRuns(g.pts, radii, pattern, style.dashOffset ?? 0, HAND_DOT);
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
    const runs = inkRuns(g, style);
    if (runs) {
      path = newPath();
      for (const r of runs) mergedCapsulePath(r.pts, r.radii.map((v) => v * 2), path);
      filled = true;
    } else if (g.widths) {
      path = mergedCapsulePath(g.pts, g.widths, newPath());
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
export function highlighterDash(style: InkStyle): number[] | null {
  const ls = style.lineStyle ?? 'solid';
  if (style.tool !== 'highlighter' || ls === 'solid') return null;
  const w = style.width * 5.5;
  if (ls === 'dotted') return [DOT, w * 1.6];
  if (ls === 'dashdot') return [w, w * 1.2, DOT, w * 1.2];
  if (ls === 'longdash') return [w * 2.4, w * 1.6];
  return [w, w * 1.6];
}

/** A stroked line's dash pattern (shapes, highlighters; the canvas's and the SVG's), or null. */
function strokedDash(style: InkStyle): number[] | null {
  return style.tool === 'highlighter' ? highlighterDash(style) : dashPattern(style.lineStyle, style.width);
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
    if (dash) {
      ctx.setLineDash(dash);
      if (style.dashOffset) ctx.lineDashOffset = style.dashOffset;
    }
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
    const dash = strokedDash(style);
    if (dash) {
      ctx.setLineDash(dash);
      if (style.lineStyle === 'dotted') ctx.lineWidth = style.width * 1.8;
      if (style.dashOffset) ctx.lineDashOffset = style.dashOffset;
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
    const runs = highlighter ? null : inkRuns(g, style);
    if (runs) for (const r of runs) chainCaps(caps, r.pts, r.radii);
    else if (g.widths && !highlighter) chainCaps(caps, g.pts, g.widths.map((w) => w / 2));
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
  const keep = capKeep(pts, radii);
  let prev = 0;
  for (let k = 1; k < n; k++) {
    if (!keep[k]) continue;
    out.push(pts[prev].x, pts[prev].y, radii[prev], pts[k].x, pts[k].y, radii[k]);
    prev = k;
  }
}

/**
 * Which points of a capsule chain stay (1) once every point a straight capsule between two kept
 * neighbours passes within GL_TOLERANCE of (place and radius) is dropped: the union looks the same
 * (a sixth of a screen px at 500% and 2x pixel ratio) with a fraction of the pieces. The GPU ink
 * (chainCaps) and the SVG ink (svgParts) both draw from it: the SVG had a capsule every 0.5 px of
 * line, 114 000 on 292 strokes of handwriting (12 MB), all parsed and rasterised by WebKit.
 */
/**
 * Variable-width ink on a canvas path: the capsules between the points capKeep keeps (the same
 * union as one capsule per point, within GL_TOLERANCE), as the GPU and SVG ink draw it.
 */
export function mergedCapsulePath<P extends Path2D | CanvasRenderingContext2D>(pts: XY[], widths: number[], path: P): P {
  const n = pts.length;
  if (!n) return path;
  const r = widths.map((w) => w / 2);
  if (n === 1) {
    addCapsule(path, pts[0], r[0], pts[0], r[0]);
    return path;
  }
  const keep = capKeep(pts, r);
  let prev = 0;
  for (let k = 1; k < n; k++) {
    if (!keep[k]) continue;
    addCapsule(path, pts[prev], r[prev], pts[k], r[k]);
    prev = k;
  }
  return path;
}

function capKeep(pts: XY[], radii: number[]): Uint8Array {
  const n = pts.length;
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
  return keep;
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
  // Dashes: the canvas's pattern (shifted by dashOffset) walked along the line, round-ended pieces
  // as the canvas's round caps; dots as wide as the canvas draws them.
  const dash = strokedDash(style);
  if (!dash) {
    chainCaps(out, pts, pts.map(() => r));
    return;
  }
  if (ls === 'dotted' && style.tool !== 'highlighter') r = (style.width * 1.8) / 2;
  for (const run of dashRuns(pts, pts.map(() => r), dash, style.dashOffset ?? 0, 1)) {
    if (run.pts.length === 1) out.push(run.pts[0].x, run.pts[0].y, r, run.pts[0].x, run.pts[0].y, r);
    else chainCaps(out, run.pts, run.radii);
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

  const runs = ink && style.tool === 'pen' ? inkRuns(ink, style) : null;
  if (runs || (ink?.widths && style.tool === 'pen')) {
    // Capsules between the points capKeep keeps (the GPU ink's pieces), not one every 0.5 px; a
    // dashed line's dashes and dots each so.
    const parts: string[] = [];
    for (const run of runs ?? [{ pts: ink!.pts, radii: ink!.widths!.map((w) => w / 2) }]) {
      const P = run.pts, r = run.radii;
      if (P.length === 1) {
        parts.push(capsuleSvg(P[0], r[0], P[0], r[0], f2));
        continue;
      }
      const keep = capKeep(P, r);
      let prev = 0;
      for (let k = 1; k < P.length; k++) {
        if (!keep[k]) continue;
        parts.push(capsuleSvg(P[prev], r[prev], P[k], r[k], f2));
        prev = k;
      }
    }
    const d = parts.join('');
    out += `<path d="${d}" fill="${s.color}" fill-opacity="${opacity}" fill-rule="nonzero"/>`;
  } else {
    const dash = strokedDash(style);
    const dashAttr = dash ? ` stroke-dasharray="${dash.map(f2).join(',')}"${s.dashOffset ? ` stroke-dashoffset="${f2(s.dashOffset)}"` : ''}` : '';
    if (style.tool === 'highlighter') {
      out += `<path d="${lineD}" fill="none" stroke="${s.color}" stroke-opacity="${s.highlightAlpha ?? 0.35}" stroke-width="${s.width * 5.5}" stroke-linecap="round" stroke-linejoin="round"${dashAttr}/>`;
    } else {
      const w = style.lineStyle === 'dotted' ? s.width * 1.8 : strokeWidth(style);
      out += `<path d="${lineD}" fill="none" stroke="${s.color}" stroke-opacity="${opacity}" stroke-width="${f2(w)}" stroke-linecap="round" stroke-linejoin="round"${dashAttr}/>`;
    }
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
    const pts = densify(g.pts.map((q) => ({ x: q.x, y: q.y, pressure: q.p, t: q.t })), closed, 1);
    const inside = (p: Point) => Math.hypot(p.x - x, p.y - y) <= r;
    if (!pts.some(inside)) {
      // Touched the outline's padding only: nothing of the line is under the eraser.
      out.push(s);
      continue;
    }
    changed = true;
    const lastIndex = pts.length - 1;
    // A dashed line's pieces keep their dashes where they were: each starts the pattern at its
    // distance along the line (Stroke.dashOffset, as the shapes' pieces do).
    const dashed = (s.lineStyle ?? 'solid') !== 'solid';
    type HRun = { points: Point[]; offset: number; first: boolean; last: boolean };
    const runs: HRun[] = [];
    let run: Point[] = [];
    let runEnd = -1;
    let runFrom = 0;
    let runFirst = false;
    let along = 0;
    const flush = () => {
      if (run.length >= 2) {
        runs.push({
          points: run,
          offset: runFrom,
          first: runFirst,
          last: runEnd === lastIndex,
        });
      }
      run = [];
    };
    pts.forEach((p, i) => {
      const prev = i > 0 ? pts[i - 1] : null;
      const step = prev ? Math.hypot(p.x - prev.x, p.y - prev.y) : 0;
      if (inside(p)) {
        // Leaving the kept line: end it exactly on the eraser's edge.
        if (prev && !inside(prev) && run.length) run.push(circleCrossing(prev, p, x, y, r));
        flush();
      } else {
        // Coming out from under the eraser: start exactly on its edge.
        if (prev && inside(prev)) {
          const c = circleCrossing(p, prev, x, y, r);
          run.push(c);
          runFrom = along + step - Math.hypot(p.x - c.x, p.y - c.y);
          runFirst = false;
        } else if (!run.length) {
          runFrom = along + step;
          runFirst = i === 0;
        }
        run.push(p);
        runEnd = i;
      }
      along += step;
    });
    flush();

    if (closed && runs.length > 1 && runs[0].first && runs[runs.length - 1].last) {
      const tail = runs.pop()!, head = runs.shift()!;
      runs.unshift({ points: [...tail.points, ...head.points.slice(1)], offset: tail.offset, first: false, last: false });
    }

    if (closed && s.fill && s.fill !== 'none') out.push({ ...s, id: makeId(), createdAt: itemTime(s), fillOnly: true, arrow: undefined });

    for (const r of runs) {
      const keepsEnd = r.last && !closed;
      const piece: Stroke = {
        ...s,
        id: makeId(),
        createdAt: itemTime(s),
        points: r.points,
        closed: false,
        fill: undefined,
        arrow: keepsEnd ? s.arrow : undefined,
        modeled,
        penEnd: undefined,
      };
      if (dashed) piece.dashOffset = (s.dashOffset ?? 0) + r.offset;
      else delete piece.dashOffset;
      out.push(piece);
    }
  }
  return { strokes: changed ? out : strokes, changed };
}
