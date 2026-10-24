import { useSyncExternalStore } from 'react';
import { ImageBlock, LatexBlock, NoteDocument, NotePage, PAGE_HEIGHT, PageSheet, Stroke, TextBlock, newId } from '../types';
import { markMoved } from '../ink/strokeRenderer';
import { PageSetup, SetupPatch, pageSetup } from './pageSetup';
import { restamp } from './zorder';
import { PACKED_STRIDE, packedPoints } from '../storage/packedPoints';

/**
 * A note is one continuous vertical surface (doc.pages[0]): ink and blocks go anywhere on it and
 * cross page lines freely. The surface is cut into pages (doc.sheets), stacked top to bottom with
 * no gap, each with its own paper, size and orientation. The surface is as wide as the widest
 * page and narrower pages are centred on it.
 *
 * Page operations (move, delete, duplicate, copy / paste, a new size) re-cut the surface: each item
 * belongs to the page that holds its middle (the top of a text box), and moves with that page.
 * Where nothing moves, items keep their identity (the page canvases do not repaint).
 */

export interface SheetBox extends PageSetup {
  id: string;
  index: number;
  /** Position on the surface (surface px). */
  top: number;
  left: number;
}

export interface SurfaceLayout {
  width: number;
  height: number;
  sheets: SheetBox[];
}

export function surfaceLayout(doc: NoteDocument): SurfaceLayout {
  const list = doc.sheets.length ? doc.sheets : [{ id: '_' }];
  const setups = list.map((s) => pageSetup(doc, s));
  const width = Math.max(...setups.map((s) => s.width));
  let top = 0;
  const sheets = setups.map((s, i) => {
    const b: SheetBox = { ...s, id: list[i].id, index: i, top, left: (width - s.width) / 2 };
    top += s.height;
    return b;
  });
  return { width, height: top, sheets };
}

/** Index of the page at surface height y (clamped to the first / last page). */
export function sheetIndexAt(layout: SurfaceLayout, y: number): number {
  const s = layout.sheets;
  let k = 0;
  while (k + 1 < s.length && s[k + 1].top <= y) k++;
  return k;
}

// ----------------------------------------------------------------------------- item geometry

