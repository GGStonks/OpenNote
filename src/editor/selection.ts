import { NotePage, Rect, Stroke } from '../types';
import { curveSegments, markMoved, strokeBounds } from '../ink/strokeRenderer';
import { flattenBeziers, XY } from '../ink/spline';

export interface Selection {
  pageId: string;
  strokeIds: string[];
  latexIds: string[];
  textIds: string[];
  imageIds: string[];
  bounds: Rect;
}

export function isEmptySelection(s: Selection | null): boolean {
  return !s || s.strokeIds.length + s.latexIds.length + s.textIds.length + s.imageIds.length === 0;
}

export function textHeight(t: { text: string; fontSize: number; width: number }): number {
  // Approximation used for hit-testing (rendered height is not stored).
  const charsPerLine = Math.max(8, t.width / (t.fontSize * 0.5));
  const lines = t.text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / charsPerLine)), 0);
  return lines * t.fontSize * 1.35;
}

/** Normalises an angle in degrees to (-180, 180], rounded to 0.01°. */
export function normDeg(a: number): number {
  let d = ((((a + 180) % 360) + 360) % 360) - 180;
  if (d === -180) d = 180;
  return Math.round(d * 100) / 100;
}

/** Corners of a box of size w x h at (x, y), rotated by `deg` (clockwise) about its centre. */
export function boxCorners(x: number, y: number, w: number, h: number, deg = 0): XY[] {
  const cx = x + w / 2, cy = y + h / 2;
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ].map(([u, v]) => ({ x: cx + u * c - v * s, y: cy + u * s + v * c }));
}

/** The four corners of every kind of block (rotation included). */
function blockCorners(page: NotePage, kind: 'latex' | 'text' | 'image', id: string): XY[] | null {
  if (kind === 'latex') {
    const b = page.latexBlocks.find((x) => x.id === id);
    return b ? boxCorners(b.x, b.y, b.width, b.height, b.rotation) : null;
  }
  if (kind === 'text') {
    const t = (page.textBlocks ?? []).find((x) => x.id === id);
    return t ? boxCorners(t.x, t.y, t.width, textHeight(t), t.rotation) : null;
  }
  const im = (page.imageBlocks ?? []).find((x) => x.id === id);
  return im ? boxCorners(im.x, im.y, im.width, im.height, im.rotation) : null;
}

export function computeBounds(page: NotePage, sel: Omit<Selection, 'bounds'>, pad = 10): Rect | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x0: number, y0: number, x1: number, y1: number) => {
    minX = Math.min(minX, x0); minY = Math.min(minY, y0);
    maxX = Math.max(maxX, x1); maxY = Math.max(maxY, y1);
  };
  const addCorners = (cs: XY[] | null) => cs?.forEach((c) => add(c.x, c.y, c.x, c.y));
  for (const s of page.strokes) if (sel.strokeIds.includes(s.id)) { const b = strokeBounds(s); add(b.minX, b.minY, b.maxX, b.maxY); }
  for (const id of sel.latexIds) addCorners(blockCorners(page, 'latex', id));
  for (const id of sel.textIds) addCorners(blockCorners(page, 'text', id));
  for (const id of sel.imageIds) addCorners(blockCorners(page, 'image', id));
  if (!Number.isFinite(minX)) return null;
  return { x: minX - pad, y: minY - pad, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 };
}

// --------------------------------------------------------------------------------------------
// Lasso: an item is selected as soon as the lasso touches it.

