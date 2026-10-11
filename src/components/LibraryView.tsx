import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  FileText, Plus, Search, MoreVertical, Trash2, Edit2, BookOpen, Clock, Settings as SettingsIcon,
  Grid as GridIcon, List as ListIcon, Copy, Menu, X, FolderInput, Upload, Download,
} from 'lucide-react';
import { NoteDocument, PAGE_HEIGHT, PAGE_WIDTH, Subject } from '../types';
import { drawStrokes } from '../ink/strokeRenderer';
import { paperBackground } from './CanvasPage';

interface LibraryViewProps {
  notes: NoteDocument[];
  subjects: Subject[];
  selectedSubjectId: string | null;
  onSelectSubject: (subjectId: string | null) => void;
  onOpenNote: (noteId: string) => void;
  onCreateNote: (subjectId?: string) => void;
  onDeleteNote: (noteId: string) => void;
  onDuplicateNote: (noteId: string) => void;
  onRenameNote: (noteId: string, newTitle: string) => void;
  onMoveNote: (noteId: string, subjectId: string | undefined) => void;
  onCreateSubject: (name: string, color: string) => void;
  onDeleteSubject: (subjectId: string) => void;
  onOpenSettings: () => void;
  onBackup: () => void;
  onImport: (file: File) => void;
}

const NoteThumb: React.FC<{ note: NoteDocument }> = ({ note }) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLCanvasElement>(null);
  const [scale, setScale] = useState(0.2);
  const page = note.pages[0];
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(el.clientWidth / PAGE_WIDTH));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const c = ref.current;
    if (!c || !page) return;
    const r = Math.min(2, window.devicePixelRatio || 1) * scale;
    c.width = Math.round(PAGE_WIDTH * r);
    c.height = Math.round(PAGE_HEIGHT * r);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(r, 0, 0, r, 0, 0);
    for (const t of page.textBlocks ?? []) {
      ctx.fillStyle = note.paperColor === 'dark' ? '#e5e7eb' : '#374151';
      ctx.font = `${t.fontSize}px sans-serif`;
      ctx.fillText(t.text.slice(0, 80), t.x, t.y + t.fontSize, t.width);
    }
    for (const b of page.latexBlocks) {
      ctx.fillStyle = 'rgba(37,99,235,0.14)';
      ctx.fillRect(b.x, b.y, b.width, b.height);
    }
    for (const im of page.imageBlocks ?? []) {
      ctx.fillStyle = 'rgba(107,114,128,0.2)';
      ctx.fillRect(im.x, im.y, im.width, im.height);
    }
    drawStrokes(ctx, page.strokes);
  }, [page, note.paperColor, scale]);
  return (
    <div ref={wrapRef} className="w-full overflow-hidden relative" style={{ height: Math.min(192, PAGE_HEIGHT * scale) }}>
      <div style={{ width: PAGE_WIDTH, height: PAGE_HEIGHT, transform: `scale(${scale})`, transformOrigin: '0 0', ...paperBackground(note.paperStyle, note.paperColor) }}>
        <canvas ref={ref} style={{ width: PAGE_WIDTH, height: PAGE_HEIGHT }} />
      </div>
    </div>
  );
};

