import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  FileText,
  Plus,
  Search,
  MoreVertical,
  Trash2,
  Edit2,
  BookOpen,
  Settings as SettingsIcon,
  Grid as GridIcon,
  List as ListIcon,
  Copy,
  FolderInput,
  Upload,
  Folder as FolderIcon,
  FolderPlus,
  ChevronRight,
  ChevronDown,
  Tag as TagIcon,
  SlidersHorizontal,
  Check,
  X,
  Hash,
  PencilLine,
  CalendarPlus,
  Sparkles,
} from 'lucide-react';
import { Folder, NoteDocument, Tag } from '../../types';
import { NoteThumb } from '../NoteThumb';
import { OnScreen, useOnScreen } from '../onScreen';
import { Logo } from '../Logo';
import { printedSheets } from '../../editor/sheets';
import {
  FOLDER_COLORS,
  LibraryPrefs,
  SORT_OPTIONS,
  TAG_COLORS,
  TagMode,
  childFolders,
  folderAndDescendants,
  folderPath,
  loadLibraryPrefs,
  matchesSearch,
  noteFolder,
  passesTagFilter,
  saveLibraryPrefs,
  sortFolders,
  sortNotes,
  tagFilterActive,
} from '../../library';
import { useBack } from '../../services/backStack';
import { StudioButton } from './StudioButton';
import { StudioPopover } from './StudioPopover';
import { StudioSheet } from './StudioSheet';

const pageCountOf = (n: NoteDocument) => (n.sheets?.length ? printedSheets(n).length : 1);
const LONG_PRESS_MS = 450;

