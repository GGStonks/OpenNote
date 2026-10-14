import { Folder, NoteDocument } from './types';

/**
 * Library organisation: the folder tree, sorting and tag filtering of the Home screen.
 */

export type SortKey = 'modified-desc' | 'modified-asc' | 'created-desc' | 'created-asc' | 'title-asc' | 'title-desc';

export const SORT_OPTIONS: { id: SortKey; group: string; label: string }[] = [
  { id: 'modified-desc', group: 'Last modified', label: 'Newest first' },
  { id: 'modified-asc', group: 'Last modified', label: 'Oldest first' },
  { id: 'created-desc', group: 'Created', label: 'Newest first' },
  { id: 'created-asc', group: 'Created', label: 'Oldest first' },
  { id: 'title-asc', group: 'Title', label: 'A → Z' },
  { id: 'title-desc', group: 'Title', label: 'Z → A' },
];

/**
 * Tag filter. 'off': every note. 'whitelist': only notes with the selected tags (any of them, or
 * all of them with matchAll). 'blacklist': notes with any of the selected tags are hidden. Each
 * mode keeps its own selection, so switching modes does not lose it.
 */
export type TagMode = 'off' | 'whitelist' | 'blacklist';

export interface LibraryPrefs {
  sort: SortKey;
  tagMode: TagMode;
  whitelist: string[];
  blacklist: string[];
  matchAll: boolean;
  viewMode: 'grid' | 'list';
  sidebarCollapsed: boolean;
  /** Folders open in the sidebar tree. */
  expanded: string[];
}

const PREFS_KEY = 'opennote_library_v1';

export function loadLibraryPrefs(): LibraryPrefs {
  const defaults: LibraryPrefs = {
    sort: 'modified-desc',
    tagMode: 'off',
    whitelist: [],
    blacklist: [],
    matchAll: false,
    viewMode: 'grid',
    sidebarCollapsed: typeof window !== 'undefined' && window.innerWidth < 768,
    expanded: [],
  };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return { ...defaults, ...JSON.parse(raw) };
  } catch {
    /* storage unavailable */
  }
  return defaults;
}

export function saveLibraryPrefs(p: LibraryPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function sortNotes(notes: NoteDocument[], key: SortKey): NoteDocument[] {
  const out = [...notes];
  switch (key) {
    case 'modified-desc': return out.sort((a, b) => b.updatedAt - a.updatedAt);
    case 'modified-asc': return out.sort((a, b) => a.updatedAt - b.updatedAt);
    case 'created-desc': return out.sort((a, b) => b.createdAt - a.createdAt);
    case 'created-asc': return out.sort((a, b) => a.createdAt - b.createdAt);
    case 'title-asc': return out.sort((a, b) => collator.compare(a.title, b.title));
    case 'title-desc': return out.sort((a, b) => collator.compare(b.title, a.title));
  }
}

export function sortFolders(folders: Folder[], key: SortKey): Folder[] {
  const out = [...folders];
  if (key === 'title-desc') return out.sort((a, b) => collator.compare(b.name, a.name));
  if (key === 'created-desc' || key === 'modified-desc') return out.sort((a, b) => b.createdAt - a.createdAt);
  if (key === 'created-asc' || key === 'modified-asc') return out.sort((a, b) => a.createdAt - b.createdAt);
  return out.sort((a, b) => collator.compare(a.name, b.name));
}

/** True when the note passes the tag filter. Tags that no longer exist are ignored. */
export function passesTagFilter(n: NoteDocument, p: Pick<LibraryPrefs, 'tagMode' | 'whitelist' | 'blacklist' | 'matchAll'>, tagIds: Set<string>): boolean {
  const own = n.tagIds ?? [];
  if (p.tagMode === 'whitelist') {
    const sel = p.whitelist.filter((t) => tagIds.has(t));
    if (!sel.length) return true;
    return p.matchAll ? sel.every((t) => own.includes(t)) : sel.some((t) => own.includes(t));
  }
  if (p.tagMode === 'blacklist') return !p.blacklist.some((t) => tagIds.has(t) && own.includes(t));
  return true;
}

export function tagFilterActive(p: Pick<LibraryPrefs, 'tagMode' | 'whitelist' | 'blacklist'>, tagIds: Set<string>): boolean {
  if (p.tagMode === 'whitelist') return p.whitelist.some((t) => tagIds.has(t));
  if (p.tagMode === 'blacklist') return p.blacklist.some((t) => tagIds.has(t));
  return false;
}

export function childFolders(folders: Folder[], parentId: string | undefined): Folder[] {
  return folders.filter((f) => (f.parentId ?? undefined) === parentId);
}

/** The folder and every folder nested in it. */
export function folderAndDescendants(folders: Folder[], id: string): Set<string> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) if (f.parentId && out.has(f.parentId) && !out.has(f.id)) (out.add(f.id), (grew = true));
  }
  return out;
}

/** Folders from the top level down to `id` (empty for the root or an unknown id). */
export function folderPath(folders: Folder[], id: string | null | undefined): Folder[] {
  const path: Folder[] = [];
  const seen = new Set<string>();
  let cur = folders.find((f) => f.id === id);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    path.unshift(cur);
    cur = folders.find((f) => f.id === cur!.parentId);
  }
  return path;
}

/** The folder a note is in, or undefined for the root (also when its folder no longer exists). */
export function noteFolder(n: NoteDocument, folderIds: Set<string>): string | undefined {
  return n.folderId && folderIds.has(n.folderId) ? n.folderId : undefined;
}

export function matchesSearch(n: NoteDocument, q: string): boolean {
  if (!q) return true;
  if (n.title.toLowerCase().includes(q)) return true;
  return n.pages.some(
    (pg) => (pg.textBlocks ?? []).some((t) => t.text.toLowerCase().includes(q)) || pg.latexBlocks.some((b) => b.latexCode.toLowerCase().includes(q))
  );
}

export const FOLDER_COLORS = ['#3B82F6', '#10B981', '#8B5CF6', '#F59E0B', '#EF4444', '#EC4899', '#0EA5E9', '#64748B'];
export const TAG_COLORS = ['#3B82F6', '#10B981', '#8B5CF6', '#F59E0B', '#EF4444', '#EC4899', '#14B8A6', '#6366F1', '#84CC16', '#64748B'];
