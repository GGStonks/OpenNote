import { letterSheetsFor, surfaceFromPages } from '../editor/sheets';
import { packedPoints } from './packedPoints';
import { AudioRecording, Folder, NoteDocument, NotePage, Point, SCHEMA_VERSION, Stroke, Subject, Tag, newId } from '../types';

/**
 * Offline persistence (IndexedDB inside the app's WebView; survives restarts on iOS and Android).
 *
 * v1.0 resolved saveNote() before the transaction committed and never awaited it, so a crash or
 * app switch right after drawing could lose ink. Every write now resolves on transaction
 * completion, and the editor flushes pending saves when the app is backgrounded.
 */

const DB_NAME = 'OpenNote_Database';
const DB_VERSION = 5;
const STORE_NOTES = 'notes';
/** Before v1.13: flat subjects. Read once to turn them into folders, then emptied. */
const STORE_SUBJECTS = 'subjects';
const STORE_FOLDERS = 'folders';
const STORE_TAGS = 'tags';
const STORE_AUDIO = 'audio';
/** Library thumbnails: each note's first-page ink as images (thumbCache.ts), by `noteId|layer`. */
const STORE_THUMBS = 'thumbs';
/** Files pages refer to (imported PDFs: PageSheet.pdf), kept once however many pages and notes show them. */
const STORE_FILES = 'files';

export function createBlankPage(pageNumber: number): NotePage {
  return { id: newId('page'), pageNumber, strokes: [], latexBlocks: [], textBlocks: [], imageBlocks: [] };
}