export interface LibraryStudioProps {
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

type MoveTarget = { kind: 'note'; id: string } | { kind: 'folder'; id: string };

const fullDate = (ms: number) =>
  new Date(ms).toLocaleString([], {
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

const AnchoredMenu: React.FC<{
  anchor: HTMLElement | null;
  width: number;
  onClose: () => void;
  children: React.ReactNode;
}> = ({ anchor, width, onClose, children }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!anchor || !el) return;
    const a = anchor.getBoundingClientRect();
    const h = el.offsetHeight;
    const m = 8;
    const below = a.bottom + 4;
    const above = a.top - 4 - h;
    let top = below + h <= window.innerHeight - m ? below : above >= m ? above : window.innerHeight - m - h;
    top = Math.max(m, Math.min(top, window.innerHeight - m - h));
    const left = Math.max(m, Math.min(a.right - width, window.innerWidth - m - width));
    setPos({ left, top });
  }, [anchor, width]);

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
      className="fixed z-[1000] studio-glass-dock rounded-2xl p-1.5 shadow-2xl text-xs text-white"
      style={{
        width,
        left: pos?.left ?? -9999,
        top: pos?.top ?? 0,
        maxHeight: 'calc(100dvh - 16px)',
        overflowY: 'auto',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body
  );
};

function useNarrow(): boolean {
  const q = '(max-width: 767px)';
  const [narrow, setNarrow] = useState(() => (typeof window !== 'undefined' ? window.matchMedia(q).matches : false));
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return narrow;
}

export const LibraryStudio: React.FC<LibraryStudioProps> = (p) => {
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

  const tagCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of notes) for (const t of n.tagIds ?? []) m.set(t, (m.get(t) ?? 0) + 1);
    return m;
  }, [notes]);

  const q = searchQuery.trim().toLowerCase();
  const filterOn = tagFilterActive(prefs, tagIds);

  const visibleNotes = useMemo(() => {
    const scope = current ? (q ? folderAndDescendants(folders, current) : new Set([current])) : null;
    const list = notes.filter((n) => {
      if (scope && !scope.has(noteFolder(n, folderIds) ?? '')) return false;
      return matchesSearch(n, q) && passesTagFilter(n, prefs, tagIds);
    });
    return sortNotes(list, prefs.sort);
  }, [notes, folders, folderIds, current, q, prefs, tagIds]);

  const subfolders = useMemo(
    () => (current && !q ? sortFolders(childFolders(folders, current), prefs.sort) : []),
    [folders, current, q, prefs.sort]
  );
  const path = folderPath(folders, current);

  const closeMenus = () => {
    setMenuNoteId(null);
    setMenuFolderId(null);
    setMenuTagId(null);
    setFilterOpen(false);
    setFabMenu(false);
  };

  useBack(narrow && !prefs.sidebarCollapsed, () => setPrefs({ sidebarCollapsed: true }));
  useBack(!!(menuNoteId || menuFolderId || menuTagId || filterOpen || fabMenu), closeMenus);

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
    const where = f.parentId
      ? `“${folders.find((x) => x.id === f.parentId)?.name ?? 'its parent'}”`
      : 'the library root';
    if (
      window.confirm(
        `Delete folder “${f.name}”?${
          inside || childFolders(folders, f.id).length ? ` Its contents will move to ${where}.` : ''
        }`
      )
    ) {
      p.onDeleteFolder(f.id);
    }
  };

  const toggleSidebarTag = (id: string) => {
    const on = prefs.tagMode === 'whitelist' && prefs.whitelist.includes(id);
    const whitelist = on
      ? prefs.whitelist.filter((t) => t !== id)
      : [...prefs.whitelist.filter((t) => tagIds.has(t)), id];
    setPrefs({
      tagMode: whitelist.length ? 'whitelist' : prefs.tagMode === 'whitelist' ? 'off' : prefs.tagMode,
      whitelist,
    });
  };

  // FAB Long press handling
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

  // Drag and drop handlers
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
        /* ignore */
      }
    },
  });

  // UI Components
  const TagPill: React.FC<{ tag: Tag; small?: boolean }> = ({ tag, small }) => (
    <span
      className={`inline-flex items-center gap-1 rounded-full font-semibold truncate ${
        small ? 'text-[10px] px-2 py-0.5' : 'text-xs px-2.5 py-1'
      }`}
      style={{ backgroundColor: `${tag.color}18`, color: tag.color }}
    >
      <Hash className={small ? 'w-2.5 h-2.5' : 'w-3 h-3'} />
      <span>{tag.name}</span>
    </span>
  );

  const FolderMenu: React.FC<{ f: Folder }> = ({ f }) => (
    <OnScreen
      className="absolute right-1 top-8 w-48 studio-glass-dock rounded-2xl p-1.5 shadow-2xl z-50 text-xs text-white"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="w-full px-3 py-2 rounded-xl flex items-center gap-2 hover:bg-white/10 text-left"
        onClick={() => startCreateFolder(f.id)}
      >
        <FolderPlus className="w-4 h-4 text-studio-accent" /> New subfolder
      </button>
      <button
        type="button"
        className="w-full px-3 py-2 rounded-xl flex items-center gap-2 hover:bg-white/10 text-left"
        onClick={() => {
          setNameDraft(f.name);
          setRenamingFolderId(f.id);
          setMenuFolderId(null);
        }}
      >
        <Edit2 className="w-4 h-4 text-gray-300" /> Rename
      </button>
      <button
        type="button"
        className="w-full px-3 py-2 rounded-xl flex items-center gap-2 hover:bg-white/10 text-left"
        onClick={() => {
          setMoveTarget({ kind: 'folder', id: f.id });
          setMenuFolderId(null);
        }}
      >
        <FolderInput className="w-4 h-4 text-gray-300" /> Move to…
      </button>
      <div className="px-3 py-2 flex flex-wrap gap-1.5 border-t border-b border-white/10 my-1">
        {FOLDER_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => {
              p.onUpdateFolder(f.id, { color: c });
              setMenuFolderId(null);
            }}
            className={`w-5 h-5 rounded-full transition active:scale-90 ${
              f.color === c ? 'ring-2 ring-white ring-offset-1 ring-offset-gray-900' : ''
            }`}
            style={{ backgroundColor: c }}
            title="Folder color"
          />
        ))}
      </div>
      <button
        type="button"
        className="w-full px-3 py-2 rounded-xl flex items-center gap-2 hover:bg-red-500/20 text-red-400 text-left font-medium"
        onClick={() => confirmDeleteFolder(f)}
      >
        <Trash2 className="w-4 h-4" /> Delete folder
      </button>
    </OnScreen>
  );

  const renderFolderItem = (f: Folder, depth: number): React.ReactNode => {
    const kids = sortFolders(childFolders(folders, f.id), 'title-asc');
    const open = prefs.expanded.includes(f.id);
    const active = current === f.id;

    return (
      <div key={f.id}>
        <div
          {...dragProps('folder', f.id)}
          {...dropProps(f.id)}
          className={`group relative flex items-center rounded-2xl pr-1 transition-all ${
            active
              ? 'bg-studio-accent-subtle text-studio-accent font-semibold shadow-sm'
              : 'hover:bg-black/5 dark:hover:bg-white/5 text-gray-700 dark:text-gray-300'
          } ${dropFolder === f.id ? 'ring-2 ring-studio-accent' : ''}`}
          style={{ paddingLeft: 6 + depth * 14 }}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              toggleExpanded(f.id);
            }}
            className={`p-1.5 text-gray-400 ${kids.length || creatingIn === f.id ? '' : 'invisible'}`}
            aria-label={open ? 'Collapse' : 'Expand'}
          >
            {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>

          {renamingFolderId === f.id ? (
            <div className="flex-1 flex items-center gap-2 py-1 pr-1 min-w-0">
              <FolderIcon className="w-4 h-4 flex-shrink-0" style={{ color: f.color ?? FOLDER_COLORS[0] }} />
              <input
                autoFocus
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={commitRenameFolder}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRenameFolder();
                  if (e.key === 'Escape') setRenamingFolderId(null);
                }}
                className="w-full text-xs px-2 py-1 rounded-lg bg-white dark:bg-ui-high border border-studio-accent text-gray-900 dark:text-gray-100 focus:outline-none select-text"
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => selectFolder(f.id)}
              className="flex-1 flex items-center gap-2 py-2 text-xs min-w-0 text-left font-medium"
            >
              <FolderIcon
                className="w-4 h-4 flex-shrink-0"
                style={{ color: f.color ?? FOLDER_COLORS[0] }}
                fill={f.color ?? FOLDER_COLORS[0]}
                fillOpacity={0.18}
              />
              <span className="truncate flex-1">{f.name}</span>
              <span className="text-[11px] text-gray-400 tabular-nums">
                {folderCounts.get(f.id) || ''}
              </span>
            </button>
          )}

          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              closeMenus();
              setMenuFolderId(menuFolderId === f.id ? null : f.id);
            }}
            className={`p-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 rounded-lg ${
              narrow || menuFolderId === f.id ? '' : 'opacity-0 group-hover:opacity-100'
            }`}
            title="Folder options"
          >
            <MoreVertical className="w-3.5 h-3.5" />
          </button>
          {menuFolderId === f.id && <FolderMenu f={f} />}
        </div>

        {open && (
          <div className="space-y-0.5 mt-0.5">
            {kids.map((k) => renderFolderItem(k, depth + 1))}
            {creatingIn === f.id && (
              <div
                className="flex items-center gap-2 py-1 pr-1"
                style={{ paddingLeft: 6 + (depth + 1) * 14 + 20 }}
              >
                <FolderIcon className="w-4 h-4 text-gray-400 flex-shrink-0" />
                <input
                  autoFocus
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onBlur={commitCreateFolder}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitCreateFolder();
                    if (e.key === 'Escape') setCreatingIn(null);
                  }}
                  placeholder="Folder name"
                  className="w-full text-xs px-2 py-1 rounded-lg bg-white dark:bg-ui-high border border-studio-accent text-gray-900 dark:text-gray-100 focus:outline-none select-text"
                />
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  // Sidebar Layout
  const sidebar = (
    <aside
      data-cutout-clear
      className="w-[calc(18rem+var(--sa-left))] pl-[var(--sa-left)] h-full bg-ui-side border-r border-black/5 dark:border-white/5 flex flex-col select-none"
      onClick={closeMenus}
    >
      <div className="h-16 flex-shrink-0 pt-[var(--sa-top)]" />

      {/* Search Input in Sidebar */}
      <div className="px-3 pb-3 flex-shrink-0">
        <div className="relative">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-2.5" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search notes, formulas, text…"
            className="w-full bg-white dark:bg-ui-raised border border-black/5 dark:border-white/10 rounded-2xl pl-9 pr-3 py-2 text-xs text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-studio-accent/40 select-text"
          />
        </div>

        <button
          type="button"
          onClick={() => selectFolder(null)}
          {...dropProps(null)}
          className={`w-full flex items-center justify-between px-3 py-2.5 rounded-2xl text-xs font-semibold mt-3 transition-all ${
            current === null
              ? 'bg-studio-accent text-white shadow-md shadow-blue-600/20'
              : 'text-gray-700 dark:text-gray-300 hover:bg-black/5 dark:hover:bg-white/5'
          } ${dropFolder === 'root' ? 'ring-2 ring-studio-accent' : ''}`}
        >
          <span className="flex items-center gap-2.5">
            <BookOpen className="w-4 h-4" /> All Notes
          </span>
          <span className="text-[11px] opacity-80 tabular-nums">{notes.length}</span>
        </button>
      </div>

      {/* Folders & Tags Scroll Container */}
      <div className="flex-1 overflow-y-auto px-3 pb-24 space-y-4 no-scrollbar">
        {/* Folders Section */}
        <div>
          <div className="flex items-center justify-between px-2 mb-1.5 text-[11px] font-bold text-gray-400 uppercase tracking-wider">
            <span>Folders</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                startCreateFolder(null);
              }}
              className="p-1 hover:text-studio-accent transition"
              title="Create folder"
            >
              <FolderPlus className="w-4 h-4" />
            </button>
          </div>
          <div className="space-y-0.5">
            {sortFolders(childFolders(folders, undefined), 'title-asc').map((f) =>
              renderFolderItem(f, 0)
            )}
            {creatingIn === 'root' && (
              <div className="flex items-center gap-2 py-1 pl-6 pr-1">
                <FolderIcon className="w-4 h-4 text-gray-400 flex-shrink-0" />
                <input
                  autoFocus
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onBlur={commitCreateFolder}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitCreateFolder();
                    if (e.key === 'Escape') setCreatingIn(null);
                  }}
                  placeholder="Folder name"
                  className="w-full text-xs px-2 py-1 rounded-lg bg-white dark:bg-ui-high border border-studio-accent text-gray-900 dark:text-gray-100 focus:outline-none select-text"
                />
              </div>
            )}
          </div>
        </div>

        {/* Tags Section */}
        <div>
          <div className="flex items-center justify-between px-2 mb-1.5 text-[11px] font-bold text-gray-400 uppercase tracking-wider">
            <span>Tags</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setNameDraft('');
                setCreatingTag(true);
              }}
              className="p-1 hover:text-studio-accent transition"
              title="Create tag"
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>
          <div className="space-y-0.5">
            {tags.map((t) => {
              const inFilter =
                prefs.tagMode === 'whitelist'
                  ? prefs.whitelist.includes(t.id)
                  : prefs.tagMode === 'blacklist'
                  ? prefs.blacklist.includes(t.id)
                  : false;

              return (
                <div
                  key={t.id}
                  className={`group relative flex items-center rounded-2xl pr-1 transition-all ${
                    inFilter
                      ? 'bg-studio-accent-subtle text-studio-accent font-semibold shadow-sm'
                      : 'hover:bg-black/5 dark:hover:bg-white/5 text-gray-700 dark:text-gray-300'
                  }`}
                >
                  {renamingTagId === t.id ? (
                    <div className="flex-1 flex items-center gap-2 px-3 py-1 min-w-0">
                      <Hash className="w-4 h-4 flex-shrink-0" style={{ color: t.color }} />
                      <input
                        autoFocus
                        value={nameDraft}
                        onChange={(e) => setNameDraft(e.target.value)}
                        onBlur={commitRenameTag}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitRenameTag();
                          if (e.key === 'Escape') setRenamingTagId(null);
                        }}
                        className="w-full text-xs px-2 py-1 rounded-lg bg-white dark:bg-ui-high border border-studio-accent text-gray-900 dark:text-gray-100 focus:outline-none select-text"
                      />
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => toggleSidebarTag(t.id)}
                      className="flex-1 flex items-center gap-2 px-3 py-2 text-xs min-w-0 text-left font-medium"
                    >
                      <Hash className="w-4 h-4 flex-shrink-0" style={{ color: t.color }} />
                      <span className="truncate flex-1">{t.name}</span>
                      {inFilter && <Check className="w-3.5 h-3.5 text-studio-accent" />}
                      <span className="text-[11px] text-gray-400 tabular-nums">
                        {tagCounts.get(t.id) || ''}
                      </span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeMenus();
                      setMenuTagId(menuTagId === t.id ? null : t.id);
                    }}
                    className={`p-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 rounded-lg ${
                      narrow || menuTagId === t.id ? '' : 'opacity-0 group-hover:opacity-100'
                    }`}
                    title="Tag options"
                  >
                    <MoreVertical className="w-3.5 h-3.5" />
                  </button>

                  {menuTagId === t.id && (
                    <OnScreen
                      className="absolute right-1 top-8 w-44 studio-glass-dock rounded-2xl p-1.5 shadow-2xl z-50 text-xs text-white"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        className="w-full px-3 py-2 rounded-xl flex items-center gap-2 hover:bg-white/10 text-left"
                        onClick={() => {
                          setNameDraft(t.name);
                          setRenamingTagId(t.id);
                          setMenuTagId(null);
                        }}
                      >
                        <Edit2 className="w-4 h-4 text-gray-300" /> Rename
                      </button>
                      <div className="px-3 py-2 flex flex-wrap gap-1.5 border-t border-b border-white/10 my-1">
                        {TAG_COLORS.map((c) => (
                          <button
                            key={c}
                            type="button"
                            onClick={() => {
                              p.onUpdateTag(t.id, { color: c });
                              setMenuTagId(null);
                            }}
                            className={`w-5 h-5 rounded-full transition active:scale-90 ${
                              t.color === c ? 'ring-2 ring-white ring-offset-1 ring-offset-gray-900' : ''
                            }`}
                            style={{ backgroundColor: c }}
                            title="Tag color"
                          />
                        ))}
                      </div>
                      <button
                        type="button"
                        className="w-full px-3 py-2 rounded-xl flex items-center gap-2 hover:bg-red-500/20 text-red-400 text-left font-medium"
                        onClick={() => {
                          setMenuTagId(null);
                          if (
                            window.confirm(
                              `Delete tag “${t.name}”? It will be scrubbed from ${
                                tagCounts.get(t.id) ?? 0
                              } note(s).`
                            )
                          ) {
                            p.onDeleteTag(t.id);
                          }
                        }}
                      >
                        <Trash2 className="w-4 h-4" /> Delete tag
                      </button>
                    </OnScreen>
                  )}
                </div>
              );
            })}
            {creatingTag && (
              <div className="flex items-center gap-2 px-3 py-1">
                <Hash className="w-4 h-4 text-gray-400 flex-shrink-0" />
                <input
                  autoFocus
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onBlur={commitCreateTag}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitCreateTag();
                    if (e.key === 'Escape') setCreatingTag(false);
                  }}
                  placeholder="Tag name"
                  className="w-full text-xs px-2 py-1 rounded-lg bg-white dark:bg-ui-high border border-studio-accent text-gray-900 dark:text-gray-100 focus:outline-none select-text"
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </aside>
  );

  // Note anchored action menu
  const menuAnchors = useRef(new Map<string, HTMLButtonElement>());
  const noteMenu = (n: NoteDocument) => (
    <AnchoredMenu anchor={menuAnchors.current.get(n.id) ?? null} width={180} onClose={() => setMenuNoteId(null)}>
      <button
        type="button"
        onClick={() => {
          setRenamingNoteId(n.id);
          setRenameTitle(n.title);
          setMenuNoteId(null);
        }}
        className="w-full px-3 py-2 rounded-xl flex items-center gap-2 hover:bg-white/10 text-left"
      >
        <Edit2 className="w-4 h-4 text-gray-300" /> Rename
      </button>
      <button
        type="button"
        onClick={() => {
          setMoveTarget({ kind: 'note', id: n.id });
          setMenuNoteId(null);
        }}
        className="w-full px-3 py-2 rounded-xl flex items-center gap-2 hover:bg-white/10 text-left"
      >
        <FolderInput className="w-4 h-4 text-gray-300" /> Move to…
      </button>
      <button
        type="button"
        onClick={() => {
          setTagNoteId(n.id);
          setMenuNoteId(null);
        }}
        className="w-full px-3 py-2 rounded-xl flex items-center gap-2 hover:bg-white/10 text-left"
      >
        <TagIcon className="w-4 h-4 text-gray-300" /> Tags…
      </button>
      <button
        type="button"
        onClick={() => {
          p.onDuplicateNote(n.id);
          setMenuNoteId(null);
        }}
        className="w-full px-3 py-2 rounded-xl flex items-center gap-2 hover:bg-white/10 text-left"
      >
        <Copy className="w-4 h-4 text-gray-300" /> Duplicate
      </button>
      <div className="w-full h-px bg-white/10 my-1" />
      <button
        type="button"
        onClick={() => confirmDeleteNote(n)}
        className="w-full px-3 py-2 rounded-xl flex items-center gap-2 hover:bg-red-500/20 text-red-400 text-left font-medium"
      >
        <Trash2 className="w-4 h-4" /> Delete
      </button>
    </AnchoredMenu>
  );

  const noteTags = (n: NoteDocument) =>
    (n.tagIds ?? []).map((id) => tagById.get(id)).filter((t): t is Tag => !!t);

  const folderOfNote = (n: NoteDocument) => {
    const id = noteFolder(n, folderIds);
    return id ? folders.find((f) => f.id === id) : undefined;
  };

  const emptyText = filterOn
    ? 'No notes match the current tag filter.'
    : q
    ? 'Nothing matches your search query.'
    : current
    ? 'This folder has no notes yet.'
    : 'Your studio library is empty.';

  // Render Note Cards in Bento Grid or List View
  const content =
    visibleNotes.length === 0 && subfolders.length === 0 ? (
      <div className="h-full flex flex-col items-center justify-center text-gray-400 text-center px-6">
        <FileText className="w-12 h-12 stroke-[1.2] mb-3 text-gray-300 dark:text-gray-600" />
        <div className="font-serif font-bold text-base text-gray-700 dark:text-gray-300">{emptyText}</div>
        <p className="text-xs text-gray-400 mt-1 max-w-xs">
          Tap + below to create a blank notebook, or hold it to import a document.
        </p>
      </div>
    ) : (
      <>
        {/* Subfolders Grid if any */}
        {subfolders.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3.5 mb-6">
            {subfolders.map((f) => (
              <div
                key={f.id}
                {...dragProps('folder', f.id)}
                {...dropProps(f.id)}
                onClick={() => p.onSelectFolder(f.id)}
                className={`studio-card rounded-2xl p-3.5 flex items-center gap-3 cursor-pointer ${
                  dropFolder === f.id ? 'ring-2 ring-studio-accent' : ''
                }`}
              >
                <FolderIcon
                  className="w-7 h-7 flex-shrink-0"
                  style={{ color: f.color ?? FOLDER_COLORS[0] }}
                  fill={f.color ?? FOLDER_COLORS[0]}
                  fillOpacity={0.2}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-bold text-gray-900 dark:text-gray-100 truncate">
                    {f.name}
                  </div>
                  <div className="text-[11px] text-gray-400 tabular-nums">
                    {folderCounts.get(f.id) ?? 0} notes
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Notes Collection */}
        {prefs.viewMode === 'grid' ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
            {visibleNotes.map((note) => {
              const folder = !current ? folderOfNote(note) : undefined;
              const nt = noteTags(note);

              return (
                <div
                  key={note.id}
                  {...dragProps('note', note.id)}
                  onClick={() => p.onOpenNote(note.id)}
                  className="studio-card rounded-2xl flex flex-col overflow-hidden cursor-pointer group"
                >
                  {/* Thumbnail Preview Area */}
                  <div className="relative border-b border-black/5 dark:border-white/5 overflow-hidden">
                    <NoteThumb note={note} />
                    {folder && (
                      <span
                        className="absolute top-2.5 left-2.5 flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full text-white shadow-sm max-w-[80%] truncate"
                        style={{ backgroundColor: folder.color ?? FOLDER_COLORS[0] }}
                      >
                        <FolderIcon className="w-2.5 h-2.5 flex-shrink-0" />
                        <span className="truncate">{folder.name}</span>
                      </span>
                    )}
                  </div>

                  {/* Card Content & Metadata */}
                  <div className="p-3 flex flex-col flex-1 justify-between gap-2">
                    <div>
                      <div className="flex items-start justify-between gap-1">
                        {renamingNoteId === note.id ? (
                          <input
                            autoFocus
                            value={renameTitle}
                            onChange={(e) => setRenameTitle(e.target.value)}
                            onBlur={() => saveRename(note.id)}
                            onKeyDown={(e) => e.key === 'Enter' && saveRename(note.id)}
                            onClick={(e) => e.stopPropagation()}
                            className="w-full text-xs font-bold p-1 rounded bg-white dark:bg-ui-high border border-studio-accent select-text"
                          />
                        ) : (
                          <div className="font-serif font-bold text-sm text-gray-900 dark:text-gray-100 truncate flex-1">
                            {note.title}
                          </div>
                        )}
                        <button
                          ref={(el) => {
                            if (el) menuAnchors.current.set(note.id, el);
                            else menuAnchors.current.delete(note.id);
                          }}
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            closeMenus();
                            setMenuNoteId(menuNoteId === note.id ? null : note.id);
                          }}
                          className="p-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 rounded-lg"
                        >
                          <MoreVertical className="w-4 h-4" />
                        </button>
                      </div>

                      <div className="text-[11px] text-gray-400 flex items-center gap-2 mt-1 tabular-nums">
                        <span>{pageCountOf(note)} p.</span>
                        <span>•</span>
                        <span>{fullDate(note.updatedAt)}</span>
                      </div>
                    </div>

                    {nt.length > 0 && (
                      <div className="flex flex-wrap gap-1 pt-1 border-t border-black/5 dark:border-white/5">
                        {nt.slice(0, 2).map((t) => (
                          <TagPill key={t.id} tag={t} small />
                        ))}
                        {nt.length > 2 && (
                          <span className="text-[10px] text-gray-400 self-center">+{nt.length - 2}</span>
                        )}
                      </div>
                    )}
                  </div>

                  {menuNoteId === note.id && noteMenu(note)}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="divide-y divide-black/5 dark:divide-white/5 bg-white dark:bg-ui-card rounded-2xl border border-black/5 dark:border-white/10 overflow-hidden shadow-sm">
            {visibleNotes.map((note) => {
              const folder = !current ? folderOfNote(note) : undefined;
              const nt = noteTags(note);

              return (
                <div
                  key={note.id}
                  {...dragProps('note', note.id)}
                  onClick={() => p.onOpenNote(note.id)}
                  className="py-3 px-4 flex items-center justify-between gap-3 hover:bg-black/5 dark:hover:bg-white/5 transition cursor-pointer"
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <FileText className="w-5 h-5 text-studio-accent flex-shrink-0" />
                    <div className="min-w-0 flex-1">
                      {renamingNoteId === note.id ? (
                        <input
                          autoFocus
                          value={renameTitle}
                          onChange={(e) => setRenameTitle(e.target.value)}
                          onBlur={() => saveRename(note.id)}
                          onKeyDown={(e) => e.key === 'Enter' && saveRename(note.id)}
                          onClick={(e) => e.stopPropagation()}
                          className="w-full text-xs font-bold p-1 rounded bg-white dark:bg-ui-high border border-studio-accent select-text"
                        />
                      ) : (
                        <div className="font-serif font-bold text-sm text-gray-900 dark:text-gray-100 truncate">
                          {note.title}
                        </div>
                      )}
                      <div className="text-[11px] text-gray-400 flex items-center gap-2 mt-0.5 tabular-nums flex-wrap">
                        <span>{pageCountOf(note)} p.</span>
                        <span>•</span>
                        <span>Edited {fullDate(note.updatedAt)}</span>
                        {folder && (
                          <span className="flex items-center gap-1 font-medium" style={{ color: folder.color }}>
                            <FolderIcon className="w-3 h-3" />
                            {folder.name}
                          </span>
                        )}
                        {nt.map((t) => (
                          <TagPill key={t.id} tag={t} small />
                        ))}
                      </div>
                    </div>
                  </div>

                  <button
                    ref={(el) => {
                      if (el) menuAnchors.current.set(note.id, el);
                      else menuAnchors.current.delete(note.id);
                    }}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeMenus();
                      setMenuNoteId(menuNoteId === note.id ? null : note.id);
                    }}
                    className="p-1.5 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 rounded-lg"
                  >
                    <MoreVertical className="w-4 h-4" />
                  </button>
                  {menuNoteId === note.id && noteMenu(note)}
                </div>
              );
            })}
          </div>
        )}
      </>
    );

  // Filter & Sort popover menu
  const filterMenu = (
    <OnScreen
      className="absolute right-0 top-12 w-72 studio-glass-dock rounded-2xl p-3 shadow-2xl z-50 text-xs text-white max-h-[calc(100dvh-100px)] overflow-y-auto no-scrollbar"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">
        Sort order
      </div>
      <div className="space-y-1 mb-4">
        {SORT_OPTIONS.map((opt) => (
          <button
            key={opt.id}
            type="button"
            onClick={() => setPrefs({ sort: opt.id })}
            className={`w-full px-2.5 py-1.5 rounded-xl flex items-center justify-between text-left transition ${
              prefs.sort === opt.id ? 'bg-studio-accent text-white font-semibold' : 'hover:bg-white/10'
            }`}
          >
            <span>{opt.group}: {opt.label}</span>
            {prefs.sort === opt.id && <Check className="w-3.5 h-3.5" />}
          </button>
        ))}
      </div>

      <div className="pt-2 border-t border-white/10 flex items-center justify-between mb-2">
        <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">
          Filter by tag
        </span>
        {filterOn && (
          <button
            type="button"
            onClick={() => setPrefs({ tagMode: 'off' })}
            className="text-studio-accent font-semibold text-[11px]"
          >
            Clear
          </button>
        )}
      </div>

      <div className="flex bg-white/10 rounded-xl p-0.5 mb-2">
        {(['off', 'whitelist', 'blacklist'] as TagMode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setPrefs({ tagMode: m })}
            className={`flex-1 py-1 rounded-lg text-[10px] font-medium capitalize ${
              prefs.tagMode === m ? 'bg-studio-accent text-white font-semibold' : 'text-gray-300'
            }`}
          >
            {m}
          </button>
        ))}
      </div>

      {prefs.tagMode !== 'off' && (
        <div className="space-y-1 max-h-40 overflow-y-auto no-scrollbar">
          {tags.map((t) => {
            const list = prefs.tagMode === 'whitelist' ? prefs.whitelist : prefs.blacklist;
            const on = list.includes(t.id);
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  const key = prefs.tagMode === 'whitelist' ? 'whitelist' : 'blacklist';
                  const cur = prefs[key];
                  setPrefs({ [key]: on ? cur.filter((x) => x !== t.id) : [...cur, t.id] });
                }}
                className="w-full px-2 py-1.5 rounded-lg flex items-center gap-2 hover:bg-white/10 text-left"
              >
                <span
                  className={`w-3.5 h-3.5 rounded flex items-center justify-center border ${
                    on ? 'bg-studio-accent border-studio-accent' : 'border-gray-500'
                  }`}
                >
                  {on && <Check className="w-2.5 h-2.5 text-white" />}
                </span>
                <Hash className="w-3 h-3" style={{ color: t.color }} />
                <span className="truncate flex-1">{t.name}</span>
                <span className="text-[10px] text-gray-400">{tagCounts.get(t.id) ?? 0}</span>
              </button>
            );
          })}
        </div>
      )}
    </OnScreen>
  );

  // Sheets: Move & Tags
  const moveSheet = moveTarget && (
    <StudioSheet
      isOpen={!!moveTarget}
      onClose={() => setMoveTarget(null)}
      title="Relocate to Folder"
    >
      <div className="space-y-1">
        <button
          type="button"
          onClick={() => {
            if (moveTarget.kind === 'note') p.onMoveNote(moveTarget.id, undefined);
            else p.onMoveFolder(moveTarget.id, undefined);
            setMoveTarget(null);
          }}
          className="w-full px-3 py-2 rounded-xl flex items-center gap-2 text-left hover:bg-black/5 dark:hover:bg-white/5 font-medium text-xs text-gray-800 dark:text-gray-200"
        >
          <BookOpen className="w-4 h-4 text-studio-accent" />
          <span>Library root (no folder)</span>
        </button>

        {folders.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => {
              if (moveTarget.kind === 'note') p.onMoveNote(moveTarget.id, f.id);
              else p.onMoveFolder(moveTarget.id, f.id);
              setMoveTarget(null);
            }}
            className="w-full px-3 py-2 rounded-xl flex items-center gap-2 text-left hover:bg-black/5 dark:hover:bg-white/5 text-xs text-gray-800 dark:text-gray-200"
          >
            <FolderIcon className="w-4 h-4" style={{ color: f.color }} />
            <span className="truncate flex-1">{f.name}</span>
          </button>
        ))}
      </div>
    </StudioSheet>
  );

  const tagNote = tagNoteId ? notes.find((n) => n.id === tagNoteId) : undefined;
  const [newTagName, setNewTagName] = useState('');
  const tagSheet = tagNote && (
    <StudioSheet
      isOpen={!!tagNote}
      onClose={() => setTagNoteId(null)}
      title={`Tags for “${tagNote.title}”`}
    >
      <div className="space-y-2">
        <div className="space-y-1 max-h-48 overflow-y-auto no-scrollbar">
          {tags.map((t) => {
            const on = (tagNote.tagIds ?? []).includes(t.id);
            return (
              <button
                key={t.id}
                type="button"
                onClick={() =>
                  p.onSetNoteTags(tagNote.id, (cur) =>
                    on ? cur.filter((x) => x !== t.id) : [...cur, t.id]
                  )
                }
                className="w-full px-3 py-2 rounded-xl flex items-center gap-2.5 text-left hover:bg-black/5 dark:hover:bg-white/5 text-xs text-gray-800 dark:text-gray-200 font-medium"
              >
                <span
                  className={`w-4 h-4 rounded flex items-center justify-center border ${
                    on ? 'bg-studio-accent border-studio-accent text-white' : 'border-gray-400'
                  }`}
                >
                  {on && <Check className="w-3 h-3" />}
                </span>
                <TagPill tag={t} />
              </button>
            );
          })}
        </div>

        <form
          className="flex items-center gap-2 pt-2 border-t border-black/5 dark:border-white/5"
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
          <input
            value={newTagName}
            onChange={(e) => setNewTagName(e.target.value)}
            placeholder="Add new tag"
            className="flex-1 text-xs px-2.5 py-1.5 rounded-xl bg-gray-50 dark:bg-ui-high border border-black/5 dark:border-white/10 select-text"
          />
          <StudioButton size="xs" variant="primary" type="submit">
            Add
          </StudioButton>
        </form>
      </div>
    </StudioSheet>
  );

  const viewTitle = current ? path[path.length - 1]?.name ?? 'Folder' : 'All Notes';
  const sidebarShown = !collapsed;

  return (
    <div
      className="relative h-full flex bg-ui-app text-gray-900 dark:text-gray-100 select-none overflow-hidden font-sans"
      onClick={closeMenus}
    >
      {/* Brand Monogram in Top Left */}
      <div
        data-cutout-clear
        className={`absolute left-[var(--sa-left)] top-0 z-50 flex items-center pt-[var(--sa-top)] h-[calc(3.5rem+var(--sa-top))] ${
          sidebarShown ? 'w-72' : ''
        }`}
      >
        <div className="w-14 h-14 flex-shrink-0 flex items-center justify-center">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setPrefs({ sidebarCollapsed: !collapsed });
            }}
            className="flex rounded-2xl active:scale-95 transition shadow-sm"
            title={collapsed ? 'Show collection sidebar' : 'Hide collection sidebar'}
          >
            <Logo size={36} />
          </button>
        </div>
        {sidebarShown && (
          <div className="flex items-baseline gap-2 min-w-0">
            <span
              data-cutout-item
              className="font-serif font-bold text-lg text-gray-900 dark:text-gray-100 truncate"
            >
              OpenNote
            </span>
            <span
              data-cutout-item
              className="text-[10px] font-semibold text-gray-400 tabular-nums uppercase tracking-wider"
            >
              v{__APP_VERSION__}
            </span>
          </div>
        )}
      </div>

      {/* Sidebar (Desktop push / Mobile overlay) */}
      {narrow ? (
        sidebarShown && (
          <div
            className="fixed inset-0 z-40 flex"
            onClick={() => setPrefs({ sidebarCollapsed: true })}
          >
            <div onClick={(e) => e.stopPropagation()} className="shadow-2xl h-full">
              {sidebar}
            </div>
            <div className="flex-1 bg-black/40 backdrop-blur-sm" />
          </div>
        )
      ) : (
        <div
          className={`flex-shrink-0 h-full overflow-hidden transition-[width] duration-200 ease-out ${
            sidebarShown ? 'w-[calc(18rem+var(--sa-left))]' : 'w-0'
          }`}
        >
          {sidebar}
        </div>
      )}

      {/* Main Studio Area */}
      <main className="flex-1 min-w-0 flex flex-col overflow-hidden bg-white dark:bg-ui-panel">
        {/* Top Header */}
        <header
          data-cutout-clear
          data-cutout-bar
          className={`border-b border-black/5 dark:border-white/5 flex items-center justify-between gap-3 pr-[calc(1rem+var(--sa-right))] flex-shrink-0 pt-[var(--sa-top)] h-[calc(3.5rem+var(--sa-top))] ${
            !sidebarShown || narrow ? 'pl-[calc(4rem+var(--sa-left))]' : 'pl-6'
          }`}
        >
          <div className="flex items-center gap-2 min-w-0">
            <h1 className="font-serif font-bold text-lg sm:text-xl text-gray-900 dark:text-gray-100 truncate">
              {viewTitle}
            </h1>
            <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-studio-accent-subtle text-studio-accent tabular-nums">
              {visibleNotes.length}
            </span>
          </div>

          <div className="flex items-center gap-2">
            {/* View Mode Toggle */}
            <div className="hidden sm:flex items-center bg-gray-100 dark:bg-ui-raised p-0.5 rounded-xl border border-black/5 dark:border-white/5">
              <button
                type="button"
                onClick={() => setPrefs({ viewMode: 'grid' })}
                className={`p-1.5 rounded-lg transition ${
                  prefs.viewMode === 'grid'
                    ? 'bg-white dark:bg-ui-high text-studio-accent shadow-sm'
                    : 'text-gray-400'
                }`}
                title="Bento Grid"
              >
                <GridIcon className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setPrefs({ viewMode: 'list' })}
                className={`p-1.5 rounded-lg transition ${
                  prefs.viewMode === 'list'
                    ? 'bg-white dark:bg-ui-high text-studio-accent shadow-sm'
                    : 'text-gray-400'
                }`}
                title="List View"
              >
                <ListIcon className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Sort & Filter Popover Button */}
            <div className="relative">
              <StudioButton
                size="sm"
                variant={filterOpen || filterOn ? 'primary' : 'secondary'}
                onClick={() => {
                  const o = !filterOpen;
                  closeMenus();
                  setFilterOpen(o);
                }}
              >
                <SlidersHorizontal className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Sort & Filter</span>
              </StudioButton>
              {filterOpen && filterMenu}
            </div>
          </div>
        </header>

        {/* Notes Grid / List Canvas */}
        <div
          className="flex-1 overflow-y-auto p-4 sm:p-8 pb-32 no-scrollbar"
          style={{ touchAction: 'pan-y' }}
        >
          {content}
        </div>
      </main>

      {/* Settings Action: Bottom Left Fixed */}
      <StudioButton
        size="icon"
        variant="glass"
        onClick={p.onOpenSettings}
        className="absolute z-50 left-[calc(1rem+var(--sa-left))] bottom-[calc(1rem+var(--sa-bottom))] rounded-full shadow-lg"
        title="Settings"
      >
        <SettingsIcon className="w-5 h-5 text-gray-700 dark:text-gray-200" />
      </StudioButton>

      {/* Floating Creation Command Island (Bottom Right) */}
      <div
        data-cutout-clear
        className="absolute z-40 right-[calc(1.25rem+var(--sa-right))] bottom-[calc(1.25rem+var(--sa-bottom))] flex flex-col items-end gap-2"
        onClick={(e) => e.stopPropagation()}
      >
        {fabMenu && (
          <OnScreen className="studio-glass-dock rounded-2xl p-1.5 mb-2 w-56 shadow-2xl z-50 text-xs text-white">
            <button
              type="button"
              className="w-full px-3 py-2 rounded-xl flex items-center gap-2 hover:bg-white/10 text-left"
              onClick={() => {
                setFabMenu(false);
                importRef.current?.click();
              }}
            >
              <Upload className="w-4 h-4 text-studio-accent" />
              <div>
                <div className="font-semibold">Import File…</div>
                <div className="text-[10px] text-gray-300">PDF, Word, Notability, images</div>
              </div>
            </button>
            <button
              type="button"
              className="w-full px-3 py-2 rounded-xl flex items-center gap-2 hover:bg-white/10 text-left"
              onClick={() => {
                setFabMenu(false);
                startCreateFolder(current);
                if (collapsed) setPrefs({ sidebarCollapsed: false });
              }}
            >
              <FolderPlus className="w-4 h-4 text-studio-accent" />
              <span>New folder{current ? ' here' : ''}</span>
            </button>
          </OnScreen>
        )}

        <button
          type="button"
          onPointerDown={fabDown}
          onPointerUp={fabUp}
          onPointerLeave={fabCancel}
          onPointerCancel={fabCancel}
          onContextMenu={(e) => {
            e.preventDefault();
            fabCancel();
            setFabMenu(true);
          }}
          className={`w-14 h-14 rounded-full bg-gradient-to-br from-blue-600 to-indigo-600 text-white shadow-xl shadow-blue-600/30 flex items-center justify-center active:scale-95 transition-all duration-200 ${
            fabMenu ? 'rotate-45' : ''
          }`}
          title="Create note (hold to import document)"
          aria-label="New Note"
        >
          <Plus className="w-7 h-7 stroke-[2.4]" />
        </button>

        <input
          ref={importRef}
          type="file"
          multiple
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
