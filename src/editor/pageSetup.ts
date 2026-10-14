import { NoteDocument, PageOrientation, PageSheet, PageSize, PaperColor, PaperStyle } from '../types';

/**
 * Paper of each page: a page's own pattern, colour, format and orientation (set in the page
 * manager), or else the note's defaults, which are also what new pages get.
 */

/** Sheet formats in CSS px (96 per inch), portrait. */
export const PAGE_SIZES: Record<PageSize, { label: string; w: number; h: number }> = {
  letter: { label: 'Letter', w: 816, h: 1056 },
  legal: { label: 'Legal', w: 816, h: 1344 },
  a3: { label: 'A3', w: 1123, h: 1587 },
  a4: { label: 'A4', w: 794, h: 1123 },
  a5: { label: 'A5', w: 559, h: 794 },
  b5: { label: 'B5', w: 665, h: 945 },
};

export const PAPER_STYLE_OPTIONS: { id: PaperStyle; label: string }[] = [
  { id: 'blank', label: 'Blank' },
  { id: 'ruled', label: 'Ruled' },
  { id: 'narrow', label: 'Narrow ruled' },
  { id: 'grid', label: 'Squared' },
  { id: 'graph', label: 'Graph' },
  { id: 'dots', label: 'Dotted' },
];

export const PAPER_COLOR_OPTIONS: { id: PaperColor; label: string }[] = [
  { id: 'white', label: 'White' },
  { id: 'cream', label: 'Cream' },
  { id: 'yellow', label: 'Yellow' },
  { id: 'ochre', label: 'Ochre' },
  { id: 'blue', label: 'Blue' },
  { id: 'green', label: 'Green' },
  { id: 'pink', label: 'Pink' },
  { id: 'gray', label: 'Grey' },
  { id: 'dark', label: 'Dark' },
];

export interface PageSetup {
  paperStyle: PaperStyle;
  paperColor: PaperColor;
  size: PageSize;
  orientation: PageOrientation;
  /** Page size in px, orientation applied. */
  width: number;
  height: number;
}

export type SetupPatch = Partial<Pick<PageSetup, 'paperStyle' | 'paperColor' | 'size' | 'orientation'>>;

export function pageSetup(doc: Pick<NoteDocument, 'paperStyle' | 'paperColor' | 'pageSize' | 'orientation'>, page: PageSheet): PageSetup {
  const size = page.size ?? doc.pageSize ?? 'letter';
  const orientation = page.orientation ?? doc.orientation ?? 'portrait';
  const s = PAGE_SIZES[size] ?? PAGE_SIZES.letter;
  const landscape = orientation === 'landscape';
  return {
    paperStyle: page.paperStyle ?? doc.paperStyle,
    paperColor: page.paperColor ?? doc.paperColor,
    size,
    orientation,
    width: landscape ? s.h : s.w,
    height: landscape ? s.w : s.h,
  };
}

/** True when the page has paper of its own (not the note's default). */
export function hasOwnSetup(p: PageSheet): boolean {
  return p.paperStyle !== undefined || p.paperColor !== undefined || p.size !== undefined || p.orientation !== undefined;
}
