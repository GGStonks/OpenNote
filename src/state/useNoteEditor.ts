import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NoteDocument, NotePage } from '../types';
import { saveNote } from '../storage/db';

/**
 * Note editing state: immutable document + undo/redo with structural sharing (no JSON deep
 * copies), gesture transactions (a whole drag/erase = one undo step, no history entry or DB write
 * per pointermove) and debounced autosave that is flushed when the app goes to background.
 */

const HISTORY_LIMIT = 200;
const SAVE_DELAY_MS = 700;
/** While the pen is on the page the save waits (copying a long note into IndexedDB takes a frame or more). */
const BUSY_RETRY_MS = 250;
/** ... but never longer than this after the first unsaved change. */
const MAX_SAVE_DELAY_MS = 5000;

export type PageUpdater = (page: NotePage) => NotePage;

/** The page-level operations; a stable object, so memoised pages do not re-render on every edit. */
export interface PageOps {
  commitPage: (pageId: string, updater: PageUpdater) => void;
  beginGesture: () => void;
  previewPage: (pageId: string, updater: PageUpdater) => void;
  endGesture: () => void;
  /** Ends a gesture leaving no trace: the document goes back to how it was before it began. */
  cancelGesture: () => void;
  silentPage: (pageId: string, updater: PageUpdater) => void;
}

/**
 * What made the latest change of the document: an edit ('commit'), a gesture in progress
 * ('gesture'), undo / redo ('history') or non-undoable bookkeeping ('silent').
 */
export type ChangeKind = 'commit' | 'gesture' | 'history' | 'silent';

export interface NoteEditor {
  doc: NoteDocument;
  ops: PageOps;
  canUndo: boolean;
  canRedo: boolean;
  /** One undoable change. */
  commit: (updater: (d: NoteDocument) => NoteDocument) => void;
  commitPage: (pageId: string, updater: PageUpdater) => void;
  /** Start of a continuous gesture (drag, erase, scale); changes until endGesture are one undo step. */
  beginGesture: () => void;
  previewPage: (pageId: string, updater: PageUpdater) => void;
  endGesture: () => void;
  cancelGesture: () => void;
  /** What made the current document (see ChangeKind). */
  lastChange: () => ChangeKind;
  /** Non-undoable bookkeeping (render caches, measured sizes). */
  silentPage: (pageId: string, updater: PageUpdater) => void;
  /** Non-undoable change of the whole document (e.g. the automatic blank page at the end). */
  silent: (updater: (d: NoteDocument) => NoteDocument) => void;
  undo: () => void;
  redo: () => void;
  flush: () => Promise<void>;
}

function mapPage(d: NoteDocument, pageId: string, updater: PageUpdater): NoteDocument {
  let changed = false;
  const pages = d.pages.map((p) => {
    if (p.id !== pageId) return p;
    const np = updater(p);
    if (np !== p) changed = true;
    return np;
  });
  return changed ? { ...d, pages } : d;
}

