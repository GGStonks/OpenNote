import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { LibraryView } from './components/LibraryView';
import { Editor } from './components/Editor';
import { SettingsModal } from './components/SettingsModal';
import { Folder, NoteDocument, NotePage, PAGE_HEIGHT, PAGE_WIDTH, SCHEMA_VERSION, Tag, newId } from './types';
import {
  createBlankPage, deleteNote, exportLibrary, getAllFolders, getAllNotes, getAllTags, importBackup,
  requestPersistentStorage, saveFolders, saveNote, saveTags,
} from './storage/db';
import { AppSettings, loadSettings, saveSettings } from './settings';
import { UpdatePrompt } from './components/UpdatePrompt';
import { ExportMode, exportFile, setLaunchTheme } from './platform';
import { THEMES, applyTheme } from './theme';
import { Logo } from './components/Logo';
import { folderAndDescendants } from './library';
import { importNotability } from './import/notability';
import { crashLog } from './services/crashLog';
import { startCutoutClearance } from './services/cutout';
import { startFrameRate } from './services/frameRate';
import { ErrorBoundary } from './components/ErrorBoundary';

/** Reads an image file, scaled down to at most 1600 px, as a data URL with its size. */
function readImage(file: File): Promise<{ dataUrl: string; w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error(`${file.name} is not a readable image`));
      img.onload = () => {
        const s = Math.min(1, 1600 / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * s);
        c.height = Math.round(img.height * s);
        c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
        resolve({ dataUrl: c.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.88), w: c.width, h: c.height });
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

