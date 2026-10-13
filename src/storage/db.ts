import { mergePages } from '../editor/surface';
import { AudioRecording, NoteDocument, NotePage, SCHEMA_VERSION, Subject, newId } from '../types';

/**
 * Offline persistence (IndexedDB inside the app's WebView; survives restarts on iOS and Android).
 *
 * v1.0 resolved saveNote() before the transaction committed and never awaited it, so a crash or
 * app switch right after drawing could lose ink. Every write now resolves on transaction
 * completion, and the editor flushes pending saves when the app is backgrounded.
 */

const DB_NAME = 'OpenNote_Database';
const DB_VERSION = 2;
const STORE_NOTES = 'notes';
const STORE_SUBJECTS = 'subjects';
const STORE_AUDIO = 'audio';

export const DEFAULT_SUBJECTS: Subject[] = [
  { id: 'subj_math', name: 'Mathematics', color: '#1A73E8' },
  { id: 'subj_physics', name: 'Physics & Eng', color: '#9333EA' },
  { id: 'subj_lectures', name: 'Lecture Notes', color: '#10B981' },
  { id: 'subj_drafts', name: 'Quick Drafts', color: '#F59E0B' },
];

export function createBlankPage(pageNumber: number): NotePage {
  return { id: newId('page'), pageNumber, strokes: [], latexBlocks: [], textBlocks: [], imageBlocks: [] };
}

function welcomeNote(): NoteDocument {
  const now = Date.now();
  return {
    id: 'doc_welcome',
    title: 'Welcome to OpenNote',
    subjectId: 'subj_math',
    createdAt: now,
    updatedAt: now,
    paperStyle: 'ruled',
    paperColor: 'white',
    schemaVersion: SCHEMA_VERSION,
    pages: [
      {
        ...createBlankPage(1),
        textBlocks: [
          {
            id: 'txt_welcome',
            x: 96,
            y: 88,
            width: 620,
            fontSize: 18,
            color: '#111827',
            createdAt: now,
            text:
              'Write with the pen, lasso handwriting and tap “LaTeX” or “TikZ” to transcribe it with your Qwen3-VL server. ' +
              'Draw a shape and hold the pencil still to snap it, then move the pencil to size it. Two fingers scroll; a new page appears as you write.',
          },
        ],
        latexBlocks: [
          {
            id: 'latex_welcome',
            x: 120,
            y: 200,
            width: 420,
            height: 70,
            latexCode: '\\oint_{\\partial \\Sigma} \\mathbf{F} \\cdot d\\mathbf{r} = \\iint_{\\Sigma} (\\nabla \\times \\mathbf{F}) \\cdot d\\mathbf{S}',
            createdAt: now,
          },
        ],
      },
    ],
  };
}

/** Upgrades notes created by older versions (v1.6: pages are merged into one continuous surface). */
export function migrateNote(n: NoteDocument): NoteDocument {
  if (n.schemaVersion === SCHEMA_VERSION) return n;
  return {
    ...n,
    schemaVersion: SCHEMA_VERSION,
    paperStyle: n.paperStyle ?? 'ruled',
    paperColor: n.paperColor ?? 'white',
    pages: [
      mergePages(
        (n.pages?.length ? n.pages : [createBlankPage(1)]).map((p, i) => ({
          ...p,
          pageNumber: i + 1,
          strokes: (p.strokes ?? []).filter((s) => Array.isArray(s.points)),
          latexBlocks: (p.latexBlocks ?? []).map(({ renderedHtml: _drop, ...b }) => b),
          textBlocks: p.textBlocks ?? [],
          imageBlocks: p.imageBlocks ?? [],
        }))
      ),
    ],
  };
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB not supported'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NOTES)) db.createObjectStore(STORE_NOTES, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_SUBJECTS)) db.createObjectStore(STORE_SUBJECTS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_AUDIO)) {
        const s = db.createObjectStore(STORE_AUDIO, { keyPath: 'id' });
        s.createIndex('noteId', 'noteId');
      }
    };
  });
  dbPromise.catch(() => (dbPromise = null));
  return dbPromise;
}

/**
 * Writes are committed to disk before they resolve ('strict' durability; browsers default to a
 * relaxed commit that can be lost when the app is killed right after a save). Each note is one
 * record written in one transaction, so a save is all or nothing.
 */
const STRICT: IDBTransactionOptions = { durability: 'strict' };

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
  });
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** Asks the OS not to evict our storage under pressure (best effort). */
export async function requestPersistentStorage(): Promise<void> {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    /* not supported */
  }
}

