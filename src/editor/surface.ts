import { NotePage, PAGE_HEIGHT, Stroke, newId } from '../types';

/**
 * A note is one continuous vertical surface (a single NotePage whose content may extend over
 * any height), shown with thin page-break lines every PAGE_HEIGHT. Ink can cross those lines.
 * Pages only exist as bands of the surface: for the page indicator, page operations and when the
 * surface is cut into US Letter pages for PDF / SVG / LaTeX export.
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
export function contentBottom(p: NotePage): number {
  let b = -Infinity;
  for (const s of p.strokes) b = Math.max(b, strokeBottom(s));
  for (const x of p.latexBlocks) b = Math.max(b, x.y + x.height);
  for (const x of p.textBlocks ?? []) b = Math.max(b, x.y + x.fontSize * 1.4 * Math.max(1, x.text.split('\n').length));
  for (const x of p.imageBlocks ?? []) b = Math.max(b, x.y + x.height);
  return b;
}

/** Number of pages shown: every used page plus one blank page to continue on. */
export function surfacePageCount(p: NotePage, minPages = 1): number {
  const b = contentBottom(p);
  const used = Number.isFinite(b) ? Math.floor(Math.max(0, b) / PAGE_HEIGHT) + 1 : 0;
  return Math.max(minPages, used + 1, 1);
}

const shiftStroke = (s: Stroke, dy: number): Stroke => ({ ...s, points: s.points.map((q) => ({ ...q, y: q.y + dy })) });

/** Merges the pages of a note saved before v1.6 into one surface (page i moves down by i pages). */
export function mergePages(pages: NotePage[]): NotePage {
  if (pages.length <= 1) return pages[0];
  const out: NotePage = { ...pages[0], pageNumber: 1, strokes: [], latexBlocks: [], textBlocks: [], imageBlocks: [] };
  pages.forEach((p, i) => {
    const dy = i * PAGE_HEIGHT;
    out.strokes.push(...(p.strokes ?? []).map((s) => shiftStroke(s, dy)));
    out.latexBlocks.push(...(p.latexBlocks ?? []).map((b) => ({ ...b, y: b.y + dy })));
    out.textBlocks!.push(...(p.textBlocks ?? []).map((b) => ({ ...b, y: b.y + dy })));
    out.imageBlocks!.push(...(p.imageBlocks ?? []).map((b) => ({ ...b, y: b.y + dy })));
  });
  return out;
}

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
 * Cuts the surface into pages for text-like exports (.tex, .md, SVG): each item goes to the page
 * that holds its middle (or its top, for blocks), in that page's coordinates.
 */
export function splitSurface(p: NotePage): NotePage[] {
  const n = surfacePageCount(p) - 1 || 1;
  const pages: NotePage[] = Array.from({ length: n }, (_, i) => ({ id: `${p.id}_p${i}`, pageNumber: i + 1, strokes: [], latexBlocks: [], textBlocks: [], imageBlocks: [] }));
  const at = (y: number) => pages[Math.min(n - 1, bandOf(y))];
  for (const s of p.strokes) {
    const k = Math.min(n - 1, bandOf(strokeMidY(s)));
    pages[k].strokes.push(shiftStroke(s, -k * PAGE_HEIGHT));
  }
  for (const b of p.latexBlocks) {
    const pg = at(b.y);
    pg.latexBlocks.push({ ...b, y: b.y - (pg.pageNumber - 1) * PAGE_HEIGHT });
  }
  for (const b of p.textBlocks ?? []) {
    const pg = at(b.y);
    pg.textBlocks!.push({ ...b, y: b.y - (pg.pageNumber - 1) * PAGE_HEIGHT });
  }
  for (const b of p.imageBlocks ?? []) {
    const pg = at(b.y);
    pg.imageBlocks!.push({ ...b, y: b.y - (pg.pageNumber - 1) * PAGE_HEIGHT });
  }
  return pages;
}

