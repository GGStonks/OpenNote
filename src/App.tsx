import React, { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { LibraryView } from './components/LibraryView';
import { Editor } from './components/Editor';
import { SettingsModal } from './components/SettingsModal';
import { NoteDocument, SCHEMA_VERSION, Subject, newId } from './types';
import {
  DEFAULT_SUBJECTS, createBlankPage, deleteNote, exportLibrary, getAllNotes, getAllSubjects, importBackup,
  requestPersistentStorage, saveNote, saveSubjects,
} from './storage/db';
import { AppSettings, loadSettings, saveSettings } from './settings';
import { shareFile } from './platform';

export const App: React.FC = () => {
  const [notes, setNotes] = useState<NoteDocument[] | null>(null);
  const [subjects, setSubjects] = useState<Subject[]>(DEFAULT_SUBJECTS);
  const [selectedSubjectId, setSelectedSubjectId] = useState<string | null>(null);
  const [openNoteId, setOpenNoteId] = useState<string | null>(null);
  const [settings, setSettingsState] = useState<AppSettings>(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [n, s] = await Promise.all([getAllNotes(), getAllSubjects()]);
      setNotes(n);
      setSubjects(s);
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

  const upsertLocal = useCallback((n: NoteDocument) => {
    setNotes((prev) => {
      const list = prev ?? [];
      const exists = list.some((x) => x.id === n.id);
      return (exists ? list.map((x) => (x.id === n.id ? n : x)) : [n, ...list]).sort((a, b) => b.updatedAt - a.updatedAt);
    });
  }, []);

  const createNote = async (subjectId?: string) => {
    const now = Date.now();
    const note: NoteDocument = {
      id: newId('note'),
      title: `Note ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
      subjectId: subjectId ?? selectedSubjectId ?? undefined,
      createdAt: now,
      updatedAt: now,
      paperStyle: 'ruled',
      paperColor: 'white',
      schemaVersion: SCHEMA_VERSION,
      pages: [createBlankPage(1)],
      sheets: [{ id: newId('sheet') }],
    };
    upsertLocal(await saveNote(note, false));
    setOpenNoteId(note.id);
  };

  const updateNoteMeta = async (id: string, patch: Partial<NoteDocument>) => {
    const target = notes?.find((n) => n.id === id);
    if (!target) return;
    upsertLocal(await saveNote({ ...target, ...patch }));
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

  const addSubject = async (name: string, color: string) => {
    const next = [...subjects, { id: newId('subj'), name, color }];
    setSubjects(next);
    await saveSubjects(next);
  };

  const deleteSubject = async (id: string) => {
    const next = subjects.filter((s) => s.id !== id);
    setSubjects(next);
    await saveSubjects(next);
    for (const n of notes ?? []) if (n.subjectId === id) await updateNoteMeta(n.id, { subjectId: undefined });
    if (selectedSubjectId === id) setSelectedSubjectId(null);
  };

  const backup = async () => {
    try {
      const data = await exportLibrary();
      await shareFile(`OpenNote-backup-${new Date().toISOString().slice(0, 10)}.opennote`, new Blob([JSON.stringify(data)], { type: 'application/json' }));
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
    return (
      <div className="h-full flex items-center justify-center text-gray-400">
        <Loader2 className="w-6 h-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-[#E5E5EA] dark:bg-[#121214] text-gray-900 dark:text-gray-100 overflow-hidden font-sans">
      {loadError && <div className="bg-red-600 text-white text-xs px-3 py-1.5">Storage error: {loadError}</div>}
      {openNote ? (
        <Editor
          key={openNote.id}
          note={openNote}
          settings={settings}
          setSettings={setSettings}
          onSaved={upsertLocal}
          onBack={() => setOpenNoteId(null)}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      ) : (
        <LibraryView
          notes={notes}
          subjects={subjects}
          selectedSubjectId={selectedSubjectId}
          onSelectSubject={setSelectedSubjectId}
          onOpenNote={setOpenNoteId}
          onCreateNote={createNote}
          onDeleteNote={removeNote}
          onDuplicateNote={duplicateNote}
          onRenameNote={(id, title) => updateNoteMeta(id, { title })}
          onMoveNote={(id, subjectId) => updateNoteMeta(id, { subjectId })}
          onCreateSubject={addSubject}
          onDeleteSubject={deleteSubject}
          onOpenSettings={() => setSettingsOpen(true)}
          onBackup={backup}
          onImport={importFile}
        />
      )}
      <SettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} settings={settings} onSave={setSettings} />
    </div>
  );
};
