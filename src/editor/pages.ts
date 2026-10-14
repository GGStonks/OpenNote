import { useSyncExternalStore } from 'react';
import { NoteDocument, NotePage, newId } from '../types';
import { SetupPatch } from './pageSetup';

/**
 * Page operations of the page manager (reorder, delete, duplicate, copy / cut / paste, paper).
 * They are pure document updates: the editor commits each one as a single undo step.
 */

const renumber = (pages: NotePage[]): NotePage[] => pages.map((p, i) => (p.pageNumber === i + 1 ? p : { ...p, pageNumber: i + 1 }));

export function blankPage(): NotePage {
  return { id: newId('page'), pageNumber: 0, strokes: [], latexBlocks: [], textBlocks: [], imageBlocks: [] };
}

/** A copy of a page with new ids for the page and everything on it (paper settings kept). */
export function clonePage(p: NotePage): NotePage {
  const c = structuredClone(p);
  const now = Date.now();
  return {
    ...c,
    id: newId('page'),
    strokes: c.strokes.map((s) => ({ ...s, id: newId('stroke') })),
    latexBlocks: c.latexBlocks.map((b) => ({ ...b, id: newId(b.isTikz ? 'tikz' : 'latex'), createdAt: now })),
    textBlocks: (c.textBlocks ?? []).map((b) => ({ ...b, id: newId('text'), createdAt: now })),
    imageBlocks: (c.imageBlocks ?? []).map((b) => ({ ...b, id: newId('image'), createdAt: now })),
  };
}

/** Inserts pages before index `at` (0..pages.length). */
export function insertPages(d: NoteDocument, at: number, pages: NotePage[]): NoteDocument {
  const list = [...d.pages];
  list.splice(Math.max(0, Math.min(list.length, at)), 0, ...pages);
  return { ...d, pages: renumber(list) };
}

export function appendBlankPage(d: NoteDocument): { doc: NoteDocument; page: NotePage } {
  const page = blankPage();
  return { doc: insertPages(d, d.pages.length, [page]), page };
}

/** Removes pages; a note always keeps one page (a blank one when all were removed). */
export function deletePages(d: NoteDocument, ids: ReadonlySet<string>): NoteDocument {
  const kept = d.pages.filter((p) => !ids.has(p.id));
  if (kept.length === d.pages.length) return d;
  return { ...d, pages: renumber(kept.length ? kept : [blankPage()]) };
}

/** Puts a copy of each page right after it. Returns the copies' ids. */
export function duplicatePages(d: NoteDocument, ids: ReadonlySet<string>): { doc: NoteDocument; copies: string[] } {
  const copies: string[] = [];
  const list: NotePage[] = [];
  for (const p of d.pages) {
    list.push(p);
    if (ids.has(p.id)) {
      const c = clonePage(p);
      copies.push(c.id);
      list.push(c);
    }
  }
  return { doc: { ...d, pages: renumber(list) }, copies };
}

/**
 * Moves the pages (keeping their order) so they sit before the page that was at index `to` before
 * the move (`to` = pages.length: at the end).
 */
export function movePages(d: NoteDocument, ids: ReadonlySet<string>, to: number): NoteDocument {
  const moving = d.pages.filter((p) => ids.has(p.id));
  if (!moving.length) return d;
  const before = d.pages.slice(0, to).filter((p) => !ids.has(p.id)).length;
  const rest = d.pages.filter((p) => !ids.has(p.id));
  rest.splice(before, 0, ...moving);
  if (rest.every((p, i) => p === d.pages[i])) return d;
  return { ...d, pages: renumber(rest) };
}

/** Sets the paper of the pages; a field set to undefined goes back to the note's default. */
export function setPagesSetup(d: NoteDocument, ids: ReadonlySet<string>, patch: SetupPatch | 'reset'): NoteDocument {
  return {
    ...d,
    pages: d.pages.map((p) => {
      if (!ids.has(p.id)) return p;
      if (patch === 'reset') {
        const { paperStyle: _s, paperColor: _c, size: _z, orientation: _o, ...rest } = p;
        return rest;
      }
      return { ...p, ...patch };
    }),
  };
}

// ----------------------------------------------------------------------------- page clipboard
// Copied / cut pages, pasted into any note as many times as wanted, while the app is open.

let clip: NotePage[] | null = null;
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const getClip = () => clip;

export function copyPages(d: NoteDocument, ids: ReadonlySet<string>): number {
  const pages = d.pages.filter((p) => ids.has(p.id));
  if (!pages.length) return 0;
  clip = structuredClone(pages);
  listeners.forEach((fn) => fn());
  return pages.length;
}

/** Fresh copies of the copied pages (new ids), or null when nothing was copied. */
export function pagesFromClipboard(): NotePage[] | null {
  return clip ? clip.map(clonePage) : null;
}

export function usePageClipboard(): NotePage[] | null {
  return useSyncExternalStore(subscribe, getClip, getClip);
}
