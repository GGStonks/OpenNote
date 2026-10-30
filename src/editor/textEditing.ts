import type { ListKind } from '../types';

/**
 * The text box being edited, for the formatting bar (TextFormatBar): its paragraph commands act on
 * the editor's selection, which only the editor (Blocks.tsx TextBlockView) holds.
 */
export interface ActiveTextEditor {
  toggleList(kind: ListKind): void;
  indent(d: 1 | -1): void;
  /** The list kind of the caret's paragraph. */
  listAtCaret(): ListKind | null;
}

export const activeTextEditor: { current: ActiveTextEditor | null } = { current: null };