export const App: React.FC = () => {
  const [notes, setNotes] = useState<NoteDocument[] | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [openNoteId, setOpenNoteId] = useState<string | null>(null);
  const [settings, setSettingsState] = useState<AppSettings>(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** The latest notes, also between renders (several quick edits of one note must build on each other). */
  const notesRef = useRef(notes);
  notesRef.current = notes;

  const reload = useCallback(async () => {
    try {
      const [f, t] = await Promise.all([getAllFolders(), getAllTags()]);
      setFolders(f);
      setTags(t);
      setNotes(await getAllNotes());
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
      setNotes([]);
    }
  }, []);

  useEffect(() => {
    void requestPersistentStorage();
    void reload();
  }, [reload]);

  const setSettings = useCallback((s: AppSettings) => {
    saveSettings(s);
    setSettingsState(s);
  }, []);

  useEffect(() => {
    applyTheme(settings.theme);
    const t = THEMES[settings.theme] ?? THEMES.light;
    void setLaunchTheme(settings.theme, t.ui.app, t.dark).catch((err) => crashLog.event('launch-theme-failed', { error: String(err?.message ?? err).slice(0, 200) }));
  }, [settings.theme]);
  useEffect(() => {
    startCutoutClearance();
    crashLog.start();
    startFrameRate();
  }, []);
  useEffect(() => crashLog.set('note', openNoteId ? 'open' : 'library'), [openNoteId]);

  const upsertLocal = useCallback((n: NoteDocument) => {
    setNotes((prev) => {
      const list = prev ?? [];
      const exists = list.some((x) => x.id === n.id);
      return (exists ? list.map((x) => (x.id === n.id ? n : x)) : [n, ...list]).sort((a, b) => b.updatedAt - a.updatedAt);
    });
  }, []);

  const blankNote = (title: string, page?: Partial<NotePage>): NoteDocument => {
    const now = Date.now();
    return {
      id: newId('note'),
      title,
      folderId: selectedFolderId ?? undefined,
      tagIds: [],
      createdAt: now,
      updatedAt: now,
      paperStyle: 'ruled',
      paperColor: 'white',
      schemaVersion: SCHEMA_VERSION,
      pages: [{ ...createBlankPage(1), ...page }],
      sheets: [{ id: newId('sheet') }],
    };
  };

  const createNote = async () => {
    const note = blankNote('Untitled note');
    upsertLocal(await saveNote(note, false));
    setOpenNoteId(note.id);
  };

  /** Changes a note's details; `touch` also marks it modified (renaming does, moving and tagging do not). */
  const updateNoteMeta = async (id: string, patch: Partial<NoteDocument> | ((n: NoteDocument) => Partial<NoteDocument>), touch = true) => {
    const target = notesRef.current?.find((n) => n.id === id);
    if (!target) return;
    const next = { ...target, ...(typeof patch === 'function' ? patch(target) : patch) };
    notesRef.current = (notesRef.current ?? []).map((n) => (n.id === id ? next : n));
    upsertLocal(next);
    upsertLocal(await saveNote(next, touch));
  };

  const duplicateNote = async (id: string) => {
    const src = notes?.find((n) => n.id === id);
    if (!src) return;
    const now = Date.now();
    upsertLocal(await saveNote({ ...structuredClone(src), id: newId('note'), title: `${src.title} (copy)`, createdAt: now, updatedAt: now }, false));
  };

  const removeNote = async (id: string) => {
    await deleteNote(id);
    setNotes((prev) => (prev ?? []).filter((n) => n.id !== id));
  };

  // --- Folders -------------------------------------------------------------------------------

  const commitFolders = async (next: Folder[]) => {
    setFolders(next);
    await saveFolders(next);
  };

  const createFolder = async (name: string, parentId: string | undefined, color: string) => {
    const f: Folder = { id: newId('folder'), name, parentId, color, createdAt: Date.now() };
    await commitFolders([...folders, f]);
    return f;
  };

  const updateFolder = (id: string, patch: Partial<Pick<Folder, 'name' | 'color'>>) => commitFolders(folders.map((f) => (f.id === id ? { ...f, ...patch } : f)));

  /** Moves a folder (with everything in it) under another folder or to the top level; never into itself. */
  const moveFolder = async (id: string, parentId: string | undefined) => {
    if (parentId && folderAndDescendants(folders, id).has(parentId)) return;
    await commitFolders(folders.map((f) => (f.id === id ? { ...f, parentId } : f)));
  };

  /** Deletes a folder; its notes and subfolders move up to its parent folder (nothing is lost). */
  const deleteFolder = async (id: string) => {
    const gone = folders.find((f) => f.id === id);
    if (!gone) return;
    await commitFolders(folders.filter((f) => f.id !== id).map((f) => (f.parentId === id ? { ...f, parentId: gone.parentId } : f)));
    for (const n of notesRef.current ?? []) if (n.folderId === id) await updateNoteMeta(n.id, { folderId: gone.parentId }, false);
    if (selectedFolderId === id) setSelectedFolderId(gone.parentId ?? null);
  };

  // --- Tags ----------------------------------------------------------------------------------

  const createTag = async (name: string, color: string) => {
    const t: Tag = { id: newId('tag'), name, color };
    const next = [...tags, t];
    setTags(next);
    await saveTags(next);
    return t;
  };

  const updateTag = async (id: string, patch: Partial<Omit<Tag, 'id'>>) => {
    const next = tags.map((t) => (t.id === id ? { ...t, ...patch } : t));
    setTags(next);
    await saveTags(next);
  };

  const deleteTag = async (id: string) => {
    const next = tags.filter((t) => t.id !== id);
    setTags(next);
    await saveTags(next);
    for (const n of notesRef.current ?? []) if (n.tagIds?.includes(id)) await updateNoteMeta(n.id, (cur) => ({ tagIds: (cur.tagIds ?? []).filter((t) => t !== id) }), false);
  };

  /** Imports files from outside: .opennote notes / backups, Notability notes, images and text files (each a new note). */
  const importExternal = async (files: File[]) => {
    let made = 0;
    const failed: string[] = [];
    const partial: string[] = [];
    let last: NoteDocument | null = null;
    for (const file of files) {
      const name = file.name.replace(/\.[^.]+$/, '') || 'Imported';
      try {
        if (/\.note$/i.test(file.name)) {
          const nb = await importNotability(new Uint8Array(await file.arrayBuffer()), file.name, (blob) => readImage(new File([blob], 'image', { type: blob.type })));
          const now = Date.now();
          last = {
            ...blankNote(nb.title),
            createdAt: nb.createdAt,
            updatedAt: now,
            paperStyle: 'blank',
            ...(nb.pageSize !== 'letter' ? { pageSize: nb.pageSize } : {}),
            pages: [nb.surface],
            sheets: nb.sheets,
          };
          upsertLocal(await saveNote(last, false));
          made++;
          if (nb.skipped.length) partial.push(`${file.name}: ${nb.skipped.join(', ')}`);
        } else if (/\.(opennote|json)$/i.test(file.name) || file.type === 'application/json') {
          made += await importBackup(JSON.parse(await file.text()));
        } else if (file.type.startsWith('image/')) {
          const img = await readImage(file);
          const w = Math.min(PAGE_WIDTH - 160, img.w, ((PAGE_HEIGHT - 160) * img.w) / img.h);
          const h = (w * img.h) / img.w;
          last = blankNote(name, { imageBlocks: [{ id: newId('image'), x: (PAGE_WIDTH - w) / 2, y: 80, width: w, height: h, dataUrl: img.dataUrl, createdAt: Date.now() }] });
          upsertLocal(await saveNote(last, false));
          made++;
        } else if (/^text\//.test(file.type) || /\.(txt|md|tex)$/i.test(file.name)) {
          last = blankNote(name, { textBlocks: [{ id: newId('text'), x: 96, y: 88, width: PAGE_WIDTH - 192, text: await file.text(), fontSize: 16, color: '#111827', createdAt: Date.now() }] });
          upsertLocal(await saveNote(last, false));
          made++;
        } else {
          failed.push(file.name);
        }
      } catch (err) {
        failed.push(`${file.name} (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    await reload();
    const notImported = partial.length ? `\nLeft out:\n${partial.join('\n')}` : '';
    if (failed.length) window.alert(`Imported ${made} note${made === 1 ? '' : 's'}.\nNot imported: ${failed.join(', ')}\nSupported: .opennote, Notability .note, images, .txt / .md / .tex.${notImported}`);
    else if (partial.length) window.alert(`Imported ${made} note${made === 1 ? '' : 's'}.${notImported}`);
    if (!failed.length && files.length === 1 && last) setOpenNoteId(last.id);
    else if (!failed.length && !partial.length) window.alert(`Imported ${made} note${made === 1 ? '' : 's'}.`);
  };

  const backup = async (mode?: ExportMode) => {
    try {
      const data = await exportLibrary();
      const where = await exportFile(`OpenNote-backup-${new Date().toISOString().slice(0, 10)}.opennote`, new Blob([JSON.stringify(data)], { type: 'application/json' }), mode);
      if (where) window.alert(`Backup: ${where}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/cancel/i.test(msg)) window.alert(`Backup failed: ${msg}`);
    }
  };

  const importFile = async (file: File) => {
    try {
      const count = await importBackup(JSON.parse(await file.text()));
      await reload();
      window.alert(`Imported ${count} note${count === 1 ? '' : 's'}.`);
    } catch (err) {
      window.alert(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const openNote = notes?.find((n) => n.id === openNoteId) ?? null;

  if (notes === null) {
    // The start-up logo, where and as large as the launch screens draw it (index.html, Android's
    // launch_icon.xml: 128 px in the middle of the screen), with the spinner below it.
    return (
      <div className="h-full flex items-center justify-center text-gray-400 relative">
        <Logo size={128} />
        <Loader2 className="w-6 h-6 animate-spin absolute left-1/2 top-[calc(50%+88px)] -translate-x-1/2" />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-ui-desk dark:bg-ui-app text-gray-900 dark:text-gray-100 overflow-hidden font-sans">
      {loadError && <div className="bg-red-600 text-white text-xs px-3 py-1.5">Storage error: {loadError}</div>}
      {openNote ? (
        <ErrorBoundary key={openNote.id} onBack={() => setOpenNoteId(null)}>
          <Editor
            note={openNote}
            settings={settings}
            setSettings={setSettings}
            onSaved={upsertLocal}
            onBack={() => setOpenNoteId(null)}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        </ErrorBoundary>
      ) : (
        <LibraryView
          notes={notes}
          folders={folders}
          tags={tags}
          selectedFolderId={selectedFolderId}
          onSelectFolder={setSelectedFolderId}
          onOpenNote={setOpenNoteId}
          onCreateNote={createNote}
          onDeleteNote={removeNote}
          onDuplicateNote={duplicateNote}
          onRenameNote={(id, title) => updateNoteMeta(id, { title })}
          onMoveNote={(id, folderId) => updateNoteMeta(id, { folderId }, false)}
          onSetNoteTags={(id, update) => updateNoteMeta(id, (n) => ({ tagIds: update(n.tagIds ?? []) }), false)}
          onCreateFolder={createFolder}
          onUpdateFolder={updateFolder}
          onMoveFolder={moveFolder}
          onDeleteFolder={deleteFolder}
          onCreateTag={createTag}
          onUpdateTag={updateTag}
          onDeleteTag={deleteTag}
          onOpenSettings={() => setSettingsOpen(true)}
          onImportFiles={importExternal}
        />
      )}
      <SettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} settings={settings} onSave={setSettings} onBackup={backup} onImport={importFile} />
      <UpdatePrompt enabled={settings.checkUpdates} />
    </div>
  );
};