function welcomeNote(): NoteDocument {
  const now = Date.now();
  return {
    id: 'doc_welcome',
    title: 'Welcome to OpenNote',
    createdAt: now,
    updatedAt: now,
    paperStyle: 'ruled',
    paperColor: 'white',
    schemaVersion: SCHEMA_VERSION,
    sheets: [{ id: newId('sheet') }],
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
              'Draw a shape and hold the pencil still to snap it, then move the pencil to size it. Two fingers scroll and pinch to zoom; pull up past the last page to add a new one.',
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

/**
 * Upgrades notes created by older versions to one surface cut into pages (editor/sheets.ts):
 * v1.6-v1.11 notes already are one surface (US Letter pages are added for its content); older
 * notes and v1.12 development notes have separate pages, put one under the other.
 */
export function migrateNote(n: NoteDocument): NoteDocument {
  // Subjects became top-level folders with the same ids (v1.13).
  if (n.subjectId !== undefined) {
    const { subjectId, ...rest } = n;
    n = { ...rest, folderId: n.folderId ?? subjectId };
  }
  if (n.schemaVersion === SCHEMA_VERSION && n.sheets?.length) return n;
  const clean = (p: NotePage): NotePage => ({
    ...p,
    strokes: (p.strokes ?? []).filter((s) => Array.isArray(s.points)),
    latexBlocks: (p.latexBlocks ?? []).map(({ renderedHtml: _drop, ...b }) => b),
    textBlocks: p.textBlocks ?? [],
    imageBlocks: p.imageBlocks ?? [],
  });
  const base = { ...n, schemaVersion: SCHEMA_VERSION, paperStyle: n.paperStyle ?? 'ruled', paperColor: n.paperColor ?? 'white' } as NoteDocument;
  const source = (n.pages?.length ? n.pages : [createBlankPage(1)]).map(clean);
  if (n.schemaVersion === 3 || n.schemaVersion === SCHEMA_VERSION) {
    const surface = { ...source[0], pageNumber: 1 };
    return { ...base, pages: [surface], sheets: letterSheetsFor(surface) };
  }
  const { surface, sheets } = surfaceFromPages(base, source);
  return { ...base, pages: [surface], sheets };
}

// --- Stored stroke points -------------------------------------------------------------------------

/**
 * A stroke as stored: its points packed in one Float64Array (x, y, pressure, t, alt, az per point;
 * NaN = not set) instead of an object per point. IndexedDB copies the whole note on every save,
 * and a note of a few thousand strokes has hundreds of thousands of points: copying them one object
 * at a time took about a second on a mid-range tablet, between two strokes. A typed array is copied
 * in one block. Float64 keeps every value exactly.
 */
type StoredStroke = Omit<Stroke, 'points'> & { pts: Float64Array };
type StoredPage = Omit<NotePage, 'strokes'> & { strokes: StoredStroke[] };

const PT = 6;
/** Strokes and pages are immutable: each is packed once (and pages whose strokes did not change are reused). */
const packedStrokes = new WeakMap<Stroke, StoredStroke>();
const packedPages = new WeakMap<NotePage, StoredPage>();

function packStroke(s: Stroke): StoredStroke {
  let out = packedStrokes.get(s);
  if (out) return out;
  const { points, ...rest } = s;
  const pts = new Float64Array(points.length * PT);
  points.forEach((p, i) => {
    const o = i * PT;
    pts[o] = p.x;
    pts[o + 1] = p.y;
    pts[o + 2] = p.pressure;
    pts[o + 3] = p.t ?? NaN;
    pts[o + 4] = p.alt ?? NaN;
    pts[o + 5] = p.az ?? NaN;
  });
  out = { ...rest, pts };
  packedStrokes.set(s, out);
  return out;
}

function decodePoints(pts: Float64Array): Point[] {
  const points: Point[] = [];
  for (let o = 0; o + PT <= pts.length; o += PT) {
    const p: Point = { x: pts[o], y: pts[o + 1], pressure: pts[o + 2] };
    if (!Number.isNaN(pts[o + 3])) p.t = pts[o + 3];
    if (!Number.isNaN(pts[o + 4])) p.alt = pts[o + 4];
    if (!Number.isNaN(pts[o + 5])) p.az = pts[o + 5];
    points.push(p);
  }
  return points;
}

/**
 * The stroke with its points made from the packed array the first time they are read. Unpacking
 * every point of every note when the library opened (an object per point, millions in a large
 * library) held the home screen up for seconds; now a note is unpacked when it is opened, and the
 * library only touches what its thumbnails show. Ranges are read from the packed array
 * (packedPoints.ts).
 */
function unpackStroke(s: StoredStroke | Stroke): Stroke {
  if (!('pts' in s) || !(s.pts instanceof Float64Array)) return s as Stroke;
  const { pts, ...rest } = s;
  const out = rest as Stroke;
  const settle = (self: Stroke, points: Point[]) => {
    Object.defineProperty(self, 'points', { value: points, writable: true, enumerable: true, configurable: true });
    return points;
  };
  Object.defineProperty(out, 'points', {
    enumerable: true,
    configurable: true,
    get(this: Stroke) {
      return settle(this, decodePoints(pts));
    },
    set(this: Stroke, v: Point[]) {
      settle(this, v);
    },
  });
  packedStrokes.set(out, s as StoredStroke);
  packedPoints.set(out, pts);
  return out;
}

function packNote(note: NoteDocument): NoteDocument {
  const pages = (note.pages ?? []).map((p) => {
    let out = packedPages.get(p);
    if (!out) {
      out = { ...p, strokes: (p.strokes ?? []).map(packStroke) };
      packedPages.set(p, out);
    }
    return out;
  });
  return { ...note, pages: pages as unknown as NotePage[] };
}

function unpackNote(note: NoteDocument): NoteDocument {
  if (!note.pages?.some((p) => p.strokes?.some((s) => 'pts' in s))) return note;
  return { ...note, pages: note.pages.map((p) => ({ ...p, strokes: (p.strokes ?? []).map(unpackStroke) })) };
}

/** Test hooks (bench/storageRoundtrip.ts). */
export const __storageCodec = { packNote, unpackNote };

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
      if (!db.objectStoreNames.contains(STORE_FOLDERS)) db.createObjectStore(STORE_FOLDERS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_TAGS)) db.createObjectStore(STORE_TAGS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_AUDIO)) {
        const s = db.createObjectStore(STORE_AUDIO, { keyPath: 'id' });
        s.createIndex('noteId', 'noteId');
      }
      if (!db.objectStoreNames.contains(STORE_THUMBS)) {
        const s = db.createObjectStore(STORE_THUMBS, { keyPath: 'id' });
        s.createIndex('noteId', 'noteId');
      }
      if (!db.objectStoreNames.contains(STORE_FILES)) db.createObjectStore(STORE_FILES, { keyPath: 'id' });
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

/**
 * Every stored note, read one at a time with a cursor: getAll() made the browser copy the whole
 * library out of the database in one task (a long freeze of the home screen with large notes);
 * a cursor delivers each note in a task of its own.
 */
function readAllNotes(db: IDBDatabase): Promise<NoteDocument[]> {
  return new Promise((resolve, reject) => {
    const out: NoteDocument[] = [];
    const cursorReq = db.transaction(STORE_NOTES, 'readonly').objectStore(STORE_NOTES).openCursor();
    cursorReq.onerror = () => reject(cursorReq.error);
    cursorReq.onsuccess = () => {
      const c = cursorReq.result;
      if (!c) return resolve(out);
      // Unpacked as it arrives, in the same short task.
      out.push(migrateNote(unpackNote(c.value as NoteDocument)));
      c.continue();
    };
  });
}