export function useNoteEditor(initial: NoteDocument, onSaved: (d: NoteDocument) => void, isBusy?: () => boolean): NoteEditor {
  const [doc, setDocState] = useState(initial);
  const docRef = useRef(initial);
  const undoStack = useRef<NoteDocument[]>([]);
  const redoStack = useRef<NoteDocument[]>([]);
  const gestureBase = useRef<NoteDocument | null>(null);
  const [, setHistoryVersion] = useState(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  /** Saves run one after another, so an older version can never be written after a newer one. */
  const saving = useRef<Promise<void>>(Promise.resolve());
  const dirtySince = useRef(0);
  const isBusyRef = useRef(isBusy);
  isBusyRef.current = isBusy;
  const changeKind = useRef<ChangeKind>('silent');
  const lastChange = useCallback(() => changeKind.current, []);

  const flush = useCallback(async () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const run = saving.current.then(async () => {
      if (!dirty.current) return;
      dirty.current = false;
      const snapshot = docRef.current;
      try {
        const saved = await saveNote(snapshot);
        onSavedRef.current(saved);
      } catch (err) {
        dirty.current = true;
        console.error('OpenNote: saving failed', err);
      }
    });
    saving.current = run;
    await run;
  }, []);

  const scheduleSave = useCallback(() => {
    if (!dirty.current) dirtySince.current = performance.now();
    dirty.current = true;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const tick = () => {
      saveTimer.current = null;
      if (isBusyRef.current?.() && performance.now() - dirtySince.current < MAX_SAVE_DELAY_MS) {
        saveTimer.current = setTimeout(tick, BUSY_RETRY_MS);
        return;
      }
      void flush();
    };
    saveTimer.current = setTimeout(tick, SAVE_DELAY_MS);
  }, [flush]);

  const setDoc = useCallback((next: NoteDocument) => {
    docRef.current = next;
    setDocState(next);
  }, []);

  const pushUndo = (snapshot: NoteDocument) => {
    undoStack.current.push(snapshot);
    if (undoStack.current.length > HISTORY_LIMIT) undoStack.current.shift();
    redoStack.current = [];
    setHistoryVersion((v) => v + 1);
  };

  const commit = useCallback(
    (updater: (d: NoteDocument) => NoteDocument) => {
      const prev = docRef.current;
      const next = updater(prev);
      if (next === prev) return;
      if (!gestureBase.current) pushUndo(prev);
      changeKind.current = gestureBase.current ? 'gesture' : 'commit';
      setDoc(next);
      scheduleSave();
    },
    [scheduleSave, setDoc]
  );

  const commitPage = useCallback((pageId: string, updater: PageUpdater) => commit((d) => mapPage(d, pageId, updater)), [commit]);

  const beginGesture = useCallback(() => {
    if (!gestureBase.current) gestureBase.current = docRef.current;
  }, []);

  const previewPage = useCallback(
    (pageId: string, updater: PageUpdater) => {
      const next = mapPage(docRef.current, pageId, updater);
      if (next === docRef.current) return;
      changeKind.current = 'gesture';
      setDoc(next);
    },
    [setDoc]
  );

  const endGesture = useCallback(() => {
    const base = gestureBase.current;
    gestureBase.current = null;
    if (base && base !== docRef.current) {
      pushUndo(base);
      scheduleSave();
    }
  }, [scheduleSave]);

  const cancelGesture = useCallback(() => {
    const base = gestureBase.current;
    gestureBase.current = null;
    if (base && base !== docRef.current) {
      changeKind.current = 'history';
      setDoc(base);
    }
  }, [setDoc]);

  const silentPage = useCallback(
    (pageId: string, updater: PageUpdater) => {
      const next = mapPage(docRef.current, pageId, updater);
      if (next === docRef.current) return;
      // Keep the cache in history snapshots too, so undo does not throw it away.
      const patch = (d: NoteDocument) => mapPage(d, pageId, updater);
      undoStack.current = undoStack.current.map((d) => (d.pages.some((p) => p.id === pageId) ? patch(d) : d));
      if (gestureBase.current) gestureBase.current = patch(gestureBase.current);
      changeKind.current = 'silent';
      setDoc(next);
      scheduleSave();
    },
    [scheduleSave, setDoc]
  );

  const silent = useCallback(
    (updater: (d: NoteDocument) => NoteDocument) => {
      const next = updater(docRef.current);
      if (next === docRef.current) return;
      changeKind.current = 'silent';
      setDoc(next);
      scheduleSave();
    },
    [scheduleSave, setDoc]
  );

  const undo = useCallback(() => {
    const prev = undoStack.current.pop();
    if (!prev) return;
    redoStack.current.push(docRef.current);
    changeKind.current = 'history';
    setDoc(prev);
    setHistoryVersion((v) => v + 1);
    scheduleSave();
  }, [scheduleSave, setDoc]);

  const redo = useCallback(() => {
    const next = redoStack.current.pop();
    if (!next) return;
    undoStack.current.push(docRef.current);
    changeKind.current = 'history';
    setDoc(next);
    setHistoryVersion((v) => v + 1);
    scheduleSave();
  }, [scheduleSave, setDoc]);

  // Flush on background / close; flush on unmount.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') void flush();
    };
    const onPageHide = () => void flush();
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onPageHide);
      void flush();
    };
  }, [flush]);

  const ops = useMemo<PageOps>(
    () => ({ commitPage, beginGesture, previewPage, endGesture, cancelGesture, silentPage }),
    [commitPage, beginGesture, previewPage, endGesture, cancelGesture, silentPage]
  );

  return {
    doc,
    ops,
    canUndo: undoStack.current.length > 0,
    canRedo: redoStack.current.length > 0,
    commit,
    commitPage,
    beginGesture,
    previewPage,
    endGesture,
    cancelGesture,
    lastChange,
    silentPage,
    silent,
    undo,
    redo,
    flush,
  };
}
