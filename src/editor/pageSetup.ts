import { NoteDocument, PageOrientation, PageSheet, PageSize, PaperColor, PaperColorName, PaperStyle, PdfPageRef } from '../types';

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
  { id: 'lines', label: 'Lines' },
  { id: 'narrowLines', label: 'Narrow lines' },
  { id: 'grid', label: 'Squared' },
  { id: 'graph', label: 'Graph' },
  { id: 'dots', label: 'Dotted' },
];

export const PAPER_COLOR_OPTIONS: { id: PaperColorName; label: string }[] = [
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
  /** A page of its own size (PageSheet.width / height): no format is its own. */
  custom: boolean;
  /** The PDF page drawn as this page's paper, if any. */
  pdf: PdfPageRef | null;
  paperStyle: PaperStyle;
  paperColor: PaperColor;
  /** Pattern colour (#RRGGBB); null: the default for the paper. */
  patternColor: string | null;
  size: PageSize;
  orientation: PageOrientation;
  /** Page size in px, orientation applied. */
  width: number;
  height: number;
}

/** patternColor null: back to the default pattern colour. */
export type SetupPatch = Partial<Pick<PageSetup, 'paperStyle' | 'paperColor' | 'patternColor' | 'size' | 'orientation'>>;

export function pageSetup(doc: Pick<NoteDocument, 'paperStyle' | 'paperColor' | 'patternColor' | 'pageSize' | 'orientation'>, page: PageSheet): PageSetup {
  const size = page.size ?? doc.pageSize ?? 'letter';
  const orientation = page.orientation ?? doc.orientation ?? 'portrait';
  const s = PAGE_SIZES[size] ?? PAGE_SIZES.letter;
  const landscape = orientation === 'landscape';
  const custom = !!(page.width && page.height && page.width > 0 && page.height > 0);
  return {
    custom,
    pdf: page.pdf ?? null,
    paperStyle: page.paperStyle ?? doc.paperStyle,
    paperColor: page.paperColor ?? doc.paperColor,
    patternColor: page.patternColor ?? doc.patternColor ?? null,
    size,
    orientation,
    width: custom ? page.width! : landscape ? s.h : s.w,
    height: custom ? page.height! : landscape ? s.w : s.h,
  };
}

/** True when the page has paper of its own (not the note's default; a PDF page and its size are content, kept by a reset). */
export function hasOwnSetup(p: PageSheet): boolean {
  return p.paperStyle !== undefined || p.paperColor !== undefined || p.patternColor !== undefined || p.size !== undefined || p.orientation !== undefined;
}