export async function getAllNotes(): Promise<NoteDocument[]> {
  const db = await openDb();
  const notes = await readAllNotes(db);
  if (!notes.length) {
    const w = welcomeNote();
    await saveNote(w, false);
    return [w];
  }
  return notes.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveNote(note: NoteDocument, touch = true): Promise<NoteDocument> {
  const updated = touch ? { ...note, updatedAt: Date.now() } : note;
  const db = await openDb();
  const tx = db.transaction(STORE_NOTES, 'readwrite', STRICT);
  tx.objectStore(STORE_NOTES).put(packNote(updated));
  await txDone(tx);
  return updated;
}

export async function deleteNote(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([STORE_NOTES, STORE_AUDIO, STORE_THUMBS], 'readwrite', STRICT);
  tx.objectStore(STORE_NOTES).delete(id);
  for (const store of [STORE_AUDIO, STORE_THUMBS]) {
    const os = tx.objectStore(store);
    const keys = await req(os.index('noteId').getAllKeys(id));
    keys.forEach((k) => os.delete(k));
  }
  await txDone(tx);
}

/** A library thumbnail layer (thumbCache.ts): the ink of one layer of a note's first page, as an image. */
export interface StoredThumb {
  /** `noteId|layerKey|size`. */
  id: string;
  noteId: string;
  /** The note's updatedAt when it was drawn: another means it is out of date. */
  updatedAt: number;
  url: string;
}

export async function getAllThumbs(): Promise<StoredThumb[]> {
  const db = await openDb();
  return (await req(db.transaction(STORE_THUMBS, 'readonly').objectStore(STORE_THUMBS).getAll())) as StoredThumb[];
}

/** Stores a thumbnail layer, replacing the note's out-of-date ones for that layer. */
export async function getThumb(id: string): Promise<StoredThumb | null> {
  const db = await openDb();
  return ((await req(db.transaction(STORE_THUMBS, 'readonly').objectStore(STORE_THUMBS).get(id))) as StoredThumb | undefined) ?? null;
}

export async function putThumb(t: StoredThumb): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_THUMBS, 'readwrite');
  tx.objectStore(STORE_THUMBS).put(t);
  await txDone(tx);
}

async function replaceAll<T>(store: string, items: T[]): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite', STRICT);
  const os = tx.objectStore(store);
  os.clear();
  for (const it of items) os.put(it);
  await txDone(tx);
}

/**
 * The library's folders. The first time v1.13 runs, the subjects of older versions become
 * top-level folders with the same ids (notes keep pointing at them, see migrateNote).
 */
export async function getAllFolders(): Promise<Folder[]> {
  const db = await openDb();
  const tx = db.transaction([STORE_FOLDERS, STORE_SUBJECTS], 'readonly');
  const [folders, subjects] = await Promise.all([
    req(tx.objectStore(STORE_FOLDERS).getAll()) as Promise<Folder[]>,
    req(tx.objectStore(STORE_SUBJECTS).getAll()) as Promise<Subject[]>,
  ]);
  if (!subjects.length) return folders;
  const now = Date.now();
  const merged = [...folders];
  subjects.forEach((s, i) => {
    if (!merged.some((f) => f.id === s.id)) merged.push({ id: s.id, name: s.name, color: s.color, createdAt: now + i });
  });
  await saveFolders(merged);
  await replaceAll<Subject>(STORE_SUBJECTS, []);
  return merged;
}

export const saveFolders = (folders: Folder[]) => replaceAll(STORE_FOLDERS, folders);

export async function getAllTags(): Promise<Tag[]> {
  const db = await openDb();
  return (await req(db.transaction(STORE_TAGS, 'readonly').objectStore(STORE_TAGS).getAll())) as Tag[];
}

export const saveTags = (tags: Tag[]) => replaceAll(STORE_TAGS, tags);

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

// --- Files (imported PDFs) ------------------------------------------------------------------------

/** A file pages refer to (PageSheet.pdf.file). */
export interface StoredFile {
  id: string;
  name: string;
  mime: string;
  bytes: ArrayBuffer;
  /** A protected PDF's password (it is needed every time the PDF is drawn). */
  password?: string;
  createdAt: number;
}

export async function putFile(f: StoredFile): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_FILES, 'readwrite', STRICT);
  tx.objectStore(STORE_FILES).put(f);
  await txDone(tx);
}

export async function getFile(id: string): Promise<StoredFile | null> {
  const db = await openDb();
  return ((await req(db.transaction(STORE_FILES, 'readonly').objectStore(STORE_FILES).get(id))) as StoredFile | undefined) ?? null;
}

/** The files a note's pages refer to. */
export function noteFileIds(n: Pick<NoteDocument, 'sheets'>): string[] {
  return [...new Set((n.sheets ?? []).flatMap((s) => (s.pdf?.file ? [s.pdf.file] : [])))];
}

/**
 * Deletes the files no note refers to any more (after a note is deleted), with their page
 * previews. Notes are read one by one with a cursor, sheets only.
 */
