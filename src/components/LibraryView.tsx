import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  FileText, Plus, Search, MoreVertical, Trash2, Edit2, BookOpen, Settings as SettingsIcon,
  Grid as GridIcon, List as ListIcon, Copy, FolderInput, Upload, Folder as FolderIcon, FolderPlus,
  ChevronRight, ChevronDown, Tag as TagIcon, SlidersHorizontal, Check, X, Hash, PencilLine, CalendarPlus,
} from 'lucide-react';
import { Folder, NoteDocument, Tag } from '../types';
import { NoteThumb } from './NoteThumb';
import { OnScreen, useOnScreen } from './onScreen';
import { Logo } from './Logo';
import { printedSheets } from '../editor/sheets';
import {
  FOLDER_COLORS, LibraryPrefs, SORT_OPTIONS, TAG_COLORS, TagMode, childFolders, folderAndDescendants, folderPath,
  loadLibraryPrefs, matchesSearch, noteFolder, passesTagFilter, saveLibraryPrefs, sortFolders, sortNotes, tagFilterActive,
} from '../library';

/** Pages of a note (not counting the blank page the note always ends with). */
const pageCountOf = (n: NoteDocument) => (n.sheets?.length ? printedSheets(n).length : 1);

/** Long-press time of the "+" button (shows the import menu). */
const LONG_PRESS_MS = 450;

interface LibraryViewProps {
  notes: NoteDocument[];
  folders: Folder[];
  tags: Tag[];
  selectedFolderId: string | null;
  onSelectFolder: (folderId: string | null) => void;
  onOpenNote: (noteId: string) => void;
  onCreateNote: () => void;
  onDeleteNote: (noteId: string) => void;
  onDuplicateNote: (noteId: string) => void;
  onRenameNote: (noteId: string, newTitle: string) => void;
  onMoveNote: (noteId: string, folderId: string | undefined) => void;
  /** Changes a note's tags from its latest tags (quick successive changes all apply). */
  onSetNoteTags: (noteId: string, update: (tagIds: string[]) => string[]) => void;
  onCreateFolder: (name: string, parentId: string | undefined, color: string) => Promise<Folder>;
  onUpdateFolder: (folderId: string, patch: Partial<Pick<Folder, 'name' | 'color'>>) => void;
  onMoveFolder: (folderId: string, parentId: string | undefined) => void;
  onDeleteFolder: (folderId: string) => void;
  onCreateTag: (name: string, color: string) => Promise<Tag>;
  onUpdateTag: (tagId: string, patch: Partial<Omit<Tag, 'id'>>) => void;
  onDeleteTag: (tagId: string) => void;
  onOpenSettings: () => void;
  onImportFiles: (files: File[]) => void;
}

/** What the "Move to…" sheet is moving. */
type MoveTarget = { kind: 'note'; id: string } | { kind: 'folder'; id: string };

const MENU = 'absolute bg-white dark:bg-ui-raised border border-gray-200 dark:border-gray-700 rounded-xl shadow-xl py-1 z-50 text-sm';
const MENU_ITEM = 'w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-gray-100 dark:hover:bg-ui-high text-gray-700 dark:text-gray-200';

/** A date and time in full (day, month, year, hours, minutes), compact enough for the narrowest cards. */
const fullDate = (ms: number) => new Date(ms).toLocaleString([], { year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const pagesLabel = (n: number) => `${n} page${n === 1 ? '' : 's'}`;

/** A note's last edit and creation (date and time, each with its icon) and its number of pages. */
const NoteDates: React.FC<{ note: NoteDocument; className?: string; inline?: boolean }> = ({ note, className = '', inline }) => {
  const edited = (
    <span className="flex items-center gap-1 min-w-0" title="Last edited">
      <PencilLine className="w-3 h-3 flex-shrink-0" /> <span className="truncate">{fullDate(note.updatedAt)}</span>
    </span>
  );
  const created = (
    <span className="flex items-center gap-1 min-w-0" title="Created">
      <CalendarPlus className="w-3 h-3 flex-shrink-0" /> <span className="truncate">{fullDate(note.createdAt)}</span>
    </span>
  );
  const pages = <span>{pagesLabel(pageCountOf(note))}</span>;
  if (inline)
    return (
      <>
        {edited}
        {created}
        {pages}
      </>
    );
  return (
    <div className={`text-[11px] text-gray-400 space-y-0.5 whitespace-nowrap min-w-0 ${className}`}>
      {edited}
      {created}
      {pages}
    </div>
  );
};

/**
 * A menu shown next to the button that opened it, above everything (a portal on the page) and
 * always wholly on screen: below the button when it fits there, otherwise above, then clamped to
 * the window. A note's menu used to open inside its card, so on the first row it slid under the
 * top bar and "Rename" could not be reached. Scrolling or resizing closes it.
 */
const AnchoredMenu: React.FC<{ anchor: HTMLElement | null; width: number; onClose: () => void; children: React.ReactNode }> = ({ anchor, width, onClose, children }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!anchor || !el) return;
    const a = anchor.getBoundingClientRect();
    const h = el.offsetHeight, m = 8;
    const below = a.bottom + 4, above = a.top - 4 - h;
    let top = below + h <= window.innerHeight - m ? below : above >= m ? above : window.innerHeight - m - h;
    top = Math.max(m, Math.min(top, window.innerHeight - m - h));
    const left = Math.max(m, Math.min(a.right - width, window.innerWidth - m - width));
    setPos({ left, top });
  }, [anchor, width]);
  // Also within the safe area (notch, home indicator) and when the screen changes size.
  useOnScreen(ref, !!pos);
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [onClose]);
  return createPortal(
    <div
      ref={ref}
      data-on-screen
      className={MENU.replace('absolute', 'fixed').replace('z-50', 'z-[1000]')}
      style={{ width, left: pos?.left ?? -9999, top: pos?.top ?? 0, maxHeight: 'calc(100dvh - 16px)', overflowY: 'auto' }}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body
  );
};

function useNarrow(): boolean {
  const q = '(max-width: 767px)';
  const [narrow, setNarrow] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return narrow;
}

const TagChip: React.FC<{ tag: Tag; small?: boolean }> = ({ tag, small }) => (
  <span
    className={`inline-flex items-center gap-1 rounded-full font-semibold truncate max-w-[9rem] ${small ? 'text-[10px] px-1.5 py-px' : 'text-xs px-2 py-0.5'}`}
    style={{ backgroundColor: `${tag.color}22`, color: tag.color }}
  >
    <Hash className={small ? 'w-2.5 h-2.5' : 'w-3 h-3'} />
    {tag.name}
  </span>
);

