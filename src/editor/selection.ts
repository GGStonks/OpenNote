import { NotePage, Rect, Stroke } from '../types';
import { isPointInPolygon } from '../services/shapeRecognition';
import { strokeBounds } from '../ink/strokeRenderer';

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

function textHeight(t: { text: string; fontSize: number; width: number }): number {
  // Approximation used for hit-testing (rendered height is not stored).
  const charsPerLine = Math.max(8, t.width / (t.fontSize * 0.5));
  const lines = t.text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / charsPerLine)), 0);
  return lines * t.fontSize * 1.35;
}

export function computeBounds(page: NotePage, sel: Omit<Selection, 'bounds'>, pad = 10): Rect | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x0: number, y0: number, x1: number, y1: number) => {
    minX = Math.min(minX, x0); minY = Math.min(minY, y0);
    maxX = Math.max(maxX, x1); maxY = Math.max(maxY, y1);
  };
  for (const s of page.strokes) if (sel.strokeIds.includes(s.id)) { const b = strokeBounds(s); add(b.minX, b.minY, b.maxX, b.maxY); }
  for (const b of page.latexBlocks) if (sel.latexIds.includes(b.id)) add(b.x, b.y, b.x + b.width, b.y + b.height);
  for (const t of page.textBlocks ?? []) if (sel.textIds.includes(t.id)) add(t.x, t.y, t.x + t.width, t.y + textHeight(t));
  for (const im of page.imageBlocks ?? []) if (sel.imageIds.includes(im.id)) add(im.x, im.y, im.x + im.width, im.y + im.height);
  if (!Number.isFinite(minX)) return null;
  return { x: minX - pad, y: minY - pad, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 };
}

function strokeInside(s: Stroke, poly: { x: number; y: number }[]): boolean {
  if (s.points.length <= 2) return s.points.some((p) => isPointInPolygon(p, poly));
  let inside = 0;
  for (const p of s.points) if (isPointInPolygon(p, poly)) inside++;
  return inside / s.points.length >= 0.5;
}

export function selectInLasso(page: NotePage, poly: { x: number; y: number }[]): Selection | null {
  const rectIn = (x: number, y: number, w: number, h: number) =>
    isPointInPolygon({ x: x + w / 2, y: y + h / 2 }, poly);
  const sel = {
    pageId: page.id,
    strokeIds: page.strokes.filter((s) => strokeInside(s, poly)).map((s) => s.id),
    latexIds: page.latexBlocks.filter((b) => rectIn(b.x, b.y, b.width, b.height)).map((b) => b.id),
    textIds: (page.textBlocks ?? []).filter((t) => rectIn(t.x, t.y, t.width, textHeight(t))).map((t) => t.id),
    imageIds: (page.imageBlocks ?? []).filter((im) => rectIn(im.x, im.y, im.width, im.height)).map((im) => im.id),
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

/** Applies translate + uniform scale (about the selection's top-left corner) to the selected items. */
export function transformSelection(page: NotePage, sel: Selection, dx: number, dy: number, factor: number): NotePage {
  const ox = sel.bounds.x, oy = sel.bounds.y;
  const tx = (x: number) => ox + (x - ox) * factor + dx;
  const ty = (y: number) => oy + (y - oy) * factor + dy;
  return {
    ...page,
    strokes: page.strokes.map((s) =>
      sel.strokeIds.includes(s.id)
        ? { ...s, width: s.width * (factor === 1 ? 1 : Math.sqrt(factor)), points: s.points.map((p) => ({ ...p, x: tx(p.x), y: ty(p.y) })) }
        : s
    ),
    latexBlocks: page.latexBlocks.map((b) =>
      sel.latexIds.includes(b.id)
        ? { ...b, x: tx(b.x), y: ty(b.y), width: b.width * factor, height: b.height * factor, scale: (b.scale ?? 1) * factor }
        : b
    ),
    textBlocks: (page.textBlocks ?? []).map((t) =>
      sel.textIds.includes(t.id) ? { ...t, x: tx(t.x), y: ty(t.y), width: t.width * factor, fontSize: t.fontSize * factor } : t
    ),
    imageBlocks: (page.imageBlocks ?? []).map((im) =>
      sel.imageIds.includes(im.id) ? { ...im, x: tx(im.x), y: ty(im.y), width: im.width * factor, height: im.height * factor } : im
    ),
  };
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