export async function collectUnusedFiles(): Promise<void> {
  const db = await openDb();
  const used = new Set<string>();
  await new Promise<void>((resolve, reject) => {
    const r = db.transaction(STORE_NOTES, 'readonly').objectStore(STORE_NOTES).openCursor();
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const c = r.result;
      if (!c) return resolve();
      for (const id of noteFileIds(c.value as NoteDocument)) used.add(id);
      c.continue();
    };
  });
  const ids = (await req(db.transaction(STORE_FILES, 'readonly').objectStore(STORE_FILES).getAllKeys())) as string[];
  const gone = ids.filter((id) => !used.has(id));
  if (!gone.length) return;
  const tx = db.transaction([STORE_FILES, STORE_THUMBS], 'readwrite');
  for (const id of gone) {
    tx.objectStore(STORE_FILES).delete(id);
    const os = tx.objectStore(STORE_THUMBS);
    for (const k of await req(os.index('noteId').getAllKeys(`file:${id}`))) os.delete(k);
  }
  await txDone(tx);
}

/** A file in a backup or an exported note: its bytes as base64. */
export interface BackupFile {
  id: string;
  name: string;
  mime: string;
  base64: string;
  password?: string;
}

function toBase64(bytes: ArrayBuffer): string {
  const b = new Uint8Array(bytes);
  let out = '';
  for (let i = 0; i < b.length; i += 0x8000) out += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(out);
}

/** The files `notes` refer to, for a backup or an exported note. */
export async function filesForBackup(notes: Pick<NoteDocument, 'sheets'>[]): Promise<BackupFile[]> {
  const out: BackupFile[] = [];
  for (const id of new Set(notes.flatMap(noteFileIds))) {
    const f = await getFile(id);
    if (f) out.push({ id: f.id, name: f.name, mime: f.mime, base64: toBase64(f.bytes), ...(f.password ? { password: f.password } : {}) });
  }
  return out;
}

async function restoreFiles(files: unknown): Promise<void> {
  if (!Array.isArray(files)) return;
  for (const f of files as BackupFile[]) {
    if (!f || typeof f.id !== 'string' || typeof f.base64 !== 'string') continue;
    if (await getFile(f.id)) continue;
    const bin = atob(f.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    await putFile({ id: f.id, name: f.name ?? 'file', mime: f.mime ?? 'application/octet-stream', bytes: bytes.buffer, ...(f.password ? { password: f.password } : {}), createdAt: Date.now() });
  }
}

// --- Backup ---------------------------------------------------------------------------------------

export interface LibraryBackup {
  format: 'opennote-backup';
  /** 1: subjects (before v1.13); 2: folders and tags. */
  version: 1 | 2;
  exportedAt: number;
  subjects?: Subject[];
  folders?: Folder[];
  tags?: Tag[];
  notes: NoteDocument[];
  /** Files the notes' pages refer to (imported PDFs). */
  files?: BackupFile[];
}

export async function exportLibrary(): Promise<LibraryBackup> {
  const notes = await getAllNotes();
  return { format: 'opennote-backup', version: 2, exportedAt: Date.now(), folders: await getAllFolders(), tags: await getAllTags(), notes, files: await filesForBackup(notes) };
}

/** Imports a backup or a single exported note; existing notes with the same id are replaced. */
export async function importBackup(data: unknown): Promise<number> {
  const obj = data as Partial<LibraryBackup> & Partial<NoteDocument> & { files?: BackupFile[] };
  let notes: NoteDocument[] = [];
  // Files first: a note is never saved pointing at a file that is not there.
  await restoreFiles(obj?.files);
  if (obj?.format === 'opennote-backup' && Array.isArray(obj.notes)) {
    notes = obj.notes;
    const now = Date.now();
    const incoming: Folder[] = [
      ...(Array.isArray(obj.folders) ? obj.folders : []),
      ...(Array.isArray(obj.subjects) ? obj.subjects.map((s, i) => ({ id: s.id, name: s.name, color: s.color, createdAt: now + i })) : []),
    ];
    if (incoming.length) {
      const merged = await getAllFolders();
      for (const f of incoming) if (!merged.some((m) => m.id === f.id)) merged.push(f);
      await saveFolders(merged);
    }
    if (Array.isArray(obj.tags) && obj.tags.length) {
      const merged = await getAllTags();
      for (const t of obj.tags) if (!merged.some((m) => m.id === t.id)) merged.push(t);
      await saveTags(merged);
    }
  } else if (obj && Array.isArray(obj.pages) && typeof obj.id === 'string') {
    notes = [obj as NoteDocument];
  } else {
    throw new Error('Not an OpenNote backup or note file');
  }
  for (const n of notes) await saveNote(migrateNote(n), false);
  return notes.length;
}