const yRanges = new WeakMap<Stroke, { minY: number; maxY: number }>();
function strokeY(s: Stroke) {
  let r = yRanges.get(s);
  if (!r) {
    let minY = Infinity, maxY = -Infinity;
    const packed = packedPoints.get(s);
    if (packed) {
      // Loaded and not unpacked yet: read from the packed array (packedPoints.ts).
      for (let o = 1; o < packed.length; o += PACKED_STRIDE) {
        if (packed[o] < minY) minY = packed[o];
        if (packed[o] > maxY) maxY = packed[o];
      }
    } else
      for (const p of s.points) {
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
    r = { minY, maxY };
    yRanges.set(s, r);
  }
  return r;
}

const textH = (t: TextBlock) => t.fontSize * 1.4 * Math.max(1, t.text.split('\n').length);

/** Height that decides which page an item belongs to. */
const ownY = {
  stroke: (s: Stroke) => {
    const r = strokeY(s);
    return (r.minY + r.maxY) / 2;
  },
  latex: (b: LatexBlock) => b.y + b.height / 2,
  text: (b: TextBlock) => b.y,
  image: (b: ImageBlock) => b.y + b.height / 2,
};

/** Lowest point of the content, or -Infinity on an empty surface. */
export function contentBottom(p: NotePage): number {
  let b = -Infinity;
  for (const s of p.strokes) b = Math.max(b, strokeY(s).maxY);
  for (const x of p.latexBlocks) b = Math.max(b, x.y + x.height);
  for (const x of p.textBlocks ?? []) b = Math.max(b, x.y + textH(x));
  for (const x of p.imageBlocks ?? []) b = Math.max(b, x.y + x.height);
  return b;
}

interface Items {
  strokes: Stroke[];
  latexBlocks: LatexBlock[];
  textBlocks: TextBlock[];
  imageBlocks: ImageBlock[];
}

const noItems = (): Items => ({ strokes: [], latexBlocks: [], textBlocks: [], imageBlocks: [] });
const isEmpty = (c: Items) => !c.strokes.length && !c.latexBlocks.length && !c.textBlocks.length && !c.imageBlocks.length;

/** The items each page owns (surface coordinates, same objects). */
function ownership(surface: NotePage, L: SurfaceLayout): Items[] {
  const out = L.sheets.map(noItems);
  const at = (y: number) => out[sheetIndexAt(L, y)];
  for (const s of surface.strokes) at(ownY.stroke(s)).strokes.push(s);
  for (const b of surface.latexBlocks) at(ownY.latex(b)).latexBlocks.push(b);
  for (const b of surface.textBlocks ?? []) at(ownY.text(b)).textBlocks.push(b);
  for (const b of surface.imageBlocks ?? []) at(ownY.image(b)).imageBlocks.push(b);
  return out;
}

/**
 * The stroke moved by (dx, dy). The same stroke moved by the same offset gives the same object:
 * page thumbnails are rebuilt after every edit, and only the pages whose strokes really changed
 * are painted again (unchanged copies were new objects, so every thumbnail repainted all its ink).
 */
const movedCopies = new WeakMap<Stroke, { dx: number; dy: number; out: Stroke }>();
const moveStroke = (s: Stroke, dx: number, dy: number): Stroke => {
  const c = movedCopies.get(s);
  if (c && c.dx === dx && c.dy === dy) return c.out;
  const out = markMoved({ ...s, points: s.points.map((q) => ({ ...q, x: q.x + dx, y: q.y + dy })) }, s, dx, dy);
  movedCopies.set(s, { dx, dy, out });
  return out;
};

function translate(c: Items, dx: number, dy: number): Items {
  if (!dx && !dy) return c;
  return {
    strokes: c.strokes.map((s) => moveStroke(s, dx, dy)),
    latexBlocks: c.latexBlocks.map((b) => ({ ...b, x: b.x + dx, y: b.y + dy })),
    textBlocks: c.textBlocks.map((b) => ({ ...b, x: b.x + dx, y: b.y + dy })),
    imageBlocks: c.imageBlocks.map((b) => ({ ...b, x: b.x + dx, y: b.y + dy })),
  };
}

/** A copy with new ids. */
function cloneItems(c: Items): Items {
  const k = structuredClone(c);
  // Stacking order (zorder.ts): the copy is new, on top, in the original's order.
  return restamp({
    strokes: k.strokes.map((s) => ({ ...s, id: newId('stroke') })),
    latexBlocks: k.latexBlocks.map((b) => ({ ...b, id: newId(b.isTikz ? 'tikz' : 'latex') })),
    textBlocks: k.textBlocks.map((b) => ({ ...b, id: newId('text') })),
    imageBlocks: k.imageBlocks.map((b) => ({ ...b, id: newId('image') })),
  });
}

// ----------------------------------------------------------------------------- re-cutting

/**
 * A page and its content. `origin` is the point of the content that goes to the page's top on the
 * surface's centre line: content is placed with x + (centre - origin.x), y + (top - origin.y).
 */
export interface SheetEntry {
  sheet: PageSheet;
  content: Items | null;
  origin: { x: number; y: number };
}

/**
 * Re-cuts the note: `edit` gets the pages with the content they own and returns the new list
 * (pages removed, moved, added or re-sized); `patch` changes the note's own fields (its default
 * paper). The content is then placed on the pages of the new layout. Items keep their order on the
 * surface (it is their drawing order); new items go on top.
 */
export function recut(d: NoteDocument, edit: (entries: SheetEntry[]) => SheetEntry[], patch: Partial<NoteDocument> = {}): NoteDocument {
  const surface = d.pages[0];
  const L = surfaceLayout(d);
  const own = ownership(surface, L);
  const entries: SheetEntry[] = d.sheets.map((sheet, i) => ({ sheet, content: own[i], origin: { x: L.width / 2, y: L.sheets[i].top } }));
  let next = edit(entries);
  if (!next.length) next = [{ sheet: { id: newId('sheet') }, content: null, origin: { x: 0, y: 0 } }];
  const nd: NoteDocument = { ...d, ...patch, sheets: next.map((e) => e.sheet) };
  const NL = surfaceLayout(nd);

  // Where each original item goes (undefined: its page was removed).
  const placed = new Map<object, object>();
  const extra = noItems();
  const ownSet = new Set<Items>(own);
  next.forEach((e, j) => {
    if (!e.content) return;
    const moved = translate(e.content, NL.width / 2 - e.origin.x, NL.sheets[j].top - e.origin.y);
    if (ownSet.has(e.content)) {
      // The page's own content: mapped in place (a page kept twice is only placed once).
      ownSet.delete(e.content);
      (['strokes', 'latexBlocks', 'textBlocks', 'imageBlocks'] as const).forEach((k) => e.content![k].forEach((it, i) => placed.set(it, moved[k][i])));
    } else {
      extra.strokes.push(...moved.strokes);
      extra.latexBlocks.push(...moved.latexBlocks);
      extra.textBlocks.push(...moved.textBlocks);
      extra.imageBlocks.push(...moved.imageBlocks);
    }
  });
  let changed = !isEmpty(extra);
  const remap = <T extends object>(list: T[]): T[] => {
    const out: T[] = [];
    for (const it of list) {
      const to = placed.get(it) as T | undefined;
      if (to !== it) changed = true;
      if (to) out.push(to);
    }
    return out;
  };
  const strokes = remap(surface.strokes), latexBlocks = remap(surface.latexBlocks);
  const textBlocks = remap(surface.textBlocks ?? []), imageBlocks = remap(surface.imageBlocks ?? []);
  if (!changed) return nd;
  return {
    ...nd,
    pages: [
      {
        ...surface,
        strokes: [...strokes, ...extra.strokes],
        latexBlocks: [...latexBlocks, ...extra.latexBlocks],
        textBlocks: [...textBlocks, ...extra.textBlocks],
        imageBlocks: [...imageBlocks, ...extra.imageBlocks],
      },
    ],
  };
}

const blank = (): SheetEntry => ({ sheet: { id: newId('sheet') }, content: null, origin: { x: 0, y: 0 } });

export function appendBlankSheet(d: NoteDocument): NoteDocument {
  return recut(d, (es) => [...es, blank()]);
}

/** New content reaching below this share of the last page's height adds a page after it. */
const ROLL_ZONE = 0.75;

/**
 * Infinite roll: new content (drawn, typed, inserted or pasted) that reaches the bottom of the
 * last page (its lower quarter, or past its end) gets exactly one blank page after it. It is decided once, from what the edit added (items whose
 * ids `before` did not have), never from what is on the page: a stroke that runs off the end of
 * the note must not add a page for each page it reaches into, and a trailing page the user deletes
 * must not come back because of content that was already there. Returns `d` when nothing is added.
 */
export function trailingSheetFor(before: NotePage, d: NoteDocument): NoteDocument {
  const after = d.pages[0];
  if (after === before) return d;
  const had = new Set<string>();
  for (const s of before.strokes) had.add(s.id);
  for (const x of before.latexBlocks) had.add(x.id);
  for (const x of before.textBlocks ?? []) had.add(x.id);
  for (const x of before.imageBlocks ?? []) had.add(x.id);
  let bottom = -Infinity;
  for (const s of after.strokes) if (!had.has(s.id)) bottom = Math.max(bottom, strokeY(s).maxY);
  for (const x of after.latexBlocks) if (!had.has(x.id)) bottom = Math.max(bottom, x.y + x.height);
  for (const x of after.textBlocks ?? []) if (!had.has(x.id)) bottom = Math.max(bottom, x.y + textH(x));
  for (const x of after.imageBlocks ?? []) if (!had.has(x.id)) bottom = Math.max(bottom, x.y + x.height);
  const L = surfaceLayout(d);
  const last = L.sheets[L.sheets.length - 1];
  return bottom > last.top + last.height * ROLL_ZONE ? appendBlankSheet(d) : d;
}

export function deleteSheets(d: NoteDocument, ids: ReadonlySet<string>): NoteDocument {
  return recut(d, (es) => es.filter((e) => !ids.has(e.sheet.id)));
}

/** Puts a copy of each page (and its content) right after it. Returns the copies' ids. */
export function duplicateSheets(d: NoteDocument, ids: ReadonlySet<string>): { doc: NoteDocument; copies: string[] } {
  const copies: string[] = [];
  const doc = recut(d, (es) =>
    es.flatMap((e) => {
      if (!ids.has(e.sheet.id)) return [e];
      const copy: SheetEntry = { sheet: { ...e.sheet, id: newId('sheet') }, content: e.content && cloneItems(e.content), origin: e.origin };
      copies.push(copy.sheet.id);
      return [e, copy];
    })
  );
  return { doc, copies };
}

/** Moves the pages (keeping their order) before the page that was at index `to` (length: the end). */
export function moveSheets(d: NoteDocument, ids: ReadonlySet<string>, to: number): NoteDocument {
  return recut(d, (es) => {
    const moving = es.filter((e) => ids.has(e.sheet.id));
    const before = es.slice(0, to).filter((e) => !ids.has(e.sheet.id)).length;
    const rest = es.filter((e) => !ids.has(e.sheet.id));
    rest.splice(before, 0, ...moving);
    return rest;
  });
}

/** Paper of the pages; 'reset': back to the note's paper. The content stays on its pages. */
export function setSheetsSetup(d: NoteDocument, ids: ReadonlySet<string>, patch: SetupPatch | 'reset'): NoteDocument {
  return recut(d, (es) =>
    es.map((e) => {
      if (!ids.has(e.sheet.id)) return e;
      if (patch === 'reset') return { ...e, sheet: { id: e.sheet.id } };
      return { ...e, sheet: { ...e.sheet, ...patch } };
    })
  );
}

/** The note's default paper (pages without paper of their own follow it). */
export function setNotePaper(d: NoteDocument, patch: SetupPatch): NoteDocument {
  return recut(d, (es) => es, {
    ...(patch.paperStyle ? { paperStyle: patch.paperStyle } : {}),
    ...(patch.paperColor ? { paperColor: patch.paperColor } : {}),
    ...(patch.size ? { pageSize: patch.size } : {}),
    ...(patch.orientation ? { orientation: patch.orientation } : {}),
  });
}

// ----------------------------------------------------------------------------- page clipboard
// Copied / cut pages with their content, pasted into any note as often as wanted while the app is open.

let clip: { sheet: PageSheet; content: Items }[] | null = null;
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const getClip = () => clip;

export function copySheets(d: NoteDocument, ids: ReadonlySet<string>): number {
  const L = surfaceLayout(d);
  const own = ownership(d.pages[0], L);
  const picked = d.sheets.flatMap((sheet, i) =>
    ids.has(sheet.id) ? [{ sheet: structuredClone(sheet), content: structuredClone(translate(own[i], -L.width / 2, -L.sheets[i].top)) }] : []
  );
  if (!picked.length) return 0;
  clip = picked;
  listeners.forEach((fn) => fn());
  return picked.length;
}

/** Inserts the copied pages before index `at`. Returns the new pages' ids (null: nothing copied). */
export function pasteSheets(d: NoteDocument, at: number): { doc: NoteDocument; ids: string[] } | null {
  if (!clip) return null;
  const ids: string[] = [];
  const add: SheetEntry[] = clip.map((c) => {
    const id = newId('sheet');
    ids.push(id);
    return { sheet: { ...c.sheet, id }, content: cloneItems(c.content), origin: { x: 0, y: 0 } };
  });
  const doc = recut(d, (es) => {
    const list = [...es];
    list.splice(Math.max(0, Math.min(list.length, at)), 0, ...add);
    return list;
  });
  return { doc, ids };
}

export function usePageClipboard(): unknown {
  return useSyncExternalStore(subscribe, getClip, getClip);
}

// ----------------------------------------------------------------------------- views of pages

/** Everything (even partly) on a page, in surface coordinates (printing a page). */
export function sheetSlice(surface: NotePage, box: SheetBox): NotePage {
  const top = box.top - 40, bottom = box.top + box.height + 40;
  const hits = (a: number, b: number) => b >= top && a <= bottom;
  return {
    ...surface,
    strokes: surface.strokes.filter((s) => {
      const r = strokeY(s);
      return hits(r.minY, r.maxY);
    }),
    latexBlocks: surface.latexBlocks.filter((x) => hits(x.y, x.y + x.height)),
    textBlocks: (surface.textBlocks ?? []).filter((x) => hits(x.y, x.y + textH(x) * 2)),
    imageBlocks: (surface.imageBlocks ?? []).filter((x) => hits(x.y, x.y + x.height)),
  };
}

/** The same, moved to the page's own frame (0,0 = its top-left corner): thumbnails. */
export function sheetView(surface: NotePage, box: SheetBox): NotePage {
  const s = sheetSlice(surface, box);
  return { ...s, ...translate({ strokes: s.strokes, latexBlocks: s.latexBlocks, textBlocks: s.textBlocks ?? [], imageBlocks: s.imageBlocks ?? [] }, -box.left, -box.top) };
}

/** Pen strokes a page owns ("Page → LaTeX"). */
export function sheetStrokes(d: NoteDocument, layout: SurfaceLayout, k: number): Stroke[] {
  return ownership(d.pages[0], layout)[k]?.strokes ?? [];
}

/**
 * The surface cut into its pages for text-like exports (.tex, .md, SVG): each item once, on the
 * page that owns it, in that page's frame. Blank pages at the end are left out.
 */
export function splitIntoPages(d: NoteDocument): { page: NotePage; box: SheetBox }[] {
  const L = surfaceLayout(d);
  const own = ownership(d.pages[0], L);
  let n = own.length;
  while (n > 1 && isEmpty(own[n - 1])) n--;
  return L.sheets.slice(0, n).map((box, i) => {
    const c = translate(own[i], -box.left, -box.top);
    return { box, page: { id: `${d.pages[0].id}_p${i}`, pageNumber: i + 1, ...c } };
  });
}

/** Pages to print: all but blank pages at the end. */
export function printedSheets(d: NoteDocument): SheetBox[] {
  const L = surfaceLayout(d);
  const own = ownership(d.pages[0], L);
  let n = own.length;
  while (n > 1 && isEmpty(own[n - 1])) n--;
  return L.sheets.slice(0, n);
}

// ----------------------------------------------------------------------------- migration

/** Sheets for a v1.6-v1.11 surface (US Letter pages; content reaching into a page makes it a page). */
export function letterSheetsFor(surface: NotePage): PageSheet[] {
  const b = contentBottom(surface);
  const n = Number.isFinite(b) ? Math.floor(Math.max(0, b) / PAGE_HEIGHT) + 1 : 1;
  return Array.from({ length: n }, () => ({ id: newId('sheet') }));
}

/** Puts separate pages (older notes, v1.12 development) on one surface, each page on its sheet. */
export function surfaceFromPages(d: Omit<NoteDocument, 'sheets'>, pages: (NotePage & Omit<PageSheet, 'id'>)[]): { surface: NotePage; sheets: PageSheet[] } {
  const sheets: PageSheet[] = pages.map((p) => ({
    id: newId('sheet'),
    ...(p.paperStyle ? { paperStyle: p.paperStyle } : {}),
    ...(p.paperColor ? { paperColor: p.paperColor } : {}),
    ...(p.size ? { size: p.size } : {}),
    ...(p.orientation ? { orientation: p.orientation } : {}),
  }));
  const L = surfaceLayout({ ...d, sheets } as NoteDocument);
  const out = noItems();
  pages.forEach((p, i) => {
    const c = translate(
      { strokes: p.strokes ?? [], latexBlocks: p.latexBlocks ?? [], textBlocks: p.textBlocks ?? [], imageBlocks: p.imageBlocks ?? [] },
      L.sheets[i].left,
      L.sheets[i].top
    );
    out.strokes.push(...c.strokes);
    out.latexBlocks.push(...c.latexBlocks);
    out.textBlocks.push(...c.textBlocks);
    out.imageBlocks.push(...c.imageBlocks);
  });
  const first = pages[0];
  return { surface: { id: first?.id ?? newId('page'), pageNumber: 1, ...out }, sheets };
}
