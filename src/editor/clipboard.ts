import { useSyncExternalStore } from 'react';
import { ImageBlock, LatexBlock, NotePage, Rect, Stroke, TextBlock, newId } from '../types';
import { Selection } from './selection';

/**
 * OpenNote's clipboard for selections: Copy keeps the selected items (nothing appears on the
 * page), Cut keeps them and removes them, Paste puts a copy of them on any page of any note, as
 * many times as wanted, until something else is copied. It lives as long as the app is open.
 */

export interface ClipContent {
  strokes: Stroke[];
  latexBlocks: LatexBlock[];
  textBlocks: TextBlock[];
  imageBlocks: ImageBlock[];
  /** Bounds of the copied items (surface px), to place a paste. */
  bounds: Rect;
}

let clip: ClipContent | null = null;
const listeners = new Set<() => void>();

export function getClipboard(): ClipContent | null {
  return clip;
}

function setClipboard(c: ClipContent | null) {
  clip = c;
  listeners.forEach((fn) => fn());
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export function useClipboard(): ClipContent | null {
  return useSyncExternalStore(subscribe, getClipboard, getClipboard);
}

/** Copies the selected items of `page` to the clipboard; returns how many items were copied. */
export function copySelection(page: NotePage, sel: Selection): number {
  const c: ClipContent = {
    strokes: page.strokes.filter((s) => sel.strokeIds.includes(s.id)),
    latexBlocks: page.latexBlocks.filter((b) => sel.latexIds.includes(b.id)),
    textBlocks: (page.textBlocks ?? []).filter((b) => sel.textIds.includes(b.id)),
    imageBlocks: (page.imageBlocks ?? []).filter((b) => sel.imageIds.includes(b.id)),
    bounds: { ...sel.bounds },
  };
  const n = c.strokes.length + c.latexBlocks.length + c.textBlocks.length + c.imageBlocks.length;
  if (n) setClipboard(structuredClone(c));
  return n;
}

/**
 * A copy of the clipboard placed with its centre at `at` (surface px), kept on the sheet, with new
 * ids. Returns the page with the pasted items and the selection of them.
 */
export function pasteClipboard(page: NotePage, at: { x: number; y: number }, sheetWidth: number): { page: NotePage; sel: Omit<Selection, 'bounds'>; dx: number; dy: number } | null {
  const c = clip;
  if (!c) return null;
  const b = c.bounds;
  let dx = at.x - (b.x + b.width / 2), dy = at.y - (b.y + b.height / 2);
  dx = Math.max(-b.x, Math.min(sheetWidth - b.x - b.width, dx));
  if (b.width > sheetWidth) dx = -b.x;
  dy = Math.max(-b.y, dy);
  const strokes = c.strokes.map((s) => ({ ...structuredClone(s), id: newId('stroke'), points: s.points.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })) }));
  const latex = c.latexBlocks.map((x) => ({ ...structuredClone(x), id: newId(x.isTikz ? 'tikz' : 'latex'), x: x.x + dx, y: x.y + dy, createdAt: Date.now() }));
  const texts = c.textBlocks.map((x) => ({ ...structuredClone(x), id: newId('text'), x: x.x + dx, y: x.y + dy, createdAt: Date.now() }));
  const images = c.imageBlocks.map((x) => ({ ...x, id: newId('image'), x: x.x + dx, y: x.y + dy, createdAt: Date.now() }));
  return {
    page: {
      ...page,
      strokes: [...page.strokes, ...strokes],
      latexBlocks: [...page.latexBlocks, ...latex],
      textBlocks: [...(page.textBlocks ?? []), ...texts],
      imageBlocks: [...(page.imageBlocks ?? []), ...images],
    },
    sel: {
      pageId: page.id,
      strokeIds: strokes.map((s) => s.id),
      latexIds: latex.map((x) => x.id),
      textIds: texts.map((x) => x.id),
      imageIds: images.map((x) => x.id),
    },
    dx,
    dy,
  };
}
