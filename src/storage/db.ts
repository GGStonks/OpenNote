import { NoteDocument, Subject } from '../types';

const DB_NAME = 'OpenNote_Database';
const DB_VERSION = 1;
const STORE_NOTES = 'notes';
const STORE_SUBJECTS = 'subjects';

export const DEFAULT_SUBJECTS: Subject[] = [
  { id: 'subj_math', name: 'Mathematics', color: '#1A73E8' },
  { id: 'subj_physics', name: 'Physics & Eng', color: '#9333EA' },
  { id: 'subj_lectures', name: 'Lecture Notes', color: '#10B981' },
  { id: 'subj_drafts', name: 'Quick Drafts', color: '#F59E0B' },
];

export const INITIAL_SAMPLE_NOTE: NoteDocument = {
  id: 'doc_welcome',
  title: 'Calculus III - Vector Calculus & Stokes Theorem',
  subjectId: 'subj_math',
  createdAt: Date.now() - 3600000,
  updatedAt: Date.now(),
  paperStyle: 'ruled',
  paperColor: 'white',
  pages: [
    {
      id: 'page_1',
      pageNumber: 1,
      strokes: [],
      latexBlocks: [
        {
          id: 'latex_init_1',
          x: 120,
          y: 80,
          width: 380,
          height: 80,
          latexCode: '\\oint_{\\partial \\Sigma} \\mathbf{F} \\cdot d\\mathbf{r} = \\iint_{\\Sigma} (\\nabla \\times \\mathbf{F}) \\cdot d\\mathbf{S}',
          createdAt: Date.now()
        }
      ]
    }
  ]
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB not supported'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NOTES)) {
        db.createObjectStore(STORE_NOTES, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_SUBJECTS)) {
        db.createObjectStore(STORE_SUBJECTS, { keyPath: 'id' });
      }
    };
  });
}

export async function getAllNotes(): Promise<NoteDocument[]> {
  try {
    const db = await openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NOTES, 'readonly');
      const store = tx.objectStore(STORE_NOTES);
      const req = store.getAll();
      req.onsuccess = () => {
        const notes = req.result as NoteDocument[];
        if (!notes || notes.length === 0) {
          // Initialize with sample note if empty
          saveNote(INITIAL_SAMPLE_NOTE).then(() => resolve([INITIAL_SAMPLE_NOTE]));
        } else {
          resolve(notes.sort((a, b) => b.updatedAt - a.updatedAt));
        }
      };
      req.onerror = () => {
        // Fallback to localStorage
        const stored = localStorage.getItem('opennote_notes');
        resolve(stored ? JSON.parse(stored) : [INITIAL_SAMPLE_NOTE]);
      };
    });
  } catch (err) {
    const stored = localStorage.getItem('opennote_notes');
    return stored ? JSON.parse(stored) : [INITIAL_SAMPLE_NOTE];
  }
}

export async function getNoteById(id: string): Promise<NoteDocument | null> {
  try {
    const db = await openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NOTES, 'readonly');
      const store = tx.objectStore(STORE_NOTES);
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    const notes = await getAllNotes();
    return notes.find(n => n.id === id) || null;
  }
}

export async function saveNote(note: NoteDocument): Promise<void> {
  const updated = { ...note, updatedAt: Date.now() };
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_NOTES, 'readwrite');
    const store = tx.objectStore(STORE_NOTES);
    store.put(updated);
  } catch {
    // LocalStorage fallback
    const notes = await getAllNotes();
    const idx = notes.findIndex(n => n.id === note.id);
    if (idx >= 0) notes[idx] = updated;
    else notes.unshift(updated);
    localStorage.setItem('opennote_notes', JSON.stringify(notes));
  }
}

export async function deleteNote(id: string): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_NOTES, 'readwrite');
    const store = tx.objectStore(STORE_NOTES);
    store.delete(id);
  } catch {
    const notes = await getAllNotes();
    const filtered = notes.filter(n => n.id !== id);
    localStorage.setItem('opennote_notes', JSON.stringify(filtered));
  }
}

export async function getAllSubjects(): Promise<Subject[]> {
  try {
    const db = await openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_SUBJECTS, 'readonly');
      const store = tx.objectStore(STORE_SUBJECTS);
      const req = store.getAll();
      req.onsuccess = () => {
        const subjs = req.result as Subject[];
        if (!subjs || subjs.length === 0) {
          saveSubjects(DEFAULT_SUBJECTS).then(() => resolve(DEFAULT_SUBJECTS));
        } else {
          resolve(subjs);
        }
      };
      req.onerror = () => resolve(DEFAULT_SUBJECTS);
    });
  } catch {
    return DEFAULT_SUBJECTS;
  }
}

export async function saveSubjects(subjects: Subject[]): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_SUBJECTS, 'readwrite');
    const store = tx.objectStore(STORE_SUBJECTS);
    store.clear();
    for (const s of subjects) {
      store.put(s);
    }
  } catch {
    localStorage.setItem('opennote_subjects', JSON.stringify(subjects));
  }
}
