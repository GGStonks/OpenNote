import { NotePage, PAGE_HEIGHT, Stroke } from '../types';

/**
 * Notes saved by v1.6-v1.11 (schema 3) are one continuous vertical surface: a single NotePage
 * whose content may extend over any height, shown with page lines every PAGE_HEIGHT. Since v1.12
 * a note is a list of real pages; these helpers cut an old surface into them when it is loaded.
 */

const bottoms = new WeakMap<Stroke, number>();

function strokeBottom(s: Stroke): number {
  let b = bottoms.get(s);
  if (b === undefined) {
    b = -Infinity;
    for (const p of s.points) if (p.y > b) b = p.y;
    bottoms.set(s, b);
  }
  return b;
}

/** Lowest point of the content, or -Infinity on an empty surface. */
function contentBottom(p: NotePage): number {
  let b = -Infinity;
  for (const s of p.strokes) b = Math.max(b, strokeBottom(s));
  for (const x of p.latexBlocks) b = Math.max(b, x.y + x.height);
  for (const x of p.textBlocks ?? []) b = Math.max(b, x.y + x.fontSize * 1.4 * Math.max(1, x.text.split('\n').length));
  for (const x of p.imageBlocks ?? []) b = Math.max(b, x.y + x.height);
  return b;
}

/** Pages of the surface that hold content (at least one). */
function usedPages(p: NotePage): number {
  const b = contentBottom(p);
  return Number.isFinite(b) ? Math.floor(Math.max(0, b) / PAGE_HEIGHT) + 1 : 1;
}

const shiftStroke = (s: Stroke, dy: number): Stroke => ({ ...s, points: s.points.map((q) => ({ ...q, y: q.y + dy })) });

function strokeMidY(s: Stroke): number {
  let a = Infinity, b = -Infinity;
  for (const p of s.points) {
    a = Math.min(a, p.y);
    b = Math.max(b, p.y);
  }
  return (a + b) / 2;
}

const bandOf = (y: number) => Math.max(0, Math.floor(y / PAGE_HEIGHT));

/**
 * Cuts a surface into pages at the page lines: each item goes to the page that holds its middle
 * (or its top, for text), in that page's coordinates. Ink that crossed a page line stays whole on
 * one page and may reach past its edge.
 */
export function splitSurface(p: NotePage): NotePage[] {
  const n = usedPages(p);
  const pages: NotePage[] = Array.from({ length: n }, (_, i) => ({
    id: i === 0 ? p.id : `${p.id}_p${i}`, pageNumber: i + 1, strokes: [], latexBlocks: [], textBlocks: [], imageBlocks: [],
  }));
  const at = (y: number) => Math.min(n - 1, bandOf(y));
  for (const s of p.strokes) {
    const k = at(strokeMidY(s));
    pages[k].strokes.push(shiftStroke(s, -k * PAGE_HEIGHT));
  }
  for (const b of p.latexBlocks) {
    const k = at(b.y + b.height / 2);
    pages[k].latexBlocks.push({ ...b, y: b.y - k * PAGE_HEIGHT });
  }
  for (const b of p.textBlocks ?? []) {
    const k = at(b.y);
    pages[k].textBlocks!.push({ ...b, y: b.y - k * PAGE_HEIGHT });
  }
  for (const b of p.imageBlocks ?? []) {
    const k = at(b.y + b.height / 2);
    pages[k].imageBlocks!.push({ ...b, y: b.y - k * PAGE_HEIGHT });
  }
  return pages;
}