export async function getAllNotes(): Promise<NoteDocument[]> {
  const db = await openDb();
  const notes = (await req(db.transaction(STORE_NOTES, 'readonly').objectStore(STORE_NOTES).getAll())) as NoteDocument[];
  if (!notes.length) {
    const w = welcomeNote();
    await saveNote(w, false);
    return [w];
  }
  return notes.map(migrateNote).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveNote(note: NoteDocument, touch = true): Promise<NoteDocument> {
  const updated = touch ? { ...note, updatedAt: Date.now() } : note;
  const db = await openDb();
  const tx = db.transaction(STORE_NOTES, 'readwrite', STRICT);
  tx.objectStore(STORE_NOTES).put(updated);
  await txDone(tx);
  return updated;
}

export async function deleteNote(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([STORE_NOTES, STORE_AUDIO], 'readwrite', STRICT);
  tx.objectStore(STORE_NOTES).delete(id);
  const audio = tx.objectStore(STORE_AUDIO);
  const keys = await req(audio.index('noteId').getAllKeys(id));
  keys.forEach((k) => audio.delete(k));
  await txDone(tx);
}

export async function getAllSubjects(): Promise<Subject[]> {
  const db = await openDb();
  const subjects = (await req(db.transaction(STORE_SUBJECTS, 'readonly').objectStore(STORE_SUBJECTS).getAll())) as Subject[];
  if (!subjects.length) {
    await saveSubjects(DEFAULT_SUBJECTS);
    return DEFAULT_SUBJECTS;
  }
  return subjects;
}

export async function saveSubjects(subjects: Subject[]): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_SUBJECTS, 'readwrite', STRICT);
  const store = tx.objectStore(STORE_SUBJECTS);
  store.clear();
  for (const s of subjects) store.put(s);
  await txDone(tx);
}

// --- Audio recordings ---------------------------------------------------------------------------

interface StoredAudio extends AudioRecording {
  blob: Blob;
}

export async function saveRecording(rec: AudioRecording, blob: Blob): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_AUDIO, 'readwrite', STRICT);
  tx.objectStore(STORE_AUDIO).put({ ...rec, blob } satisfies StoredAudio);
  await txDone(tx);
}

export async function listRecordings(noteId: string): Promise<AudioRecording[]> {
  const db = await openDb();
  const all = (await req(db.transaction(STORE_AUDIO, 'readonly').objectStore(STORE_AUDIO).index('noteId').getAll(noteId))) as StoredAudio[];
  return all.map(({ blob: _b, ...r }) => r).sort((a, b) => a.createdAt - b.createdAt);
}

export async function getRecordingBlob(id: string): Promise<Blob | null> {
  const db = await openDb();
  const rec = (await req(db.transaction(STORE_AUDIO, 'readonly').objectStore(STORE_AUDIO).get(id))) as StoredAudio | undefined;
  return rec?.blob ?? null;
}

export async function deleteRecording(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_AUDIO, 'readwrite');
  tx.objectStore(STORE_AUDIO).delete(id);
  await txDone(tx);
}

// --- Backup ---------------------------------------------------------------------------------------

export interface LibraryBackup {
  format: 'opennote-backup';
  version: 1;
  exportedAt: number;
  subjects: Subject[];
  notes: NoteDocument[];
}

export async function exportLibrary(): Promise<LibraryBackup> {
  return { format: 'opennote-backup', version: 1, exportedAt: Date.now(), subjects: await getAllSubjects(), notes: await getAllNotes() };
}

/** Imports a backup or a single exported note; existing notes with the same id are replaced. */
export async function importBackup(data: unknown): Promise<number> {
  const obj = data as Partial<LibraryBackup> & Partial<NoteDocument>;
  let notes: NoteDocument[] = [];
  if (obj?.format === 'opennote-backup' && Array.isArray(obj.notes)) {
    notes = obj.notes;
    if (Array.isArray(obj.subjects)) {
      const existing = await getAllSubjects();
      const merged = [...existing];
      for (const s of obj.subjects) if (!merged.some((m) => m.id === s.id)) merged.push(s);
      await saveSubjects(merged);
    }
  } else if (obj && Array.isArray(obj.pages) && typeof obj.id === 'string') {
    notes = [obj as NoteDocument];
  } else {
    throw new Error('Not an OpenNote backup or note file');
  }
  for (const n of notes) await saveNote(migrateNote(n), false);
  return notes.length;
}