/** Items whose middle lies in page `k`, and a shift for everything below a cut. */
function partition(p: NotePage, k: number) {
  const top = k * PAGE_HEIGHT, bottom = top + PAGE_HEIGHT;
  const inBand = (y: number) => y >= top && y < bottom;
  return {
    top,
    bottom,
    strokes: p.strokes.filter((s) => inBand(strokeMidY(s))),
    latex: p.latexBlocks.filter((b) => inBand(b.y + b.height / 2)),
    texts: (p.textBlocks ?? []).filter((b) => inBand(b.y)),
    images: (p.imageBlocks ?? []).filter((b) => inBand(b.y + b.height / 2)),
  };
}

/** Moves everything whose middle is below `y` by `dy`. */
function shiftBelow(p: NotePage, y: number, dy: number): NotePage {
  return {
    ...p,
    strokes: p.strokes.map((s) => (strokeMidY(s) >= y ? shiftStroke(s, dy) : s)),
    latexBlocks: p.latexBlocks.map((b) => (b.y + b.height / 2 >= y ? { ...b, y: b.y + dy } : b)),
    textBlocks: (p.textBlocks ?? []).map((b) => (b.y >= y ? { ...b, y: b.y + dy } : b)),
    imageBlocks: (p.imageBlocks ?? []).map((b) => (b.y + b.height / 2 >= y ? { ...b, y: b.y + dy } : b)),
  };
}

/** Removes page `k` from the surface; the pages below move up. */
export function deleteBand(p: NotePage, k: number): NotePage {
  const part = partition(p, k);
  const drop = new Set<unknown>([...part.strokes, ...part.latex, ...part.texts, ...part.images]);
  const kept: NotePage = {
    ...p,
    strokes: p.strokes.filter((x) => !drop.has(x)),
    latexBlocks: p.latexBlocks.filter((x) => !drop.has(x)),
    textBlocks: (p.textBlocks ?? []).filter((x) => !drop.has(x)),
    imageBlocks: (p.imageBlocks ?? []).filter((x) => !drop.has(x)),
  };
  return shiftBelow(kept, part.bottom, -PAGE_HEIGHT);
}

/** Inserts a copy of page `k` right after it; the pages below move down. */
export function duplicateBand(p: NotePage, k: number): NotePage {
  const part = partition(p, k);
  const moved = shiftBelow(p, part.bottom, PAGE_HEIGHT);
  return {
    ...moved,
    strokes: [...moved.strokes, ...part.strokes.map((s) => ({ ...shiftStroke(s, PAGE_HEIGHT), id: newId('stroke') }))],
    latexBlocks: [...moved.latexBlocks, ...part.latex.map((b) => ({ ...b, id: newId('latex'), y: b.y + PAGE_HEIGHT }))],
    textBlocks: [...(moved.textBlocks ?? []), ...part.texts.map((b) => ({ ...b, id: newId('text'), y: b.y + PAGE_HEIGHT }))],
    imageBlocks: [...(moved.imageBlocks ?? []), ...part.images.map((b) => ({ ...b, id: newId('image'), y: b.y + PAGE_HEIGHT }))],
  };
}

/** Pen strokes whose middle lies in page `k` (for "Page → LaTeX"). */
export function bandStrokes(p: NotePage, k: number): Stroke[] {
  return partition(p, k).strokes;
}

/** Everything that is (even partly) visible in page `k`, still in surface coordinates (printing). */
export function bandSlice(p: NotePage, k: number): NotePage {
  const top = k * PAGE_HEIGHT - 40, bottom = (k + 1) * PAGE_HEIGHT + 40;
  const hits = (a: number, b: number) => b >= top && a <= bottom;
  return {
    ...p,
    strokes: p.strokes.filter((s) => {
      let a = Infinity, b = -Infinity;
      for (const q of s.points) {
        a = Math.min(a, q.y);
        b = Math.max(b, q.y);
      }
      return hits(a, b);
    }),
    latexBlocks: p.latexBlocks.filter((x) => hits(x.y, x.y + x.height)),
    textBlocks: (p.textBlocks ?? []).filter((x) => hits(x.y, x.y + x.fontSize * 1.4 * (x.text.split('\n').length + 2))),
    imageBlocks: (p.imageBlocks ?? []).filter((x) => hits(x.y, x.y + x.height)),
  };
}