function insidePoly(p: XY, poly: XY[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

const cross = (o: XY, a: XY, b: XY) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/** Do segments ab and cd intersect (touching counts)? */
function segmentsMeet(a: XY, b: XY, c: XY, d: XY): boolean {
  if (Math.max(a.x, b.x) < Math.min(c.x, d.x) || Math.max(c.x, d.x) < Math.min(a.x, b.x)) return false;
  if (Math.max(a.y, b.y) < Math.min(c.y, d.y) || Math.max(c.y, d.y) < Math.min(a.y, b.y)) return false;
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const on = (p: XY, q: XY, r: XY) => Math.abs(cross(p, q, r)) < 1e-9 && Math.min(p.x, q.x) <= r.x && r.x <= Math.max(p.x, q.x) && Math.min(p.y, q.y) <= r.y && r.y <= Math.max(p.y, q.y);
  return on(c, d, a) || on(c, d, b) || on(a, b, c) || on(a, b, d);
}

interface Lasso {
  poly: XY[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function makeLasso(points: XY[]): Lasso {
  // Thin the lasso to ~2 px steps: it is tested against every candidate segment.
  const poly: XY[] = [];
  for (const p of points) {
    const l = poly[poly.length - 1];
    if (!l || Math.hypot(p.x - l.x, p.y - l.y) >= 2) poly.push({ x: p.x, y: p.y });
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of poly) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  return { poly, minX, minY, maxX, maxY };
}

/** Does the polyline (or polygon, `closed`) touch the lasso: a point inside it, or a crossing of its outline? */
function lineTouchesLasso(pts: XY[], closed: boolean, L: Lasso): boolean {
  const { poly } = L;
  if (poly.length < 2) return false;
  for (const p of pts) {
    if (p.x >= L.minX && p.x <= L.maxX && p.y >= L.minY && p.y <= L.maxY && insidePoly(p, poly)) return true;
  }
  const n = pts.length;
  const segs = closed && n > 2 ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    if (Math.max(a.x, b.x) < L.minX || Math.min(a.x, b.x) > L.maxX || Math.max(a.y, b.y) < L.minY || Math.min(a.y, b.y) > L.maxY) continue;
    for (let j = 0; j < poly.length; j++) if (segmentsMeet(a, b, poly[j], poly[(j + 1) % poly.length])) return true;
  }
  return false;
}

/** The drawn line of a stroke (curves as their spline). */
function strokeLine(s: Stroke): XY[] {
  if (s.shapeKind === 'curve') return flattenBeziers(curveSegments(s.points, !!s.closed && s.points.length > 2), 2);
  return s.points;
}

function strokeTouches(s: Stroke, L: Lasso): boolean {
  const b = strokeBounds(s);
  if (b.maxX < L.minX || b.minX > L.maxX || b.maxY < L.minY || b.minY > L.maxY) return false;
  const closed = !!s.closed && s.points.length > 2;
  const line = strokeLine(s);
  if (lineTouchesLasso(line, closed, L)) return true;
  // A filled shape is touched anywhere inside it: also by a lasso drawn entirely within it.
  return closed && !!s.fill && s.fill !== 'none' && s.fill !== 'hole' && insidePoly(L.poly[0], line);
}

function boxTouches(corners: XY[] | null, L: Lasso): boolean {
  if (!corners) return false;
  if (lineTouchesLasso(corners, true, L)) return true;
  // The lasso drawn entirely inside the box.
  return L.poly.length > 0 && insidePoly(L.poly[0], corners);
}

export function selectInLasso(page: NotePage, lasso: XY[]): Selection | null {
  const L = makeLasso(lasso);
  if (L.poly.length < 2) return null;
  const sel = {
    pageId: page.id,
    strokeIds: page.strokes.filter((s) => strokeTouches(s, L)).map((s) => s.id),
    latexIds: page.latexBlocks.filter((b) => boxTouches(blockCorners(page, 'latex', b.id), L)).map((b) => b.id),
    textIds: (page.textBlocks ?? []).filter((t) => boxTouches(blockCorners(page, 'text', t.id), L)).map((t) => t.id),
    imageIds: (page.imageBlocks ?? []).filter((im) => boxTouches(blockCorners(page, 'image', im.id), L)).map((im) => im.id),
  };
  const bounds = computeBounds(page, sel);
  return bounds ? { ...sel, bounds } : null;
}

export function singleBlockSelection(page: NotePage, kind: 'latex' | 'text' | 'image', id: string): Selection | null {
  const sel = {
    pageId: page.id,
    strokeIds: [],
    latexIds: kind === 'latex' ? [id] : [],
    textIds: kind === 'text' ? [id] : [],
    imageIds: kind === 'image' ? [id] : [],
  };
  const bounds = computeBounds(page, sel);
  return bounds ? { ...sel, bounds } : null;
}

// --------------------------------------------------------------------------------------------
// Moving, scaling, rotating

/**
 * Applies translate + uniform scale (about the selection's top-left corner), then a rotation of
 * `rot` degrees (clockwise) about the centre of the result, to the selected items. Every item
 * keeps the total of its rotations in `rotation` (0 = as it was made).
 */
export function transformSelection(page: NotePage, sel: Selection, dx: number, dy: number, factor: number, rot = 0): NotePage {
  const ox = sel.bounds.x, oy = sel.bounds.y;
  const cx = ox + (sel.bounds.width * factor) / 2 + dx, cy = oy + (sel.bounds.height * factor) / 2 + dy;
  const r = (rot * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  const T = (x: number, y: number): XY => {
    const X = ox + (x - ox) * factor + dx, Y = oy + (y - oy) * factor + dy;
    if (!rot) return { x: X, y: Y };
    const u = X - cx, v = Y - cy;
    return { x: cx + u * c - v * s, y: cy + u * s + v * c };
  };
  const turned = (deg?: number) => (rot ? { rotation: normDeg((deg ?? 0) + rot) } : {});
  /** A box keeps its size (scaled) and turns about its own centre, which moves with the selection. */
  const box = <B extends { x: number; y: number; rotation?: number }>(b: B, w: number, h: number) => {
    const C = T(b.x + w / 2, b.y + h / 2);
    return { x: C.x - (w * factor) / 2, y: C.y - (h * factor) / 2, ...turned(b.rotation) };
  };
  const ids = new Set(sel.strokeIds);
  const moveOnly = factor === 1 && !rot;
  return {
    ...page,
    strokes: page.strokes.map((st) => {
      if (!ids.has(st.id)) return st;
      const out: Stroke = {
        ...st,
        width: st.width * (factor === 1 ? 1 : Math.sqrt(factor)),
        points: st.points.map((p) => ({ ...p, ...T(p.x, p.y) })),
        ...turned(st.rotation),
      };
      // Only moved: the ink keeps its geometry, moved (no re-modelling when a selection is dropped).
      return moveOnly ? markMoved(out, st, dx, dy) : out;
    }),
    latexBlocks: page.latexBlocks.map((b) =>
      sel.latexIds.includes(b.id)
        ? { ...b, ...box(b, b.width, b.height), width: b.width * factor, height: b.height * factor, scale: (b.scale ?? 1) * factor }
        : b
    ),
    textBlocks: (page.textBlocks ?? []).map((t) =>
      sel.textIds.includes(t.id) ? { ...t, ...box(t, t.width, textHeight(t)), width: t.width * factor, fontSize: t.fontSize * factor } : t
    ),
    imageBlocks: (page.imageBlocks ?? []).map((im) =>
      sel.imageIds.includes(im.id) ? { ...im, ...box(im, im.width, im.height), width: im.width * factor, height: im.height * factor } : im
    ),
  };
}

/** The rotation all selected items share (degrees from their original orientation), or null when they differ. */
export function selectionRotation(page: NotePage, sel: Omit<Selection, 'bounds'>): number | null {
  const all: number[] = [
    ...page.strokes.filter((s) => sel.strokeIds.includes(s.id)).map((s) => s.rotation ?? 0),
    ...page.latexBlocks.filter((b) => sel.latexIds.includes(b.id)).map((b) => b.rotation ?? 0),
    ...(page.textBlocks ?? []).filter((b) => sel.textIds.includes(b.id)).map((b) => b.rotation ?? 0),
    ...(page.imageBlocks ?? []).filter((b) => sel.imageIds.includes(b.id)).map((b) => b.rotation ?? 0),
  ];
  if (!all.length) return null;
  return all.every((r) => Math.abs(normDeg(r - all[0])) < 0.05) ? normDeg(all[0]) : null;
}

/**
 * Turns the selection back to 0°. Items that were turned together turn back together, about the
 * selection's centre; items with different rotations each turn back about their own centre.
 */
export function resetRotation(page: NotePage, sel: Selection): NotePage {
  const common = selectionRotation(page, sel);
  if (common !== null) return common ? transformSelection(page, sel, 0, 0, 1, -common) : page;
  let out = page;
  const one = (ids: Partial<Omit<Selection, 'bounds' | 'pageId'>>) => {
    const s1 = { pageId: sel.pageId, strokeIds: [], latexIds: [], textIds: [], imageIds: [], ...ids };
    const r = selectionRotation(out, s1);
    const b = computeBounds(out, s1, 0);
    if (r && b) out = transformSelection(out, { ...s1, bounds: b }, 0, 0, 1, -r);
  };
  sel.strokeIds.forEach((id) => one({ strokeIds: [id] }));
  sel.latexIds.forEach((id) => one({ latexIds: [id] }));
  sel.textIds.forEach((id) => one({ textIds: [id] }));
  sel.imageIds.forEach((id) => one({ imageIds: [id] }));
  return out;
}

export function removeSelection(page: NotePage, sel: Selection): NotePage {
  return {
    ...page,
    strokes: page.strokes.filter((s) => !sel.strokeIds.includes(s.id)),
    latexBlocks: page.latexBlocks.filter((b) => !sel.latexIds.includes(b.id)),
    textBlocks: (page.textBlocks ?? []).filter((t) => !sel.textIds.includes(t.id)),
    imageBlocks: (page.imageBlocks ?? []).filter((im) => !sel.imageIds.includes(im.id)),
  };
}