export const LibraryView: React.FC<LibraryViewProps> = (p) => {
  const { notes, folders, tags, selectedFolderId } = p;
  const narrow = useNarrow();
  const [prefs, setPrefsState] = useState<LibraryPrefs>(loadLibraryPrefs);
  const setPrefs = (patch: Partial<LibraryPrefs>) =>
    setPrefsState((cur) => {
      const next = { ...cur, ...patch };
      saveLibraryPrefs(next);
      return next;
    });
  const collapsed = prefs.sidebarCollapsed;

  const [searchQuery, setSearchQuery] = useState('');
  const [menuNoteId, setMenuNoteId] = useState<string | null>(null);
  const [menuFolderId, setMenuFolderId] = useState<string | null>(null);
  const [menuTagId, setMenuTagId] = useState<string | null>(null);
  const [renamingNoteId, setRenamingNoteId] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renamingTagId, setRenamingTagId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  /** Where a new folder is being named: a folder id, 'root', or null. */
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [creatingTag, setCreatingTag] = useState(false);
  const [moveTarget, setMoveTarget] = useState<MoveTarget | null>(null);
  const [tagNoteId, setTagNoteId] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [fabMenu, setFabMenu] = useState(false);
  const [dropFolder, setDropFolder] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const press = useRef<{ timer: number; long: boolean } | null>(null);

  const folderIds = useMemo(() => new Set(folders.map((f) => f.id)), [folders]);
  const tagIds = useMemo(() => new Set(tags.map((t) => t.id)), [tags]);
  const tagById = useMemo(() => new Map(tags.map((t) => [t.id, t])), [tags]);
  const current = selectedFolderId && folderIds.has(selectedFolderId) ? selectedFolderId : null;

  /** Notes in each folder, nested folders included. */
  const folderCounts = useMemo(() => {
    const direct = new Map<string, number>();
    for (const n of notes) {
      const f = noteFolder(n, folderIds);
      if (f) direct.set(f, (direct.get(f) ?? 0) + 1);
    }
    const total = new Map<string, number>();
    for (const f of folders) {
      let c = 0;
      for (const id of folderAndDescendants(folders, f.id)) c += direct.get(id) ?? 0;
      total.set(f.id, c);
    }
    return total;
  }, [notes, folders, folderIds]);

  const q = searchQuery.trim().toLowerCase();
  const filterOn = tagFilterActive(prefs, tagIds);

  const visibleNotes = useMemo(() => {
    // A folder shows its own notes; a search inside a folder also looks in its subfolders.
    const scope = current ? (q ? folderAndDescendants(folders, current) : new Set([current])) : null;
    const list = notes.filter((n) => {
      if (scope && !scope.has(noteFolder(n, folderIds) ?? '')) return false;
      return matchesSearch(n, q) && passesTagFilter(n, prefs, tagIds);
    });
    return sortNotes(list, prefs.sort);
  }, [notes, folders, folderIds, current, q, prefs, tagIds]);

  const subfolders = useMemo(() => (current && !q ? sortFolders(childFolders(folders, current), prefs.sort) : []), [folders, current, q, prefs.sort]);
  const path = folderPath(folders, current);

  const closeMenus = () => {
    setMenuNoteId(null);
    setMenuFolderId(null);
    setMenuTagId(null);
    setFilterOpen(false);
    setFabMenu(false);
  };

  const selectFolder = (id: string | null) => {
    p.onSelectFolder(id);
    if (narrow) setPrefs({ sidebarCollapsed: true });
  };

  const toggleExpanded = (id: string, open?: boolean) => {
    const isOpen = prefs.expanded.includes(id);
    const want = open ?? !isOpen;
    if (want === isOpen) return;
    setPrefs({ expanded: want ? [...prefs.expanded, id] : prefs.expanded.filter((x) => x !== id) });
  };

  const startCreateFolder = (parent: string | null) => {
    setNameDraft('');
    setCreatingIn(parent ?? 'root');
    if (parent) toggleExpanded(parent, true);
    setMenuFolderId(null);
  };

  const commitCreateFolder = async () => {
    const name = nameDraft.trim();
    const parent = creatingIn === 'root' ? undefined : creatingIn ?? undefined;
    setCreatingIn(null);
    if (!name) return;
    await p.onCreateFolder(name, parent, FOLDER_COLORS[folders.length % FOLDER_COLORS.length]);
  };

  const commitRenameFolder = () => {
    if (renamingFolderId && nameDraft.trim()) p.onUpdateFolder(renamingFolderId, { name: nameDraft.trim() });
    setRenamingFolderId(null);
  };

  const commitCreateTag = async () => {
    const name = nameDraft.trim();
    setCreatingTag(false);
    if (name) await p.onCreateTag(name, TAG_COLORS[tags.length % TAG_COLORS.length]);
  };

  const commitRenameTag = () => {
    if (renamingTagId && nameDraft.trim()) p.onUpdateTag(renamingTagId, { name: nameDraft.trim() });
    setRenamingTagId(null);
  };

  const saveRename = (id: string) => {
    if (renameTitle.trim()) p.onRenameNote(id, renameTitle.trim());
    setRenamingNoteId(null);
  };

  const confirmDeleteNote = (n: NoteDocument) => {
    if (window.confirm(`Delete “${n.title}”? This cannot be undone.`)) p.onDeleteNote(n.id);
    setMenuNoteId(null);
  };

  const confirmDeleteFolder = (f: Folder) => {
    setMenuFolderId(null);
    const inside = folderCounts.get(f.id) ?? 0;
    const where = f.parentId ? `“${folders.find((x) => x.id === f.parentId)?.name ?? 'its parent'}”` : 'the top level';
    if (window.confirm(`Delete folder “${f.name}”?${inside || childFolders(folders, f.id).length ? ` Its notes and subfolders move to ${where}.` : ''}`)) p.onDeleteFolder(f.id);
  };

  /** Quick filter from the sidebar: tapping a tag adds it to (or removes it from) the whitelist. */
  const toggleSidebarTag = (id: string) => {
    const on = prefs.tagMode === 'whitelist' && prefs.whitelist.includes(id);
    const whitelist = on ? prefs.whitelist.filter((t) => t !== id) : [...prefs.whitelist.filter((t) => tagIds.has(t)), id];
    setPrefs({ tagMode: whitelist.length ? 'whitelist' : prefs.tagMode === 'whitelist' ? 'off' : prefs.tagMode, whitelist });
  };

  // --- "+" button: tap = new note, hold = import menu ------------------------------------------

  const fabDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const state = { long: false, timer: 0 };
    state.timer = window.setTimeout(() => {
      state.long = true;
      setFabMenu(true);
      navigator.vibrate?.(12);
    }, LONG_PRESS_MS);
    press.current = state;
  };
  const fabUp = () => {
    const st = press.current;
    press.current = null;
    if (!st) return;
    clearTimeout(st.timer);
    if (st.long) return;
    if (fabMenu) setFabMenu(false);
    else p.onCreateNote();
  };
  const fabCancel = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };

  // --- Drag & drop (mouse / trackpad): notes and folders onto folders --------------------------

  const dragProps = (kind: 'note' | 'folder', id: string) => ({
    draggable: !narrow,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData('application/x-opennote', JSON.stringify({ kind, id }));
      e.dataTransfer.effectAllowed = 'move';
    },
  });
  const dropProps = (folderId: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('application/x-opennote')) return;
      e.preventDefault();
      setDropFolder(folderId ?? 'root');
    },
    onDragLeave: () => setDropFolder((cur) => (cur === (folderId ?? 'root') ? null : cur)),
    onDrop: (e: React.DragEvent) => {
      setDropFolder(null);
      try {
        const d = JSON.parse(e.dataTransfer.getData('application/x-opennote')) as MoveTarget;
        e.preventDefault();
        if (d.kind === 'note') p.onMoveNote(d.id, folderId ?? undefined);
        else if (d.id !== folderId) p.onMoveFolder(d.id, folderId ?? undefined);
      } catch {
        /* not ours */
      }
    },
  });

  // --- Sidebar ----------------------------------------------------------------------------------

  const nameInput = (onCommit: () => void, onCancel: () => void, placeholder: string) => (
    <input
      autoFocus
      value={nameDraft}
      onChange={(e) => setNameDraft(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onCommit();
        if (e.key === 'Escape') onCancel();
      }}
      onClick={(e) => e.stopPropagation()}
      placeholder={placeholder}
      className="flex-1 min-w-0 text-sm px-2 py-1 bg-white dark:bg-ui-raised border border-blue-500 rounded-lg text-gray-900 dark:text-gray-100 focus:outline-none select-text"
    />
  );

  const FolderMenu: React.FC<{ f: Folder }> = ({ f }) => (
    <OnScreen className={`${MENU} right-1 top-8 w-48`} onClick={(e) => e.stopPropagation()}>
      <button className={MENU_ITEM} onClick={() => startCreateFolder(f.id)}><FolderPlus className="w-4 h-4" /> New subfolder</button>
      <button className={MENU_ITEM} onClick={() => { setNameDraft(f.name); setRenamingFolderId(f.id); setMenuFolderId(null); }}><Edit2 className="w-4 h-4" /> Rename</button>
      <button className={MENU_ITEM} onClick={() => { setMoveTarget({ kind: 'folder', id: f.id }); setMenuFolderId(null); }}><FolderInput className="w-4 h-4" /> Move to…</button>
      <div className="px-3 py-2 flex flex-wrap gap-1.5">
        {FOLDER_COLORS.map((c) => (
          <button key={c} onClick={() => { p.onUpdateFolder(f.id, { color: c }); setMenuFolderId(null); }} className={`w-5 h-5 rounded-full ${f.color === c ? 'ring-2 ring-offset-1 ring-blue-500 dark:ring-offset-ui-raised' : ''}`} style={{ backgroundColor: c }} title="Folder colour" />
        ))}
      </div>
      <button className={`${MENU_ITEM} !text-red-600`} onClick={() => confirmDeleteFolder(f)}><Trash2 className="w-4 h-4" /> Delete folder</button>
    </OnScreen>
  );

  const renderFolder = (f: Folder, depth: number): React.ReactNode => {
    const kids = sortFolders(childFolders(folders, f.id), 'title-asc');
    const open = prefs.expanded.includes(f.id);
    const active = current === f.id;
    return (
      <div key={f.id}>
        <div
          {...dragProps('folder', f.id)}
          {...dropProps(f.id)}
          className={`group relative flex items-center rounded-xl pr-1 ${active ? 'bg-white dark:bg-ui-raised shadow-sm' : 'hover:bg-gray-200/50 dark:hover:bg-white/5'} ${dropFolder === f.id ? 'ring-2 ring-blue-500' : ''}`}
          style={{ paddingLeft: 4 + depth * 14 }}
        >
          <button
            onClick={(e) => { e.stopPropagation(); toggleExpanded(f.id); }}
            className={`p-1 text-gray-400 ${kids.length || creatingIn === f.id ? '' : 'invisible'}`}
            aria-label={open ? 'Collapse' : 'Expand'}
          >
            {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>
          {renamingFolderId === f.id ? (
            <div className="flex-1 flex items-center gap-2 py-1 pr-1 min-w-0">
              <FolderIcon className="w-4 h-4 flex-shrink-0" style={{ color: f.color ?? FOLDER_COLORS[0] }} />
              {nameInput(commitRenameFolder, () => setRenamingFolderId(null), 'Folder name')}
            </div>
          ) : (
            <button onClick={() => selectFolder(f.id)} className={`flex-1 flex items-center gap-2 py-1.5 text-sm min-w-0 text-left ${active ? 'text-blue-600 dark:text-blue-400 font-semibold' : 'text-gray-700 dark:text-gray-300'}`}>
              <FolderIcon className="w-4 h-4 flex-shrink-0" style={{ color: f.color ?? FOLDER_COLORS[0] }} fill={f.color ?? FOLDER_COLORS[0]} fillOpacity={0.18} />
              <span className="truncate flex-1">{f.name}</span>
              <span className="text-xs text-gray-400 tabular-nums">{folderCounts.get(f.id) || ''}</span>
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); closeMenus(); setMenuFolderId(menuFolderId === f.id ? null : f.id); }}
            className={`p-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 rounded-md ${narrow || menuFolderId === f.id ? '' : 'opacity-0 group-hover:opacity-100'}`}
            title="Folder options"
          >
            <MoreVertical className="w-3.5 h-3.5" />
          </button>
          {menuFolderId === f.id && <FolderMenu f={f} />}
        </div>
        {open && (
          <div>
            {kids.map((k) => renderFolder(k, depth + 1))}
            {creatingIn === f.id && (
              <div className="flex items-center gap-2 py-1 pr-1" style={{ paddingLeft: 4 + (depth + 1) * 14 + 22 }}>
                <FolderIcon className="w-4 h-4 text-gray-400 flex-shrink-0" />
                {nameInput(commitCreateFolder, () => setCreatingIn(null), 'Folder name')}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const tagCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of notes) for (const t of n.tagIds ?? []) m.set(t, (m.get(t) ?? 0) + 1);
    return m;
  }, [notes]);

  const sectionHead = 'flex items-center justify-between px-2 mt-4 mb-1.5 text-[11px] font-bold text-gray-400 uppercase tracking-wider';

  const sidebar = (
    <aside className="w-72 h-full bg-ui-side border-r border-gray-300/70 dark:border-gray-800 flex flex-col" onClick={closeMenus}>
      {/* Room for the brand row (logo · name · version), which sits above the sidebar. */}
      <div className="flex-shrink-0 h-14 mt-[env(safe-area-inset-top)]" />
      <div className="px-3 flex-shrink-0">
        <div className="relative">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-2.5" />
          <input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="Search titles, text, LaTeX…" className="w-full bg-white dark:bg-ui-raised border border-gray-200 dark:border-gray-700 rounded-xl pl-9 pr-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 select-text" />
        </div>
        <button
          onClick={() => selectFolder(null)}
          {...dropProps(null)}
          className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-sm font-semibold mt-3 ${current === null ? 'bg-blue-600 text-white' : 'text-gray-700 dark:text-gray-300 hover:bg-gray-200/60 dark:hover:bg-white/5'} ${dropFolder === 'root' ? 'ring-2 ring-blue-500' : ''}`}
        >
          <span className="flex items-center gap-2.5"><BookOpen className="w-4 h-4" /> All notes</span>
          <span className="text-xs opacity-80">{notes.length}</span>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-20">
        <div className={sectionHead}>
          <span>Folders</span>
          <button onClick={(e) => { e.stopPropagation(); startCreateFolder(null); }} className="p-0.5 hover:text-blue-600" title="New folder"><FolderPlus className="w-4 h-4" /></button>
        </div>
        <div className="space-y-px">
          {sortFolders(childFolders(folders, undefined), 'title-asc').map((f) => renderFolder(f, 0))}
          {creatingIn === 'root' && (
            <div className="flex items-center gap-2 py-1 pl-7 pr-1">
              <FolderIcon className="w-4 h-4 text-gray-400 flex-shrink-0" />
              {nameInput(commitCreateFolder, () => setCreatingIn(null), 'Folder name')}
            </div>
          )}
          {!folders.length && creatingIn !== 'root' && (
            <button onClick={(e) => { e.stopPropagation(); startCreateFolder(null); }} className="w-full text-left px-3 py-2 text-xs text-gray-400 hover:text-blue-600">+ Create a folder</button>
          )}
        </div>

        <div className={sectionHead}>
          <span>Tags</span>
          <button onClick={(e) => { e.stopPropagation(); setNameDraft(''); setCreatingTag(true); }} className="p-0.5 hover:text-blue-600" title="New tag"><Plus className="w-4 h-4" /></button>
        </div>
        <div className="space-y-px">
          {tags.map((t) => {
            const inFilter = prefs.tagMode === 'whitelist' ? prefs.whitelist.includes(t.id) : prefs.tagMode === 'blacklist' ? prefs.blacklist.includes(t.id) : false;
            return (
              <div key={t.id} className={`group relative flex items-center rounded-xl pr-1 ${inFilter ? 'bg-white dark:bg-ui-raised shadow-sm' : 'hover:bg-gray-200/50 dark:hover:bg-white/5'}`}>
                {renamingTagId === t.id ? (
                  <div className="flex-1 flex items-center gap-2 px-3 py-1 min-w-0">
                    <Hash className="w-4 h-4 flex-shrink-0" style={{ color: t.color }} />
                    {nameInput(commitRenameTag, () => setRenamingTagId(null), 'Tag name')}
                  </div>
                ) : (
                  <button onClick={() => toggleSidebarTag(t.id)} className="flex-1 flex items-center gap-2 px-3 py-1.5 text-sm min-w-0 text-left text-gray-700 dark:text-gray-300" title={prefs.tagMode === 'blacklist' ? 'Hidden by the blacklist' : 'Show only notes with this tag'}>
                    <Hash className="w-4 h-4 flex-shrink-0" style={{ color: t.color }} />
                    <span className={`truncate flex-1 ${inFilter && prefs.tagMode === 'blacklist' ? 'line-through opacity-70' : ''}`}>{t.name}</span>
                    {inFilter && <Check className="w-3.5 h-3.5 text-blue-600" />}
                    <span className="text-xs text-gray-400 tabular-nums">{tagCounts.get(t.id) || ''}</span>
                  </button>
                )}
                <button onClick={(e) => { e.stopPropagation(); closeMenus(); setMenuTagId(menuTagId === t.id ? null : t.id); }} className={`p-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 rounded-md ${narrow || menuTagId === t.id ? '' : 'opacity-0 group-hover:opacity-100'}`} title="Tag options">
                  <MoreVertical className="w-3.5 h-3.5" />
                </button>
                {menuTagId === t.id && (
                  <OnScreen className={`${MENU} right-1 top-8 w-44`} onClick={(e) => e.stopPropagation()}>
                    <button className={MENU_ITEM} onClick={() => { setNameDraft(t.name); setRenamingTagId(t.id); setMenuTagId(null); }}><Edit2 className="w-4 h-4" /> Rename</button>
                    <div className="px-3 py-2 flex flex-wrap gap-1.5">
                      {TAG_COLORS.map((c) => (
                        <button key={c} onClick={() => { p.onUpdateTag(t.id, { color: c }); setMenuTagId(null); }} className={`w-5 h-5 rounded-full ${t.color === c ? 'ring-2 ring-offset-1 ring-blue-500 dark:ring-offset-ui-raised' : ''}`} style={{ backgroundColor: c }} title="Tag colour" />
                      ))}
                    </div>
                    <button className={`${MENU_ITEM} !text-red-600`} onClick={() => { setMenuTagId(null); if (window.confirm(`Delete tag “${t.name}”? It is removed from ${tagCounts.get(t.id) ?? 0} note(s).`)) p.onDeleteTag(t.id); }}><Trash2 className="w-4 h-4" /> Delete tag</button>
                  </OnScreen>
                )}
              </div>
            );
          })}
          {creatingTag && (
            <div className="flex items-center gap-2 px-3 py-1">
              <Hash className="w-4 h-4 text-gray-400 flex-shrink-0" />
              {nameInput(commitCreateTag, () => setCreatingTag(false), 'Tag name')}
            </div>
          )}
          {!tags.length && !creatingTag && (
            <button onClick={(e) => { e.stopPropagation(); setNameDraft(''); setCreatingTag(true); }} className="w-full text-left px-3 py-2 text-xs text-gray-400 hover:text-blue-600">+ Create a tag</button>
          )}
        </div>
      </div>
    </aside>
  );

  // --- Notes --------------------------------------------------------------------------------------

  const NoteMenu: React.FC<{ note: NoteDocument; anchor: HTMLElement | null }> = ({ note, anchor }) => (
    <AnchoredMenu anchor={anchor} width={176} onClose={() => setMenuNoteId(null)}>
      <button onClick={() => { setRenamingNoteId(note.id); setRenameTitle(note.title); setMenuNoteId(null); }} className={MENU_ITEM}><Edit2 className="w-4 h-4" /> Rename</button>
      <button onClick={() => { setMoveTarget({ kind: 'note', id: note.id }); setMenuNoteId(null); }} className={MENU_ITEM}><FolderInput className="w-4 h-4" /> Move to…</button>
      <button onClick={() => { setTagNoteId(note.id); setMenuNoteId(null); }} className={MENU_ITEM}><TagIcon className="w-4 h-4" /> Tags…</button>
      <button onClick={() => { p.onDuplicateNote(note.id); setMenuNoteId(null); }} className={MENU_ITEM}><Copy className="w-4 h-4" /> Duplicate</button>
      <button onClick={() => confirmDeleteNote(note)} className={`${MENU_ITEM} !text-red-600`}><Trash2 className="w-4 h-4" /> Delete</button>
    </AnchoredMenu>
  );

  const noteTags = (n: NoteDocument) => (n.tagIds ?? []).map((id) => tagById.get(id)).filter((t): t is Tag => !!t);

  const titleOrRename = (note: NoteDocument) =>
    renamingNoteId === note.id ? (
      <input autoFocus value={renameTitle} onChange={(e) => setRenameTitle(e.target.value)} onBlur={() => saveRename(note.id)} onKeyDown={(e) => e.key === 'Enter' && saveRename(note.id)} onClick={(e) => e.stopPropagation()} className="w-full text-sm font-semibold p-1 bg-white dark:bg-ui-high border border-blue-500 rounded select-text" />
    ) : (
      <div className="font-semibold text-sm truncate">{note.title}</div>
    );

  const menuAnchors = useRef(new Map<string, HTMLButtonElement>());
  const menuButton = (note: NoteDocument) => (
    <div className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        ref={(el) => {
          if (el) menuAnchors.current.set(note.id, el);
          else menuAnchors.current.delete(note.id);
        }}
        onClick={() => { closeMenus(); setMenuNoteId(menuNoteId === note.id ? null : note.id); }}
        className="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 rounded-lg"
      >
        <MoreVertical className="w-4 h-4" />
      </button>
      {menuNoteId === note.id && <NoteMenu note={note} anchor={menuAnchors.current.get(note.id) ?? null} />}
    </div>
  );

  const folderOfNote = (n: NoteDocument) => {
    const id = noteFolder(n, folderIds);
    return id ? folders.find((f) => f.id === id) : undefined;
  };

  const emptyText = filterOn ? 'No notes match the tag filter.' : q ? 'Nothing matches the search.' : current ? 'This folder is empty.' : 'No notes yet.';

  const content =
    visibleNotes.length === 0 && subfolders.length === 0 ? (
      <div className="h-full flex flex-col items-center justify-center text-gray-400 text-center px-6">
        <FileText className="w-12 h-12 stroke-[1.2] mb-3 text-gray-300 dark:text-gray-600" />
        <div className="font-semibold text-sm">{emptyText}</div>
        <p className="text-xs mt-1">Tap + to start writing, or hold it to import a file.</p>
      </div>
    ) : (
      <>
        {subfolders.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 sm:gap-4 mb-5">
            {subfolders.map((f) => (
              <div
                key={f.id}
                {...dragProps('folder', f.id)}
                {...dropProps(f.id)}
                onClick={() => p.onSelectFolder(f.id)}
                className={`group relative flex items-center gap-3 px-3.5 py-3 rounded-2xl bg-ui-card border border-gray-200 dark:border-gray-700/60 cursor-pointer hover:shadow-md transition ${dropFolder === f.id ? 'ring-2 ring-blue-500' : ''}`}
              >
                <FolderIcon className="w-7 h-7 flex-shrink-0" style={{ color: f.color ?? FOLDER_COLORS[0] }} fill={f.color ?? FOLDER_COLORS[0]} fillOpacity={0.2} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold truncate">{f.name}</div>
                  <div className="text-[11px] text-gray-400">{folderCounts.get(f.id) ?? 0} notes</div>
                </div>
              </div>
            ))}
          </div>
        )}
        {prefs.viewMode === 'grid' ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 sm:gap-5">
            {visibleNotes.map((note) => {
              const folder = !current ? folderOfNote(note) : undefined;
              const nt = noteTags(note);
              return (
                <div key={note.id} {...dragProps('note', note.id)} onClick={() => p.onOpenNote(note.id)} className="relative bg-ui-card border border-gray-200 dark:border-gray-700/60 rounded-2xl hover:shadow-lg transition cursor-pointer flex flex-col">
                  <div className="rounded-t-2xl overflow-hidden border-b border-gray-100 dark:border-gray-800 relative">
                    <NoteThumb note={note} />
                    {folder && (
                      <span className="absolute top-2 left-2 flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full text-white max-w-[80%] truncate" style={{ backgroundColor: folder.color ?? FOLDER_COLORS[0] }}>
                        <FolderIcon className="w-2.5 h-2.5 flex-shrink-0" /> {folder.name}
                      </span>
                    )}
                  </div>
                  <div className="p-2.5 sm:p-3">
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0 mr-1">{titleOrRename(note)}</div>
                      {menuButton(note)}
                    </div>
                    {/* The full width of the card: the dates and times are not cut off. */}
                    <NoteDates note={note} />
                    {nt.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {nt.slice(0, 3).map((t) => <TagChip key={t.id} tag={t} small />)}
                        {nt.length > 3 && <span className="text-[10px] text-gray-400">+{nt.length - 3}</span>}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {visibleNotes.map((note) => {
              const folder = !current ? folderOfNote(note) : undefined;
              const nt = noteTags(note);
              return (
                <div key={note.id} {...dragProps('note', note.id)} onClick={() => p.onOpenNote(note.id)} className="py-3 px-3 flex items-center justify-between gap-2 hover:bg-gray-50 dark:hover:bg-ui-raised rounded-xl cursor-pointer">
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <FileText className="w-5 h-5 text-blue-600 flex-shrink-0" />
                    <div className="min-w-0 flex-1">
                      {titleOrRename(note)}
                      <div className="text-[11px] text-gray-400 flex items-center gap-1.5 flex-wrap">
                        <NoteDates note={note} inline />
                        {folder && <span className="flex items-center gap-1"><FolderIcon className="w-3 h-3" style={{ color: folder.color }} />{folder.name}</span>}
                        {nt.map((t) => <TagChip key={t.id} tag={t} small />)}
                      </div>
                    </div>
                  </div>
                  {menuButton(note)}
                </div>
              );
            })}
          </div>
        )}
      </>
    );

  // --- Filter & sort menu -------------------------------------------------------------------------

  const modeList = prefs.tagMode === 'blacklist' ? prefs.blacklist : prefs.whitelist;
  const toggleInMode = (id: string) => {
    const key = prefs.tagMode === 'blacklist' ? 'blacklist' : 'whitelist';
    const list = prefs[key];
    setPrefs({ [key]: list.includes(id) ? list.filter((t) => t !== id) : [...list, id] });
  };

  const filterMenu = (
    <OnScreen className={`${MENU} right-0 top-11 w-[19rem] max-w-[calc(100vw-1.5rem)] py-2 max-h-[calc(100dvh-7rem)] overflow-y-auto`} onClick={(e) => e.stopPropagation()}>
      <div className="px-3 pb-1 text-[11px] font-bold text-gray-400 uppercase tracking-wider">Sort by</div>
      {['Last modified', 'Created', 'Title'].map((group) => (
        <div key={group} className="px-3 py-1 flex items-center gap-2">
          <span className="text-xs text-gray-500 dark:text-gray-400 w-24 flex-shrink-0">{group}</span>
          <div className="flex-1 flex bg-gray-100 dark:bg-ui-high rounded-lg p-0.5">
            {SORT_OPTIONS.filter((o) => o.group === group).map((o) => (
              <button key={o.id} onClick={() => setPrefs({ sort: o.id })} className={`flex-1 px-1.5 py-1 rounded-md text-[11px] font-semibold whitespace-nowrap ${prefs.sort === o.id ? 'bg-white dark:bg-ui-raised text-blue-600 dark:text-blue-400 shadow-sm' : 'text-gray-500 dark:text-gray-400'}`}>
                {o.label}
              </button>
            ))}
          </div>
        </div>
      ))}

      <div className="border-t border-gray-100 dark:border-gray-700 mt-2 pt-2 px-3 pb-1 text-[11px] font-bold text-gray-400 uppercase tracking-wider flex items-center justify-between">
        <span>Filter by tag</span>
        {filterOn && <button onClick={() => setPrefs({ tagMode: 'off' })} className="normal-case tracking-normal font-semibold text-blue-600 dark:text-blue-400">Turn off</button>}
      </div>
      <div className="px-3 py-1">
        <div className="flex bg-gray-100 dark:bg-ui-high rounded-lg p-0.5">
          {([['off', 'Off'], ['whitelist', 'Only with'], ['blacklist', 'Hide with']] as [TagMode, string][]).map(([m, l]) => (
            <button key={m} onClick={() => setPrefs({ tagMode: m })} className={`flex-1 px-2 py-1 rounded-md text-xs font-semibold ${prefs.tagMode === m ? 'bg-white dark:bg-ui-raised text-blue-600 dark:text-blue-400 shadow-sm' : 'text-gray-500 dark:text-gray-400'}`}>
              {l}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-gray-400 mt-1.5">
          {prefs.tagMode === 'off' && 'Every note in this view is shown.'}
          {prefs.tagMode === 'whitelist' && 'Whitelist: only notes with the selected tags are shown.'}
          {prefs.tagMode === 'blacklist' && 'Blacklist: notes with any selected tag are hidden.'}
        </p>
      </div>
      {prefs.tagMode !== 'off' && (
        <div className="px-1.5 pt-1">
          {tags.length === 0 && <p className="px-1.5 py-2 text-xs text-gray-400">No tags yet. Create them in the sidebar or from a note's ⋯ menu.</p>}
          {tags.map((t) => {
            const on = modeList.includes(t.id);
            return (
              <button key={t.id} onClick={() => toggleInMode(t.id)} className="w-full flex items-center gap-2 px-1.5 py-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-ui-high text-sm text-gray-700 dark:text-gray-200">
                <span className={`w-4 h-4 rounded flex items-center justify-center border ${on ? (prefs.tagMode === 'blacklist' ? 'bg-red-500 border-red-500' : 'bg-blue-600 border-blue-600') : 'border-gray-300 dark:border-gray-600'}`}>
                  {on && (prefs.tagMode === 'blacklist' ? <X className="w-3 h-3 text-white" /> : <Check className="w-3 h-3 text-white" />)}
                </span>
                <Hash className="w-3.5 h-3.5" style={{ color: t.color }} />
                <span className="flex-1 text-left truncate">{t.name}</span>
                <span className="text-xs text-gray-400">{tagCounts.get(t.id) ?? 0}</span>
              </button>
            );
          })}
          {prefs.tagMode === 'whitelist' && modeList.filter((t) => tagIds.has(t)).length > 1 && (
            <div className="flex items-center gap-2 px-1.5 pt-2 text-xs text-gray-500 dark:text-gray-400">
              <span>Notes need</span>
              <div className="flex bg-gray-100 dark:bg-ui-high rounded-lg p-0.5">
                {[false, true].map((all) => (
                  <button key={String(all)} onClick={() => setPrefs({ matchAll: all })} className={`px-2 py-0.5 rounded-md font-semibold ${prefs.matchAll === all ? 'bg-white dark:bg-ui-raised text-blue-600 dark:text-blue-400 shadow-sm' : ''}`}>
                    {all ? 'all tags' : 'any tag'}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </OnScreen>
  );

  // --- Sheets: move & tags ------------------------------------------------------------------------

  const moveSheet = moveTarget && (() => {
    const banned = moveTarget.kind === 'folder' ? folderAndDescendants(folders, moveTarget.id) : new Set<string>();
    const currentParent =
      moveTarget.kind === 'note'
        ? noteFolder(notes.find((n) => n.id === moveTarget.id)!, folderIds)
        : folders.find((f) => f.id === moveTarget.id)?.parentId;
    const name = moveTarget.kind === 'note' ? notes.find((n) => n.id === moveTarget.id)?.title : folders.find((f) => f.id === moveTarget.id)?.name;
    const pick = (dest: string | undefined) => {
      if (moveTarget.kind === 'note') p.onMoveNote(moveTarget.id, dest);
      else p.onMoveFolder(moveTarget.id, dest);
      setMoveTarget(null);
    };
    const row = (f: Folder, depth: number): React.ReactNode => {
      const disabled = banned.has(f.id);
      return (
        <React.Fragment key={f.id}>
          <button disabled={disabled} onClick={() => pick(f.id)} className={`w-full flex items-center gap-2 py-2 pr-3 rounded-lg text-sm text-left ${disabled ? 'opacity-35' : 'hover:bg-gray-100 dark:hover:bg-ui-raised'} ${currentParent === f.id ? 'font-semibold text-blue-600 dark:text-blue-400' : 'text-gray-700 dark:text-gray-200'}`} style={{ paddingLeft: 12 + depth * 18 }}>
            <FolderIcon className="w-4 h-4 flex-shrink-0" style={{ color: f.color ?? FOLDER_COLORS[0] }} />
            <span className="truncate flex-1">{f.name}</span>
            {currentParent === f.id && <Check className="w-4 h-4" />}
          </button>
          {!disabled && sortFolders(childFolders(folders, f.id), 'title-asc').map((k) => row(k, depth + 1))}
        </React.Fragment>
      );
    };
    return (
      <Sheet title={`Move “${name ?? ''}”`} onClose={() => setMoveTarget(null)}>
        <button onClick={() => pick(undefined)} className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm hover:bg-gray-100 dark:hover:bg-ui-raised ${currentParent === undefined ? 'font-semibold text-blue-600 dark:text-blue-400' : 'text-gray-700 dark:text-gray-200'}`}>
          <BookOpen className="w-4 h-4" /> <span className="flex-1 text-left">Library (no folder)</span>
          {currentParent === undefined && <Check className="w-4 h-4" />}
        </button>
        {sortFolders(childFolders(folders, undefined), 'title-asc').map((f) => row(f, 0))}
      </Sheet>
    );
  })();

  const tagNote = tagNoteId ? notes.find((n) => n.id === tagNoteId) : undefined;
  const [newTagName, setNewTagName] = useState('');
  const tagSheet = tagNote && (
    <Sheet title={`Tags of “${tagNote.title}”`} onClose={() => { setTagNoteId(null); setNewTagName(''); }}>
      {tags.length === 0 && <p className="px-3 py-2 text-xs text-gray-400">No tags yet: create one below.</p>}
      {tags.map((t) => {
        const own = tagNote.tagIds ?? [];
        const on = own.includes(t.id);
        return (
          <button key={t.id} onClick={() => p.onSetNoteTags(tagNote.id, (cur) => (on ? cur.filter((x) => x !== t.id) : cur.includes(t.id) ? cur : [...cur, t.id]))} className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-gray-100 dark:hover:bg-ui-raised text-sm text-gray-700 dark:text-gray-200">
            <span className={`w-4 h-4 rounded flex items-center justify-center border ${on ? 'bg-blue-600 border-blue-600' : 'border-gray-300 dark:border-gray-600'}`}>{on && <Check className="w-3 h-3 text-white" />}</span>
            <TagChip tag={t} />
          </button>
        );
      })}
      <form
        className="flex items-center gap-2 px-3 pt-3 mt-2 border-t border-gray-100 dark:border-gray-800"
        onSubmit={async (e) => {
          e.preventDefault();
          const name = newTagName.trim();
          if (!name) return;
          const existing = tags.find((t) => t.name.toLowerCase() === name.toLowerCase());
          const t = existing ?? (await p.onCreateTag(name, TAG_COLORS[tags.length % TAG_COLORS.length]));
          p.onSetNoteTags(tagNote.id, (cur) => (cur.includes(t.id) ? cur : [...cur, t.id]));
          setNewTagName('');
        }}
      >
        <Hash className="w-4 h-4 text-gray-400" />
        <input value={newTagName} onChange={(e) => setNewTagName(e.target.value)} placeholder="New tag" className="flex-1 min-w-0 text-sm px-2 py-1.5 bg-gray-50 dark:bg-ui-raised border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 select-text" />
        <button type="submit" className="px-3 py-1.5 bg-blue-600 text-white text-sm font-semibold rounded-lg">Add</button>
      </form>
    </Sheet>
  );

  // --- Layout -------------------------------------------------------------------------------------

  const viewTitle = current ? path[path.length - 1]?.name ?? 'Folder' : 'All notes';
  const sidebarShown = !collapsed;

  return (
    <div className="relative h-full flex bg-ui-app text-gray-900 dark:text-gray-100 select-none overflow-hidden" onClick={closeMenus}>
      {/* Brand row: the logo toggles the sidebar and stays visible when the sidebar is closed. */}
      {/* The logo is centred in a header-high square (3.5rem) at the left edge, open or closed. */}
      <div className={`absolute left-0 top-0 z-50 flex items-center pt-[env(safe-area-inset-top)] h-[calc(3.5rem+env(safe-area-inset-top))] ${sidebarShown ? 'w-72' : ''}`}>
        <div className="w-14 h-14 flex-shrink-0 flex items-center justify-center">
          <button
            onClick={(e) => { e.stopPropagation(); setPrefs({ sidebarCollapsed: !collapsed }); }}
            className="flex rounded-xl active:scale-95 transition shadow-sm"
            title={collapsed ? 'Show the sidebar' : 'Hide the sidebar'}
            aria-expanded={!collapsed}
          >
            <Logo size={34} />
          </button>
        </div>
        {sidebarShown && (
          <div className="flex items-baseline gap-1.5 min-w-0">
            <span className="font-bold text-lg text-gray-900 dark:text-gray-100">OpenNote</span>
            <span className="text-[11px] font-semibold text-gray-400 tabular-nums">v{__APP_VERSION__}</span>
          </div>
        )}
      </div>

      {/* Sidebar: pushes the content on wide screens, slides over it on phones. */}
      {narrow ? (
        sidebarShown && (
          <div className="fixed inset-0 z-40 flex" onClick={() => setPrefs({ sidebarCollapsed: true })}>
            <div onClick={(e) => e.stopPropagation()} className="shadow-2xl h-full">{sidebar}</div>
            <div className="flex-1 bg-black/30" />
          </div>
        )
      ) : (
        <div className={`flex-shrink-0 h-full overflow-hidden transition-[width] duration-200 ease-out ${sidebarShown ? 'w-72' : 'w-0'}`}>{sidebar}</div>
      )}

      <main className="flex-1 min-w-0 flex flex-col overflow-hidden bg-white dark:bg-ui-panel">
        <header className={`border-b border-gray-200 dark:border-gray-800 flex items-center justify-between gap-2 pr-3 sm:pr-6 flex-shrink-0 pt-[env(safe-area-inset-top)] h-[calc(3.5rem+env(safe-area-inset-top))] ${!sidebarShown || narrow ? 'pl-[3.75rem]' : 'pl-4 sm:pl-6'}`}>
          <div className="flex items-center gap-2 min-w-0">
            {path.length > 1 && (
              <div className="hidden sm:flex items-center gap-1 text-sm text-gray-400 min-w-0">
                {path.slice(0, -1).map((f) => (
                  <React.Fragment key={f.id}>
                    <button onClick={() => p.onSelectFolder(f.id)} className="hover:text-blue-600 truncate max-w-[8rem]">{f.name}</button>
                    <ChevronRight className="w-3.5 h-3.5 flex-shrink-0" />
                  </React.Fragment>
                ))}
              </div>
            )}
            <h1 className="text-lg sm:text-xl font-bold truncate">{viewTitle}</h1>
            <span className="text-xs font-semibold bg-gray-100 dark:bg-ui-raised text-gray-500 px-2 py-0.5 rounded-full">{visibleNotes.length}</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="hidden sm:flex items-center bg-gray-100 dark:bg-ui-raised p-1 rounded-xl">
              <button onClick={() => setPrefs({ viewMode: 'grid' })} className={`p-1.5 rounded-lg ${prefs.viewMode === 'grid' ? 'bg-white dark:bg-ui-high text-blue-600 shadow-sm' : 'text-gray-400'}`} title="Grid"><GridIcon className="w-4 h-4" /></button>
              <button onClick={() => setPrefs({ viewMode: 'list' })} className={`p-1.5 rounded-lg ${prefs.viewMode === 'list' ? 'bg-white dark:bg-ui-high text-blue-600 shadow-sm' : 'text-gray-400'}`} title="List"><ListIcon className="w-4 h-4" /></button>
            </div>
            <div className="relative" onClick={(e) => e.stopPropagation()}>
              <button
                onClick={() => { const open = !filterOpen; closeMenus(); setFilterOpen(open); }}
                className={`relative flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold ${filterOpen || filterOn ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400' : 'bg-gray-100 dark:bg-ui-raised text-gray-600 dark:text-gray-300'}`}
                title="Sort and filter"
              >
                <SlidersHorizontal className="w-4 h-4" />
                <span className="hidden sm:inline">{filterOn ? (prefs.tagMode === 'whitelist' ? 'Only tagged' : 'Hiding tags') : 'Sort & filter'}</span>
                {filterOn && <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-blue-600 ring-2 ring-white dark:ring-ui-panel" />}
              </button>
              {filterOpen && filterMenu}
            </div>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-3 sm:p-6 pb-28" style={{ touchAction: 'pan-y' }}>
          {content}
        </div>
      </main>

      {/* Settings: fixed in the bottom-left corner, also when the sidebar is closed. */}
      <button
        onClick={(e) => { e.stopPropagation(); p.onOpenSettings(); }}
        className={`absolute z-50 left-3 bottom-[calc(0.75rem+env(safe-area-inset-bottom))] flex items-center gap-2 h-11 rounded-2xl text-sm font-semibold text-gray-600 dark:text-gray-300 bg-white/90 dark:bg-ui-raised/90 backdrop-blur border border-gray-200 dark:border-gray-700 shadow-md active:scale-95 transition ${sidebarShown ? 'px-3.5' : 'w-11 justify-center'}`}
        title="Settings"
      >
        <SettingsIcon className="w-5 h-5" />
        {sidebarShown && <span>Settings</span>}
      </button>

      {/* "+": tap for a new note, hold (or right-click) to import files or make a folder (a tap
          already makes a note: the menu has no "New note"). */}
      <div className="absolute z-40 right-5 bottom-[calc(1.25rem+env(safe-area-inset-bottom))] flex flex-col items-end gap-2" onClick={(e) => e.stopPropagation()}>
        {fabMenu && (
          // Above the + button (it was given `static` too: `absolute` won, with no offsets, so the
          // menu hung from the button's top edge, mostly below the screen's bottom on a phone).
          <OnScreen className={`${MENU} bottom-full right-0 mb-2 w-56 max-h-[calc(100dvh-6rem-env(safe-area-inset-bottom))] overflow-y-auto`}>
            <button className={MENU_ITEM} onClick={() => { setFabMenu(false); importRef.current?.click(); }}>
              <Upload className="w-4 h-4" />
              <span className="flex-1">
                Import file…
                <span className="block text-[11px] text-gray-400 font-normal">.opennote, images, .txt / .md / .tex</span>
              </span>
            </button>
            <button className={MENU_ITEM} onClick={() => { setFabMenu(false); startCreateFolder(current); if (collapsed) setPrefs({ sidebarCollapsed: false }); }}>
              <FolderPlus className="w-4 h-4" /> New folder{current ? ' here' : ''}
            </button>
          </OnScreen>
        )}
        <button
          onPointerDown={fabDown}
          onPointerUp={fabUp}
          onPointerLeave={fabCancel}
          onPointerCancel={fabCancel}
          onContextMenu={(e) => { e.preventDefault(); fabCancel(); setFabMenu(true); }}
          className={`w-14 h-14 rounded-full bg-gradient-to-br from-blue-500 to-violet-700 text-white shadow-xl shadow-blue-600/30 flex items-center justify-center active:scale-95 transition ${fabMenu ? 'rotate-45' : ''}`}
          title="New note (hold to import a file)"
          aria-label="New note"
        >
          <Plus className="w-7 h-7" strokeWidth={2.4} />
        </button>
        <input
          ref={importRef}
          type="file"
          multiple
          accept=".opennote,.note,.json,application/json,application/zip,image/*,.txt,.md,.tex,text/plain,text/markdown"
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            if (files.length) p.onImportFiles(files);
          }}
        />
      </div>

      {moveSheet}
      {tagSheet}
    </div>
  );
};

/** A small modal sheet (bottom sheet on phones). */
const Sheet: React.FC<{ title: string; onClose: () => void; children: React.ReactNode }> = ({ title, onClose, children }) => (
  <div className="fixed inset-0 z-[60] bg-black/40 backdrop-blur-sm flex items-end sm:items-center justify-center sm:p-4" onClick={(e) => { e.stopPropagation(); onClose(); }}>
    <div className="bg-white dark:bg-ui-panel w-full sm:max-w-sm rounded-t-3xl sm:rounded-3xl shadow-2xl border border-gray-200 dark:border-gray-800 max-h-[calc(100dvh-16px)] flex flex-col pb-[env(safe-area-inset-bottom)]" onClick={(e) => e.stopPropagation()}>
      <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between gap-2">
        <h3 className="font-bold text-sm truncate">{title}</h3>
        <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600 rounded-full"><X className="w-5 h-5" /></button>
      </div>
      <div className="p-2 overflow-y-auto">{children}</div>
    </div>
  </div>
);