export const LibraryView: React.FC<LibraryViewProps> = (p) => {
  const { notes, subjects, selectedSubjectId } = p;
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [newSubjectName, setNewSubjectName] = useState('');
  const [isAddingSubject, setIsAddingSubject] = useState(false);
  const [menuNoteId, setMenuNoteId] = useState<string | null>(null);
  const [moveNoteId, setMoveNoteId] = useState<string | null>(null);
  const [renamingNoteId, setRenamingNoteId] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);

  const filteredNotes = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return notes.filter((n) => {
      if (selectedSubjectId && n.subjectId !== selectedSubjectId) return false;
      if (!q) return true;
      if (n.title.toLowerCase().includes(q)) return true;
      return n.pages.some(
        (pg) => (pg.textBlocks ?? []).some((t) => t.text.toLowerCase().includes(q)) || pg.latexBlocks.some((b) => b.latexCode.toLowerCase().includes(q))
      );
    });
  }, [notes, selectedSubjectId, searchQuery]);

  const subjectTitle = selectedSubjectId ? subjects.find((s) => s.id === selectedSubjectId)?.name ?? 'Notes' : 'All Notes';

  const addSubject = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSubjectName.trim()) return;
    const colors = ['#1A73E8', '#10B981', '#9333EA', '#F59E0B', '#EF4444', '#EC4899', '#0EA5E9'];
    p.onCreateSubject(newSubjectName.trim(), colors[subjects.length % colors.length]);
    setNewSubjectName('');
    setIsAddingSubject(false);
  };

  const saveRename = (id: string) => {
    if (renameTitle.trim()) p.onRenameNote(id, renameTitle.trim());
    setRenamingNoteId(null);
  };

  const confirmDelete = (n: NoteDocument) => {
    if (window.confirm(`Delete “${n.title}”? This cannot be undone.`)) p.onDeleteNote(n.id);
    setMenuNoteId(null);
  };

  const NoteMenu: React.FC<{ note: NoteDocument; up?: boolean }> = ({ note, up }) => (
    <div className={`absolute right-0 ${up ? 'bottom-8' : 'top-8'} bg-white dark:bg-[#2C2C2E] border border-gray-200 dark:border-gray-700 rounded-xl shadow-xl py-1 w-44 z-30 text-sm`} onClick={(e) => e.stopPropagation()}>
      {moveNoteId === note.id ? (
        <>
          <button onClick={() => { p.onMoveNote(note.id, undefined); setMoveNoteId(null); setMenuNoteId(null); }} className="w-full px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500">No subject</button>
          {subjects.map((s) => (
            <button key={s.id} onClick={() => { p.onMoveNote(note.id, s.id); setMoveNoteId(null); setMenuNoteId(null); }} className="w-full px-3 py-2 flex items-center gap-2 hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200">
              <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: s.color }} /> {s.name}
            </button>
          ))}
        </>
      ) : (
        <>
          <button onClick={() => { setRenamingNoteId(note.id); setRenameTitle(note.title); setMenuNoteId(null); }} className="w-full px-3 py-2 flex items-center gap-2 hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200"><Edit2 className="w-4 h-4" /> Rename</button>
          <button onClick={() => setMoveNoteId(note.id)} className="w-full px-3 py-2 flex items-center gap-2 hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200"><FolderInput className="w-4 h-4" /> Move to…</button>
          <button onClick={() => { p.onDuplicateNote(note.id); setMenuNoteId(null); }} className="w-full px-3 py-2 flex items-center gap-2 hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200"><Copy className="w-4 h-4" /> Duplicate</button>
          <button onClick={() => confirmDelete(note)} className="w-full px-3 py-2 flex items-center gap-2 hover:bg-red-50 dark:hover:bg-red-900/30 text-red-600"><Trash2 className="w-4 h-4" /> Delete</button>
        </>
      )}
    </div>
  );

  const sidebar = (
    <aside className="w-72 h-full bg-[#ECECF1] dark:bg-[#1C1C1E] border-r border-gray-300 dark:border-gray-800 flex flex-col p-4 pt-[calc(1rem+env(safe-area-inset-top))]">
      <div className="flex items-center justify-between mb-4 px-1">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-blue-600 to-indigo-500 flex items-center justify-center text-white shadow font-bold text-lg">O</div>
          <span className="font-bold text-lg text-gray-900 dark:text-gray-100">OpenNote</span>
        </div>
        <div className="flex items-center">
          <button onClick={p.onOpenSettings} className="p-2 text-gray-500 rounded-lg" title="Settings"><SettingsIcon className="w-4 h-4" /></button>
          <button onClick={() => setDrawerOpen(false)} className="p-2 text-gray-500 rounded-lg md:hidden"><X className="w-4 h-4" /></button>
        </div>
      </div>
      <div className="relative mb-4">
        <Search className="w-4 h-4 text-gray-400 absolute left-3 top-2.5" />
        <input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="Search titles, text, LaTeX…" className="w-full bg-white dark:bg-[#2C2C2E] border border-gray-200 dark:border-gray-700 rounded-xl pl-9 pr-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 select-text" />
      </div>
      <button onClick={() => { p.onSelectSubject(null); setDrawerOpen(false); }} className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-sm font-semibold mb-4 ${selectedSubjectId === null ? 'bg-blue-600 text-white' : 'text-gray-700 dark:text-gray-300 hover:bg-gray-200/60 dark:hover:bg-gray-800'}`}>
        <span className="flex items-center gap-2.5"><BookOpen className="w-4 h-4" /> All Notes</span>
        <span className="text-xs opacity-80">{notes.length}</span>
      </button>
      <div className="flex items-center justify-between px-2 mb-2 text-[11px] font-bold text-gray-400 uppercase tracking-wider">
        <span>Subjects</span>
        <button onClick={() => setIsAddingSubject(true)} className="hover:text-blue-600" title="Add subject"><Plus className="w-4 h-4" /></button>
      </div>
      <div className="flex-1 overflow-y-auto space-y-0.5">
        {isAddingSubject && (
          <form onSubmit={addSubject} className="mb-2 px-1">
            <input autoFocus value={newSubjectName} onChange={(e) => setNewSubjectName(e.target.value)} onBlur={() => setIsAddingSubject(false)} placeholder="Subject name" className="w-full text-sm p-2 bg-white dark:bg-[#2C2C2E] border border-blue-500 rounded-lg text-gray-900 dark:text-gray-100 focus:outline-none select-text" />
          </form>
        )}
        {subjects.map((s) => {
          const count = notes.filter((n) => n.subjectId === s.id).length;
          const active = selectedSubjectId === s.id;
          return (
            <div key={s.id} className={`group flex items-center rounded-xl ${active ? 'bg-white dark:bg-[#2C2C2E] shadow-sm' : 'hover:bg-gray-200/50 dark:hover:bg-gray-800'}`}>
              <button onClick={() => { p.onSelectSubject(s.id); setDrawerOpen(false); }} className={`flex-1 flex items-center justify-between px-3 py-2 text-sm min-w-0 ${active ? 'text-blue-600 dark:text-blue-400 font-semibold' : 'text-gray-700 dark:text-gray-300'}`}>
                <span className="flex items-center gap-2.5 truncate"><span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: s.color }} /><span className="truncate">{s.name}</span></span>
                <span className="text-xs text-gray-400 ml-2">{count}</span>
              </button>
              <button onClick={() => window.confirm(`Delete subject “${s.name}”? Its notes are kept under All Notes.`) && p.onDeleteSubject(s.id)} className="p-1.5 mr-1 text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100" title="Delete subject"><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          );
        })}
      </div>
      <div className="pt-3 border-t border-gray-300/60 dark:border-gray-800 flex items-center justify-between text-xs text-gray-500">
        <button onClick={p.onBackup} className="flex items-center gap-1.5 hover:text-blue-600" title="Export all notes"><Download className="w-3.5 h-3.5" /> Backup</button>
        <button onClick={() => importRef.current?.click()} className="flex items-center gap-1.5 hover:text-blue-600" title="Import .opennote / backup"><Upload className="w-3.5 h-3.5" /> Import</button>
        <span className="text-gray-400">v1.1</span>
        <input ref={importRef} type="file" accept=".opennote,.json,application/json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) p.onImport(f); e.target.value = ''; }} />
      </div>
    </aside>
  );

  return (
    <div className="h-full flex bg-[#F2F2F7] dark:bg-[#121214] text-gray-900 dark:text-gray-100 select-none overflow-hidden" onClick={() => setMenuNoteId(null)}>
      <div className="hidden md:block flex-shrink-0">{sidebar}</div>
      {drawerOpen && (
        <div className="md:hidden fixed inset-0 z-40 flex" onClick={() => setDrawerOpen(false)}>
          <div onClick={(e) => e.stopPropagation()} className="shadow-2xl">{sidebar}</div>
          <div className="flex-1 bg-black/30" />
        </div>
      )}

      <main className="flex-1 flex flex-col overflow-hidden bg-white dark:bg-[#1C1C1E]">
        <header className="border-b border-gray-200 dark:border-gray-800 flex items-center justify-between gap-2 px-3 sm:px-6 py-3 flex-shrink-0 pt-[calc(0.75rem+env(safe-area-inset-top))] md:pt-3">
          <div className="flex items-center gap-2 min-w-0">
            <button onClick={(e) => { e.stopPropagation(); setDrawerOpen(true); }} className="md:hidden p-2 -ml-1 text-gray-600 dark:text-gray-300"><Menu className="w-5 h-5" /></button>
            <h1 className="text-lg sm:text-xl font-bold truncate">{subjectTitle}</h1>
            <span className="text-xs font-semibold bg-gray-100 dark:bg-gray-800 text-gray-500 px-2 py-0.5 rounded-full">{filteredNotes.length}</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="hidden sm:flex items-center bg-gray-100 dark:bg-[#2C2C2E] p-1 rounded-xl">
              <button onClick={() => setViewMode('grid')} className={`p-1.5 rounded-lg ${viewMode === 'grid' ? 'bg-white dark:bg-[#3A3A3C] text-blue-600 shadow-sm' : 'text-gray-400'}`}><GridIcon className="w-4 h-4" /></button>
              <button onClick={() => setViewMode('list')} className={`p-1.5 rounded-lg ${viewMode === 'list' ? 'bg-white dark:bg-[#3A3A3C] text-blue-600 shadow-sm' : 'text-gray-400'}`}><ListIcon className="w-4 h-4" /></button>
            </div>
            <button onClick={() => p.onCreateNote(selectedSubjectId ?? undefined)} className="flex items-center gap-1.5 bg-gradient-to-r from-blue-600 to-indigo-600 text-white px-3.5 py-2 rounded-xl text-sm font-semibold shadow active:scale-95 transition">
              <Plus className="w-4 h-4" /> <span>New</span>
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-3 sm:p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))]" style={{ touchAction: 'pan-y' }}>
          {filteredNotes.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-gray-400">
              <FileText className="w-12 h-12 stroke-[1.2] mb-3 text-gray-300 dark:text-gray-600" />
              <div className="font-semibold text-sm">No notes</div>
              <p className="text-xs mt-1">Tap “New” to start writing.</p>
            </div>
          ) : viewMode === 'grid' ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 sm:gap-5">
              {filteredNotes.map((note) => {
                const subj = subjects.find((s) => s.id === note.subjectId);
                return (
                  <div key={note.id} onClick={() => p.onOpenNote(note.id)} className="relative bg-[#F9F9FB] dark:bg-[#2C2C2E] border border-gray-200 dark:border-gray-700/60 rounded-2xl hover:shadow-lg transition cursor-pointer flex flex-col">
                    <div className="rounded-t-2xl overflow-hidden border-b border-gray-100 dark:border-gray-800 relative">
                      <NoteThumb note={note} />
                      {subj && <span className="absolute top-2 left-2 text-[10px] font-semibold px-2 py-0.5 rounded-full text-white" style={{ backgroundColor: subj.color }}>{subj.name}</span>}
                    </div>
                    <div className="p-2.5 sm:p-3 flex items-center justify-between">
                      <div className="flex-1 min-w-0 mr-1">
                        {renamingNoteId === note.id ? (
                          <input autoFocus value={renameTitle} onChange={(e) => setRenameTitle(e.target.value)} onBlur={() => saveRename(note.id)} onKeyDown={(e) => e.key === 'Enter' && saveRename(note.id)} onClick={(e) => e.stopPropagation()} className="w-full text-sm font-semibold p-1 bg-white dark:bg-[#3A3A3C] border border-blue-500 rounded select-text" />
                        ) : (
                          <div className="font-semibold text-sm truncate">{note.title}</div>
                        )}
                        <div className="text-[11px] text-gray-400 mt-0.5 flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {new Date(note.updatedAt).toLocaleDateString()} · {note.pages.length}p
                        </div>
                      </div>
                      <div className="relative" onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => { setMoveNoteId(null); setMenuNoteId(menuNoteId === note.id ? null : note.id); }} className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg"><MoreVertical className="w-4 h-4" /></button>
                        {menuNoteId === note.id && <NoteMenu note={note} up />}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="divide-y divide-gray-100 dark:divide-gray-800">
              {filteredNotes.map((note) => (
                <div key={note.id} onClick={() => p.onOpenNote(note.id)} className="py-3 px-3 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-[#2C2C2E] rounded-xl cursor-pointer">
                  <div className="flex items-center gap-3 truncate">
                    <FileText className="w-5 h-5 text-blue-600 flex-shrink-0" />
                    <div className="truncate">
                      <div className="font-semibold text-sm truncate">{note.title}</div>
                      <div className="text-[11px] text-gray-400">{new Date(note.updatedAt).toLocaleString()} · {note.pages.length} pages</div>
                    </div>
                  </div>
                  <div className="relative" onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => { setMoveNoteId(null); setMenuNoteId(menuNoteId === note.id ? null : note.id); }} className="p-1.5 text-gray-400 rounded-lg"><MoreVertical className="w-4 h-4" /></button>
                    {menuNoteId === note.id && <NoteMenu note={note} />}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
};
