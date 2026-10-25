import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import {
  Sparkles, Share2, Shapes, Copy, Trash2, X, Wand2, FileText, Loader2, AlertCircle, PaintBucket, MoveUpRight, Scissors, ClipboardCopy,
  ClipboardPaste, CopyPlus, Plus, Minus, Maximize, MoveHorizontal,
} from 'lucide-react';
import { copySelection, pasteClipboard, useClipboard } from '../editor/clipboard';
import { FillType, LatexBlock, NoteDocument, NotePage, Rect, Stroke, newId, LineStyle } from '../types';
import { markMoved } from '../ink/strokeRenderer';
import { useNoteEditor } from '../state/useNoteEditor';
import { CanvasPage, ToolSettings } from './CanvasPage';
import { Toolbar } from './Toolbar';
import { LatexModal, LatexModalState } from './LatexModal';
import { ExportModal, baseName } from './ExportModal';
import { TextFormatBar } from './TextFormatBar';
import { AudioRecorder } from './AudioRecorder';
import { GestureBus } from '../editor/gestures';
import { MAX_ZOOM, PULL_THRESHOLD, useViewport } from '../editor/useViewport';
import { Selection, computeBounds, isEmptySelection, removeSelection } from '../editor/selection';
import { AppSettings, saveSettings } from '../settings';
import { ConversionMode, convertImage } from '../services/vlmService';
import { crashLog } from '../services/crashLog';
import { boundsOfStrokes, renderInkImage } from '../services/rasterize';
import { restamp } from '../editor/zorder';
import { DEFAULT_INKS, InkColorInfo, colorHint, enforceColors, inkColors } from '../services/inkColors';
import { renderLatexContent } from '../services/latexRender';
import { TikzLabel, convertStrokesToTikz, snapStroke } from '../services/shapeRecognition';
import { FILL_OPTIONS, FillSwatch } from './Toolbar';
import { SetupPatch } from '../editor/pageSetup';
import {
  appendBlankSheet, copySheets, deleteSheets, duplicateSheets, moveSheets, pasteSheets, printedSheets, setNotePaper, setSheetsSetup, trailingSheetFor,
  sheetIndexAt, sheetSlice, sheetStrokes, surfaceLayout, usePageClipboard,
} from '../editor/sheets';
import { PageManager } from './PageManager';
import { canMakePdf, haptic, pdfOfPrintLayout, printDocument, exportFile } from '../platform';
import { joinPdfPages } from '../services/pdfExport';

/** Margin around the surface (content px). */
const PAD = 8;
/** Space below the last page for the "pull to add a page" hint. */
const TAIL = 88;
const PAGES_KEY = 'opennote_pages_panel';

/** Pull indicator below the note: grows with the pull; at the threshold a page is added. */
const PullIndicator: React.FC<{ bind: (set: (d: number) => void) => void }> = ({ bind }) => {
  const [d, setD] = useState(0);
  useEffect(() => bind(setD), [bind]);
  if (d <= 0) return null;
  const k = Math.min(1, d / PULL_THRESHOLD);
  return (
    <div className="absolute left-0 right-0 bottom-0 z-20 flex items-center justify-center pointer-events-none" style={{ height: d }}>
      <div className="flex items-center gap-2.5 px-3.5 py-2 rounded-full bg-ui-bar/90 text-white text-xs font-semibold shadow-xl" style={{ opacity: Math.min(1, d / 30), transform: `scale(${0.85 + 0.15 * k})` }}>
        <svg width="22" height="22" viewBox="0 0 22 22">
          <circle cx="11" cy="11" r="9" fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="2.5" />
          <circle cx="11" cy="11" r="9" fill="none" stroke="#3B82F6" strokeWidth="2.5" strokeLinecap="round" strokeDasharray={`${k * 56.5} 56.5`} transform="rotate(-90 11 11)" />
          <path d="M11 7v8M7 11h8" stroke="white" strokeWidth="2" strokeLinecap="round" />
        </svg>
        {k < 1 ? 'Keep pulling to add a page' : 'New page'}
      </div>
    </div>
  );
};

interface EditorProps {
  note: NoteDocument;
  settings: AppSettings;
  setSettings: (s: AppSettings) => void;
  onSaved: (n: NoteDocument) => void;
  onBack: () => void;
  onOpenSettings: () => void;
}

type ConvTarget =
  | {
      kind: 'insert'; pageId: string; bounds: Rect; strokeIds: string[]; textIds: string[]; latexIds?: string[]; mode: ConversionMode; image: string; hint?: string;
      /** Ink colours of the handwriting (math / notes): kept in the LaTeX (inkColors.ts). */
      colors?: InkColorInfo;
    }
  | { kind: 'edit'; pageId: string; blockId: string }
  | { kind: 'new'; pageId: string; at: { x: number; y: number } };

const TOOL_KEY = 'opennote_tools_v2';
const PILL = 'flex items-center gap-1.5 px-3.5 py-2.5 rounded-2xl whitespace-nowrap flex-shrink-0 active:scale-95 transition';
const ICON_BTN = 'w-11 h-11 flex items-center justify-center rounded-2xl hover:bg-white/10 flex-shrink-0 active:scale-95 transition';
/** Characters of shape geometry sent along with a TikZ conversion (~1k tokens). */
const MAX_TIKZ_HINT = 4000;

/** A freehand loop whose ends (almost) meet can be closed and filled. */
function canClose(s: Stroke): boolean {
  const pts = s.points;
  if (pts.length < 4) return false;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const diag = Math.hypot(maxX - minX, maxY - minY);
  const gap = Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y);
  return diag > 10 && gap < Math.max(14, diag * 0.2);
}

function loadToolPrefs(settings: AppSettings): ToolSettings {
  const base: ToolSettings = {
    tool: 'pen',
    penColor: '#111827',
    shapeColor: '#111827',
    penWidth: 2,
    shapeWidth: 2,
    penStyle: settings.penStyle,
    highlighterColor: '#FDE047',
    highlighterWidth: 4,
    highlighterOpacity: 0.35,
    eraserMode: settings.eraserMode,
    eraserSize: 14,
    stylusOnly: settings.stylusOnly,
    holdToSnap: settings.holdToSnap,
    shapeMode: 'curve',
    shapeFill: 'none',
    shapeArrow: false,
    shapeLineStyle: 'solid',
    shapeSnap: true,
    shapeGridSnap: true,
  };
  try {
    const raw = localStorage.getItem(TOOL_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      // Before v1.11 the Draw tool used the pen's colour: it starts from that colour.
      if (!saved.shapeColor && saved.penColor) saved.shapeColor = saved.penColor;
      // Before v2.4.0 the Draw tool used the pen's width: it starts from that width.
      if (saved.shapeWidth === undefined && saved.penWidth) saved.shapeWidth = saved.penWidth;
      return { ...base, ...saved, stylusOnly: settings.stylusOnly, holdToSnap: settings.holdToSnap, penStyle: settings.penStyle, eraserMode: settings.eraserMode };
    }
  } catch {
    /* ignore */
  }
  return base;
}

export const Editor: React.FC<EditorProps> = ({ note, settings, setSettings, onSaved, onBack, onOpenSettings }) => {
  const gestures = useMemo(() => new GestureBus(), []);
  const editor = useNoteEditor(note, onSaved, () => gestures.inking);
  const { doc } = editor;
  /** The note's continuous surface (all of its content; editor/sheets.ts). */
  const surface = doc.pages[0];
  const pageCount = doc.sheets.length;
  /** The surface's size and its pages (surface px); a new object only when the pages change. */
  const sl = useMemo(() => surfaceLayout(doc), [doc.sheets, doc.paperStyle, doc.paperColor, doc.pageSize, doc.orientation]); // eslint-disable-line react-hooks/exhaustive-deps
  /** In the zoomed content: the surface sits at (PAD, PAD); room below it for the pull hint. */
  const layout = useMemo(() => ({ contentWidth: sl.width + PAD * 2, bottom: PAD + sl.height, totalHeight: PAD + sl.height + PAD + TAIL }), [sl]);
  const slRef = useRef(sl);
  slRef.current = sl;
  const docRef = useRef(doc);
  docRef.current = doc;
  const [tools, setToolsState] = useState<ToolSettings>(() => loadToolPrefs(settings));
  const toolsRef = useRef(tools);
  toolsRef.current = tools;
  const lastNonEraser = useRef<ToolSettings['tool']>('pen');

  const setTools = useCallback(
    (patch: Partial<ToolSettings>) => {
      setToolsState((prev) => {
        const next = { ...prev, ...patch };
        if (patch.tool && patch.tool !== 'eraser') lastNonEraser.current = patch.tool;
        try {
          const { tool: _t, ...persist } = next;
          localStorage.setItem(TOOL_KEY, JSON.stringify(persist));
        } catch {
          /* ignore */
        }
        if (
          patch.stylusOnly !== undefined || patch.holdToSnap !== undefined || patch.penStyle !== undefined || patch.eraserMode !== undefined
        ) {
          const s = { ...settings, stylusOnly: next.stylusOnly, holdToSnap: next.holdToSnap, penStyle: next.penStyle, eraserMode: next.eraserMode };
          saveSettings(s);
          setSettings(s);
        }
        return next;
      });
    },
    [settings, setSettings]
  );

  // Settings changed from the Settings sheet while the note is open.
  useEffect(() => {
    setToolsState((t) =>
      t.stylusOnly === settings.stylusOnly && t.holdToSnap === settings.holdToSnap ? t : { ...t, stylusOnly: settings.stylusOnly, holdToSnap: settings.holdToSnap }
    );
  }, [settings.stylusOnly, settings.holdToSnap]);

  const fingersNavigate = useCallback(() => toolsRef.current.stylusOnly || toolsRef.current.tool === 'hand', []);
  const penScrolls = useCallback(() => toolsRef.current.tool === 'hand', []);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const onFingerTap = useCallback(
    (fingers: number) => {
      if (!settingsRef.current.fingerTapUndo) return;
      if (fingers === 2) editor.undo();
      else if (fingers === 3) editor.redo();
    },
    [editor]
  );
  // Pull past the last page: a new page (the note's paper) is added at the end.
  const pullSetter = useRef<((d: number) => void) | null>(null);
  const bindPull = useCallback((set: (d: number) => void) => {
    pullSetter.current = set;
  }, []);
  const onPull = useCallback((d: number) => pullSetter.current?.(d), []);
  const onPullCommit = useCallback(() => {
    editor.commit((d) => appendBlankSheet(d));
    haptic('success');
  }, [editor]);
  // Fit to width fits the page on screen (curSheetRef, set below once the current page is known).
  const curSheetRef = useRef<{ left: number; width: number } | null>(null);
  const fitTarget = useCallback(() => (curSheetRef.current ? { left: PAD + curSheetRef.current.left, width: curSheetRef.current.width } : null), []);
  const { scrollRef, outerRef, zoom, fitMode, fitWidth, zoomToRect, zoomBy } = useViewport({
    contentWidth: layout.contentWidth, fingersNavigate, gestures, onFingerTap, onPull, onPullCommit, penScrolls, fitTarget,
  });
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  // A stable callback: an inline one is called with null and then the element again on every
  // render, which made the scroll view briefly null for everything that uses it (the GPU ink of a
  // pinch was switched off by any render during the pinch).
  const scrollRefCallback = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
    setScrollEl(el);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [selection, setSelectionState] = useState<Selection | null>(null);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const editingText = editingTextId ? (surface.textBlocks ?? []).find((t) => t.id === editingTextId) ?? null : null;
  const [modal, setModal] = useState<LatexModalState | null>(null);
  const [target, setTarget] = useState<ConvTarget | null>(null);
  const [busy, setBusy] = useState<{ label: string; detail?: string } | null>(null);
  const busyToken = useRef(0);
  /** Aborts the conversion in flight (Cancel, a newer conversion, or leaving the note). */
  const conversionAbort = useRef<AbortController | null>(null);
  const cancelConversion = useCallback(() => {
    busyToken.current++;
    conversionAbort.current?.abort();
    conversionAbort.current = null;
    setBusy(null);
  }, []);
  useEffect(() => () => conversionAbort.current?.abort(), []);
  const [toast, setToast] = useState<{ msg: string; error?: boolean } | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [printMode, setPrintMode] = useState(false);
  /** PDF export: the one page the print layout shows (null: all pages). */
  const [printOnly, setPrintOnly] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(0);
  const curSheet = sl.sheets[Math.min(currentPage, pageCount - 1)];
  curSheetRef.current = curSheet;
  // Fitted to the width: scrolling onto a page of another width or position refits to that page.
  const fitKey = `${curSheet.left}|${curSheet.width}`;
  useEffect(() => {
    if (fitMode === 'width') fitWidth();
  }, [fitKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // Infinite roll: new content reaching the bottom of the last page adds one blank page after it (only
  // for edits: not undo / redo, erasing or page operations, so a deleted trailing page stays deleted).
  const rollBase = useRef(surface);
  useEffect(() => {
    const before = rollBase.current;
    rollBase.current = surface;
    if (before === surface || editor.lastChange() !== 'commit') return;
    if (trailingSheetFor(before, doc) !== doc) editor.silent((d) => trailingSheetFor(before, d));
  }, [surface]); // eslint-disable-line react-hooks/exhaustive-deps
  const [pagesOpen, setPagesOpenState] = useState(() => {
    try {
      return localStorage.getItem(PAGES_KEY) === '1';
    } catch {
      return false;
    }
  });
  const setPagesOpen = (open: boolean) => {
    setPagesOpenState(open);
    try {
      localStorage.setItem(PAGES_KEY, open ? '1' : '0');
    } catch {
      /* ignore */
    }
  };
  const [selectedPages, setSelectedPages] = useState<ReadonlySet<string>>(() => new Set());
  const pageClipboard = usePageClipboard();
  // Pages that no longer exist (undo, delete) leave the page selection.
  useEffect(() => {
    if (![...selectedPages].every((id) => doc.sheets.some((p) => p.id === id))) setSelectedPages(new Set([...selectedPages].filter((id) => doc.sheets.some((p) => p.id === id))));
  }, [doc.sheets]); // eslint-disable-line react-hooks/exhaustive-deps

  const setSelection = useCallback((s: Selection | null) => setSelectionState(isEmptySelection(s) ? null : s), []);
  const [fillMenu, setFillMenu] = useState(false);
  useEffect(() => {
    if (!selection) setFillMenu(false);
  }, [selection]);

  const showToast = useCallback((msg: string, error = false) => {
    setToast({ msg, error });
    setTimeout(() => setToast((t) => (t?.msg === msg ? null : t)), error ? 7000 : 2500);
  }, []);

  // Keep selection bounds valid after undo/redo or external edits.
  useEffect(() => {
    if (!selection) return;
    const page = doc.pages.find((p) => p.id === selection.pageId);
    if (!page) return setSelectionState(null);
    const sel = {
      ...selection,
      strokeIds: selection.strokeIds.filter((id) => page.strokes.some((s) => s.id === id)),
      latexIds: selection.latexIds.filter((id) => page.latexBlocks.some((b) => b.id === id)),
      textIds: selection.textIds.filter((id) => (page.textBlocks ?? []).some((b) => b.id === id)),
      imageIds: selection.imageIds.filter((id) => (page.imageBlocks ?? []).some((b) => b.id === id)),
    };
    if (isEmptySelection({ ...sel, bounds: selection.bounds })) return setSelectionState(null);
    // Undo/redo of a move or a reshape: the box follows the content.
    const b = computeBounds(page, sel);
    const o = selection.bounds;
    if (b && (Math.abs(b.x - o.x) > 0.5 || Math.abs(b.y - o.y) > 0.5 || Math.abs(b.width - o.width) > 0.5 || Math.abs(b.height - o.height) > 0.5)) {
      setSelectionState({ ...sel, bounds: b });
    }
  }, [doc]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tools.tool !== 'lasso') setSelectionState(null);
    if (tools.tool !== 'text') setEditingTextId(null);
    setSelectedBlockId(null);
  }, [tools.tool]);

  // Pencil double-tap (sent by the native iOS shell) toggles eraser.
  useEffect(() => {
    const onDoubleTap = () => {
      if (!settings.pencilDoubleTapEraser) return;
      setTools({ tool: toolsRef.current.tool === 'eraser' ? lastNonEraser.current : 'eraser' });
    };
    window.addEventListener('opennote:pencilDoubleTap', onDoubleTap);
    return () => window.removeEventListener('opennote:pencilDoubleTap', onDoubleTap);
  }, [settings.pencilDoubleTapEraser, setTools]);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.shiftKey ? editor.redo() : editor.undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        editor.redo();
      } else if (mod && e.key.toLowerCase() === 'c' && selection) {
        e.preventDefault();
        copySelectionToClipboard();
      } else if (mod && e.key.toLowerCase() === 'x' && selection) {
        e.preventDefault();
        cutSelection();
      } else if (mod && e.key.toLowerCase() === 'v' && clipboard) {
        e.preventDefault();
        paste();
      } else if (mod && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        zoomBy(1.25);
      } else if (mod && e.key === '-') {
        e.preventDefault();
        zoomBy(0.8);
      } else if (mod && e.key === '0') {
        e.preventDefault();
        fitWidth();
      } else if (!mod) {
        const map: Record<string, ToolSettings['tool']> = { '1': 'pen', '2': 'highlighter', '3': 'eraser', '4': 'lasso', '5': 'text', '6': 'hand', '7': 'shape' };
        if (map[e.key]) setTools({ tool: map[e.key] });
        if ((e.key === 'Delete' || e.key === 'Backspace') && selection) deleteSelection();
        if (e.key === 'Escape') setSelectionState(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Track the page at a third of the screen's height.
  const onScroll = useCallback(() => {
    const el = scrollRef.current, outer = outerRef.current;
    if (!el || !outer) return;
    const y = (el.scrollTop + el.clientHeight / 3 - outer.offsetTop) / zoom - PAD;
    setCurrentPage(sheetIndexAt(slRef.current, y));
  }, [zoom, scrollRef, outerRef]);
  useEffect(onScroll, [onScroll, layout]);

  /** Scrolls to the top of page `k`. */
  const jumpToPage = useCallback(
    (k: number) => {
      const el = scrollRef.current, outer = outerRef.current;
      const sh = slRef.current.sheets[k];
      if (!el || !outer || !sh) return;
      el.scrollTo({ top: outer.offsetTop + (PAD + sh.top - PAD / 2) * zoom, behavior: 'smooth' });
      setCurrentPage(k);
    },
    [zoom, scrollRef, outerRef]
  );

  /** Bottom-right zoom button: fit the width; when already fitted, fit the whole current page. */
  const toggleFit = () => {
    if (fitMode === 'width') {
      const s = curSheet;
      zoomToRect({ x: PAD + s.left - PAD / 2, y: PAD + s.top - PAD / 2, width: s.width + PAD, height: s.height + PAD });
    } else fitWidth();
  };

  // ------------------------------------------------------------------------- selection actions
  const selPage = selection ? doc.pages.find((p) => p.id === selection.pageId) : undefined;
  const selStrokes = useMemo(() => (selPage && selection ? selPage.strokes.filter((s) => selection.strokeIds.includes(s.id)) : []), [selPage, selection]);

  const refreshSelectionBounds = (page: NotePage, sel: Selection) => {
    const b = computeBounds(page, sel);
    setSelection(b ? { ...sel, bounds: b } : null);
  };

  function deleteSelection() {
    if (!selection) return;
    const sel = selection;
    editor.commitPage(sel.pageId, (p) => removeSelection(p, sel));
    setSelectionState(null);
  }

  const duplicateSelection = () => {
    if (!selection || !selPage) return;
    const off = 24;
    const sel = selection;
    // The copy goes on top of everything (editor/zorder.ts), in the same order among itself.
    const { strokes, latexBlocks: latex, textBlocks: texts, imageBlocks: images } = restamp({
      strokes: selPage.strokes.filter((s) => sel.strokeIds.includes(s.id)).map((s) => markMoved({ ...s, id: newId('stroke'), points: s.points.map((p) => ({ ...p, x: p.x + off, y: p.y + off })) }, s, off, off)),
      latexBlocks: selPage.latexBlocks.filter((b) => sel.latexIds.includes(b.id)).map((b) => ({ ...b, id: newId(b.isTikz ? 'tikz' : 'latex'), x: b.x + off, y: b.y + off })),
      textBlocks: (selPage.textBlocks ?? []).filter((b) => sel.textIds.includes(b.id)).map((b) => ({ ...b, id: newId('text'), x: b.x + off, y: b.y + off })),
      imageBlocks: (selPage.imageBlocks ?? []).filter((b) => sel.imageIds.includes(b.id)).map((b) => ({ ...b, id: newId('image'), x: b.x + off, y: b.y + off })),
    });
    editor.commitPage(sel.pageId, (p) => ({
      ...p,
      strokes: [...p.strokes, ...strokes],
      latexBlocks: [...p.latexBlocks, ...latex],
      textBlocks: [...(p.textBlocks ?? []), ...texts],
      imageBlocks: [...(p.imageBlocks ?? []), ...images],
    }));
    setSelection({
      pageId: sel.pageId,
      strokeIds: strokes.map((s) => s.id),
      latexIds: latex.map((b) => b.id),
      textIds: texts.map((b) => b.id),
      imageIds: images.map((b) => b.id),
      bounds: { ...sel.bounds, x: sel.bounds.x + off, y: sel.bounds.y + off },
    });
  };

  // Clipboard (editor/clipboard.ts): copy keeps the selection without placing anything, cut also
  // removes it, paste places a copy where the screen is looking, on any page of any note.
  const clipboard = useClipboard();

  const copySelectionToClipboard = () => {
    if (!selection || !selPage) return;
    const n = copySelection(selPage, selection);
    if (n) showToast(`Copied ${n} item${n > 1 ? 's' : ''} — Paste puts them on any page`);
  };

  const cutSelection = () => {
    if (!selection || !selPage) return;
    const sel = selection;
    const n = copySelection(selPage, sel);
    if (!n) return;
    editor.commitPage(sel.pageId, (p) => removeSelection(p, sel));
    setSelectionState(null);
    showToast(`Cut ${n} item${n > 1 ? 's' : ''} — Paste puts them back on any page`);
  };

  const paste = () => {
    const at = viewCentreOnPage();
    const res = pasteClipboard(surface, { x: at.x, y: at.y }, sl.width, sl.height);
    if (!res) return;
    editor.commitPage(surface.id, () => res.page);
    const bounds = computeBounds(res.page, res.sel);
    setTools({ tool: 'lasso' });
    // After the tool change (which clears the selection), select what was pasted so it can be moved.
    setTimeout(() => bounds && setSelectionState({ ...res.sel, bounds }), 0);
  };

  const recolorSelection = (color: string) => {
    if (!selection) return;
    const sel = selection;
    editor.commitPage(sel.pageId, (p) => ({
      ...p,
      strokes: p.strokes.map((s) => (sel.strokeIds.includes(s.id) && s.tool === 'pen' ? { ...s, color } : s)),
      latexBlocks: p.latexBlocks.map((b) => (sel.latexIds.includes(b.id) ? { ...b, color } : b)),
      textBlocks: (p.textBlocks ?? []).map((b) => (sel.textIds.includes(b.id) ? { ...b, color } : b)),
    }));
  };

  const restyleSelection = (lineStyle: LineStyle) => {
    if (!selection) return;
    const sel = selection;
    editor.commitPage(sel.pageId, (p) => ({ ...p, strokes: p.strokes.map((s) => (sel.strokeIds.includes(s.id) ? { ...s, lineStyle } : s)) }));
  };

  /** Fills the selected closed strokes. Nearly closed freehand loops are closed first. */
  const fillSelection = (fill: FillType) => {
    if (!selection) return;
    const sel = selection;
    let count = 0;
    editor.commitPage(sel.pageId, (p) => ({
      ...p,
      strokes: p.strokes.map((s) => {
        if (!sel.strokeIds.includes(s.id) || s.tool !== 'pen' || s.shapeKind === 'point') return s;
        const closed = s.closed || canClose(s);
        if (!closed) return s;
        count++;
        return { ...s, closed: true, arrow: undefined, fill: fill === 'none' ? undefined : fill };
      }),
    }));
    if (!count) showToast('Fill needs a closed shape: draw it with the smart pen or close the loop');
  };

  const toggleArrowSelection = () => {
    if (!selection || !selPage) return;
    const sel = selection;
    const open = selPage.strokes.filter((s) => sel.strokeIds.includes(s.id) && s.tool === 'pen' && !s.closed && s.points.length > 1 && s.shapeKind !== 'point');
    if (!open.length) return showToast('Arrowheads go on open lines and curves');
    const on = !open.every((s) => s.arrow);
    editor.commitPage(sel.pageId, (p) => ({ ...p, strokes: p.strokes.map((s) => (open.includes(s) ? { ...s, arrow: on || undefined } : s)) }));
  };

  const snapSelection = () => {
    if (!selection || !selPage) return;
    const sel = selection;
    let count = 0;
    const page = { ...selPage, strokes: selPage.strokes.map((s) => {
      if (!sel.strokeIds.includes(s.id)) return s;
      const snapped = snapStroke(s);
      if (snapped !== s) count++;
      return snapped;
    }) };
    if (!count) return showToast('No clean shapes recognised in the selection');
    editor.commitPage(sel.pageId, () => page);
    refreshSelectionBounds(page, sel);
    showToast(`Snapped ${count} shape${count > 1 ? 's' : ''}`);
  };

  /**
   * Exact TikZ of the selection (no AI, no re-snapping): ink as geometry, selected text boxes and
   * LaTeX blocks as nodes at their positions. Opens the review sheet to copy/insert/replace.
   */
  const vectorizeSelection = () => {
    const ink = selStrokes.filter((s) => s.tool === 'pen');
    if (!selection || !selPage || !ink.length) return showToast('Select some ink first');
    const texts = (selPage.textBlocks ?? []).filter((t) => selection.textIds.includes(t.id) && t.text.trim());
    const maths = selPage.latexBlocks.filter((b) => selection.latexIds.includes(b.id) && !b.isTikz);
    const labels: TikzLabel[] = [
      ...texts.map((t) => ({ x: t.x, y: t.y, width: t.width, height: t.fontSize * 1.35 * Math.max(1, t.text.split('\n').length), text: t.text, latex: false, color: t.color, fontPx: t.fontSize })),
      ...maths.map((b) => ({ x: b.x, y: b.y, width: b.width, height: b.height, text: b.latexCode, latex: true, color: b.color, fontPx: 22 * (b.scale ?? 1) })),
    ];
    const ib = boundsOfStrokes(ink)!;
    let x0 = ib.x, y0 = ib.y, x1 = ib.x + ib.width, y1 = ib.y + ib.height;
    for (const l of labels) {
      x0 = Math.min(x0, l.x); y0 = Math.min(y0, l.y);
      x1 = Math.max(x1, l.x + l.width); y1 = Math.max(y1, l.y + l.height);
    }
    const b = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    setTarget({ kind: 'insert', pageId: selection.pageId, bounds: b, strokeIds: ink.map((s) => s.id), textIds: texts.map((t) => t.id), latexIds: maths.map((m) => m.id), mode: 'tikz', image: '' });
    setModal({
      latex: convertStrokesToTikz(ink, labels),
      isTikz: true,
      origin: 'new',
      canReplaceInk: true,
      subtitle: labels.length ? 'Exact geometry of the selected ink, with its text and math as nodes' : 'Exact geometry of the selected ink — copy it or insert it as a diagram',
    });
  };

  // ------------------------------------------------------------------------- VLM conversion
  const runConversion = useCallback(
    async (t: Extract<ConvTarget, { kind: 'insert' }>) => {
      conversionAbort.current?.abort();
      const abort = new AbortController();
      conversionAbort.current = abort;
      const token = ++busyToken.current;
      const label = t.mode === 'tikz' ? 'Drawing → TikZ' : t.mode === 'text' ? 'Notes → LaTeX' : 'Handwriting → LaTeX';
      setBusy({ label, detail: `${settings.modelName} · up to ${settings.vlmTimeoutSec}s` });
      try {
        const res = await convertImage(t.image, t.mode, settings, t.hint, abort.signal);
        if (token !== busyToken.current) return;
        setTarget(t);
        setModal({
          latex: t.colors && t.mode !== 'tikz' ? enforceColors(res.latex, t.colors) : res.latex,
          isTikz: t.mode === 'tikz',
          origin: 'vlm',
          subtitle: `${res.model} · ${(res.elapsedMs / 1000).toFixed(1)} s — review and edit before inserting`,
          warning: res.truncated ? 'The reply hit the token limit and may be incomplete.' : undefined,
          canReplaceInk: t.strokeIds.length + t.textIds.length > 0,
        });
      } catch (err) {
        if (token !== busyToken.current) return;
        showToast(err instanceof Error ? err.message : String(err), true);
      } finally {
        if (conversionAbort.current === abort) conversionAbort.current = null;
        if (token === busyToken.current) setBusy(null);
      }
    },
    [settings, showToast]
  );

  const convertSelection = (mode: ConversionMode) => {
    if (!selection || !selPage) return;
    const texts = (selPage.textBlocks ?? []).filter((t) => selection.textIds.includes(t.id));
    const ink = selStrokes.filter((s) => s.tool === 'pen');
    const b = boundsOfStrokes(ink, texts);
    if (!b) return showToast('The selection contains no handwriting to transcribe');
    // Colours: the exact ink colours go into the prompt and the reply keeps them (inkColors.ts).
    const colors = mode === 'tikz' ? undefined : inkColors(ink, b);
    const image = renderInkImage(ink, b, texts, colors && colors.colors.length > 1 ? new Map(colors.colors.map((c) => [c.hex, c.imageColor])) : undefined);
    // TikZ: the exact geometry of drawn shapes helps the model, but handwriting as Bezier
    // coordinates is thousands of tokens (a 14k-token prompt took minutes and timed out), so only
    // shapes go in, and only while the hint stays small.
    const shapes = ink.filter((s) => s.isShape);
    const geometry = mode === 'tikz' && shapes.length ? convertStrokesToTikz(shapes) : '';
    const hint =
      geometry && geometry.length <= MAX_TIKZ_HINT
        ? `For reference, the exact geometry of the drawn shapes (coordinates in cm from the lower-left corner of the shapes; freehand lines, labels and text are NOT included — read them from the image):\n${geometry}`
        : colors
          ? colorHint(colors, mode === 'text' ? 'text' : 'math') || undefined
          : undefined;
    void runConversion({ kind: 'insert', pageId: selection.pageId, bounds: b, strokeIds: ink.map((s) => s.id), textIds: [], mode, image, hint, colors });
  };

  const convertPage = () => {
    const ink = sheetStrokes(doc, sl, curSheet.index).filter((s) => s.tool === 'pen');
    const b = boundsOfStrokes(ink);
    if (!b) return showToast('This page has no handwriting to transcribe');
    const colors = inkColors(ink, b);
    const image = renderInkImage(ink, b, [], colors.colors.length > 1 ? new Map(colors.colors.map((c) => [c.hex, c.imageColor])) : undefined);
    void runConversion({ kind: 'insert', pageId: surface.id, bounds: b, strokeIds: ink.map((s) => s.id), textIds: [], mode: 'text', image, hint: colorHint(colors, 'text') || undefined, colors });
  };

  const onModalInsert = (code: string, isTikz: boolean, replaceInk: boolean) => {
    crashLog.event('latex-insert', { isTikz, replaceInk, chars: code.length });
    const t = target;
    setModal(null);
    setTarget(null);
    if (!t) return;
    if (t.kind === 'edit') {
      editor.commitPage(t.pageId, (p) => ({ ...p, latexBlocks: p.latexBlocks.map((b) => (b.id === t.blockId ? { ...b, latexCode: code, isTikz } : b)) }));
      return;
    }
    const textual = t.kind === 'insert' && t.mode === 'text';
    const at = t.kind === 'insert' ? { x: t.bounds.x, y: t.bounds.y } : t.at;
    const mixedContent = !isTikz && /<p>|on-h/.test(renderLatexContent(code).html);
    const sheet = sl.sheets[sheetIndexAt(sl, at.y)];
    const pageW = sheet.left + sheet.width;
    const width =
      t.kind === 'insert' && !(mixedContent && !textual)
        ? textual
          ? Math.min(pageW - at.x - 24, Math.max(t.bounds.width, 560))
          : Math.max(isTikz ? 160 : 60, t.bounds.width)
        : isTikz
          ? 360
          : mixedContent
            ? Math.min(pageW - at.x - 24, 600)
            : 200;
    const block: LatexBlock = {
      id: newId(isTikz ? 'tikz' : 'latex'),
      x: Math.max(8, at.x),
      y: Math.max(8, at.y),
      width,
      height: t.kind === 'insert' ? t.bounds.height : 80,
      latexCode: code,
      isTikz,
      // The handwriting's main colour (other colours are in the LaTeX); the default ink follows the paper.
      ...(t.kind === 'insert' && t.colors && !isTikz && !DEFAULT_INKS.includes(t.colors.base) ? { color: t.colors.base } : {}),
      createdAt: Date.now(),
    };
    if (t.kind === 'insert' && t.mode === 'math' && !isTikz) {
      // Typeset at roughly the size of the handwriting it replaces.
      const lines = Math.max(1, (code.match(/\\\\/g) ?? []).length + 1);
      block.scale = Math.max(0.8, Math.min(3, t.bounds.height / lines / 45));
    }
    editor.commitPage(t.pageId, (p) => {
      const base =
        replaceInk && t.kind === 'insert'
          ? {
              ...p,
              strokes: p.strokes.filter((s) => !t.strokeIds.includes(s.id)),
              textBlocks: (p.textBlocks ?? []).filter((x) => !t.textIds.includes(x.id)),
              latexBlocks: p.latexBlocks.filter((x) => !(t.latexIds ?? []).includes(x.id)),
            }
          : p;
      return { ...base, latexBlocks: [...base.latexBlocks, block] };
    });
    setSelectionState(null);
  };

  const onEditLatex = useCallback((pageId: string, block: LatexBlock) => {
    setTarget({ kind: 'edit', pageId, blockId: block.id });
    setModal({ latex: block.latexCode, isTikz: !!block.isTikz, origin: 'edit', canReplaceInk: false });
  }, []);

  const insertLatexManually = () => {
    const at = visibleTopOnPage();
    setTarget({ kind: 'new', pageId: surface.id, at: { x: sl.sheets[at.index].left + 96, y: at.y + 80 } });
    setModal({ latex: '', isTikz: false, origin: 'new', canReplaceInk: false });
  };

  // ------------------------------------------------------------------------- pages & media
  // Page operations (toolbar: the current page; page manager: the selected pages). Each one is a
  // single undo step.
  const currentIds = () => new Set([curSheet.id]);

  const duplicatePagesOf = (ids: ReadonlySet<string>) => {
    if (!ids.size) return;
    const r = duplicateSheets(doc, ids);
    editor.commit(() => r.doc);
    setSelectedPages(new Set(r.copies));
    showToast(`Duplicated ${ids.size} page${ids.size > 1 ? 's' : ''}`);
  };

  const deletePagesOf = (ids: ReadonlySet<string>, confirm = false) => {
    if (!ids.size) return;
    if (confirm && !window.confirm(`Delete page ${currentPage + 1} and what is on it? (Undo can bring it back)`)) return;
    editor.commit((d) => deleteSheets(d, ids));
    setSelectedPages(new Set());
    showToast(`Deleted ${ids.size} page${ids.size > 1 ? 's' : ''} — Undo brings ${ids.size > 1 ? 'them' : 'it'} back`);
  };

  const copyPagesOf = (ids: ReadonlySet<string>) => {
    const n = copySheets(doc, ids);
    if (n) showToast(`Copied ${n} page${n > 1 ? 's' : ''} — Paste puts ${n > 1 ? 'them' : 'it'} into any note`);
  };

  const cutPagesOf = (ids: ReadonlySet<string>) => {
    const n = copySheets(doc, ids);
    if (!n) return;
    editor.commit((d) => deleteSheets(d, ids));
    setSelectedPages(new Set());
    showToast(`Cut ${n} page${n > 1 ? 's' : ''} — Paste puts ${n > 1 ? 'them' : 'it'} back`);
  };

  /** Pastes copied pages after the last selected page (or after the current page). */
  const pastePages = () => {
    let after = -1;
    doc.sheets.forEach((p, i) => {
      if (selectedPages.has(p.id)) after = i;
    });
    if (after < 0) after = Math.min(currentPage, pageCount - 1);
    const r = pasteSheets(doc, after + 1);
    if (!r) return;
    editor.commit(() => r.doc);
    setSelectedPages(new Set(r.ids));
    showToast(`Pasted ${r.ids.length} page${r.ids.length > 1 ? 's' : ''}`);
  };

  const addPage = () => {
    editor.commit((d) => appendBlankSheet(d));
    setTimeout(() => jumpToPage(pageCount), 0);
  };

  /** A point on screen (relative to the scroll box) on the surface, and the page there. */
  const pagePointAt = (sx: number, sy: number) => {
    const el = scrollRef.current, outer = outerRef.current;
    const L = slRef.current;
    if (!el || !outer) return { index: Math.min(currentPage, pageCount - 1), x: L.width / 2, y: 40 };
    const x = (el.scrollLeft + sx - outer.offsetLeft) / zoom - PAD, y = (el.scrollTop + sy - outer.offsetTop) / zoom - PAD;
    const cy = Math.max(0, Math.min(L.height, y));
    return { index: sheetIndexAt(L, cy), x: Math.max(0, Math.min(L.width, x)), y: cy };
  };
  /** The page at the top of the screen and the surface y there (for placing new content). */
  const visibleTopOnPage = () => {
    const at = pagePointAt(0, 0);
    return { index: at.index, y: Math.max(24, Math.min(slRef.current.height - 160, at.y)) };
  };
  const viewCentreOnPage = () => {
    const el = scrollRef.current;
    return el ? pagePointAt(el.clientWidth / 2, el.clientHeight / 2) : pagePointAt(0, 0);
  };

  const insertImage = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 1600;
        const s = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * s);
        c.height = Math.round(img.height * s);
        c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
        const dataUrl = c.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.88);
        const at = visibleTopOnPage();
        const sheet = slRef.current.sheets[at.index];
        const w = Math.min(sheet.width - 160, c.width);
        const h = (w * c.height) / c.width;
        editor.commitPage(docRef.current.pages[0].id, (p) => ({
          ...p,
          imageBlocks: [...(p.imageBlocks ?? []), { id: newId('image'), x: sheet.left + (sheet.width - w) / 2, y: Math.max(24, Math.min(slRef.current.height - h - 24, at.y + 60)), width: w, height: h, dataUrl, createdAt: Date.now() }],
        }));
        setTools({ tool: 'lasso' });
        showToast('Image inserted — use the lasso to move or resize it');
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  };

  /**
   * PDF: each page at its own size and orientation (Android: made by the app, page by page, see
   * services/pdfExport.ts); elsewhere through the print dialog.
   */
  const exportPdf = async () => {
    if (!canMakePdf()) return printNote();
    setExportOpen(false);
    await editor.flush();
    const sheets = printedSheets(doc);
    const pages: Uint8Array[] = [];
    setBusy({ label: 'Making the PDF…' });
    try {
      for (let i = 0; i < sheets.length; i++) {
        const s = sheets[i];
        setBusy({ label: 'Making the PDF…', detail: `Page ${i + 1} of ${sheets.length}` });
        // The print layout shows only this page; the WebView's PDF renderer then makes it a page of exactly its size.
        flushSync(() => {
          setPrintOnly(s.id);
          setPrintMode(true);
        });
        // Let TikZ / KaTeX lay out (longer for the first page, which mounts the print layout).
        await new Promise((r) => setTimeout(r, i === 0 ? 450 : 200));
        pages.push(await pdfOfPrintLayout(doc.title, s.width, s.height));
      }
      const pdf = await joinPdfPages(pages, doc.title);
      setPrintMode(false);
      setPrintOnly(null);
      setBusy(null);
      const where = await exportFile(`${baseName(doc)}.pdf`, new Blob([pdf as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }));
      if (where) showToast(where);
    } catch (err) {
      setBusy(null);
      setPrintMode(false);
      setPrintOnly(null);
      const msg = err instanceof Error ? err.message : String(err);
      if (/cancel/i.test(msg)) return;
      showToast(`PDF export failed (${msg}). Use Print… instead.`, true);
    }
  };

  /** Print… : the system print dialog (on Android also "Save as PDF", with one paper size for all pages). */
  const printNote = async () => {
    setExportOpen(false);
    await editor.flush();
    flushSync(() => setPrintMode(true));
    // Let TikZ/KaTeX layout settle before handing the view to the print system.
    await new Promise((r) => setTimeout(r, 400));
    try {
      await printDocument(doc.title);
    } catch (err) {
      showToast(`Print failed: ${err instanceof Error ? err.message : String(err)}`, true);
    } finally {
      setTimeout(() => setPrintMode(false), 500);
    }
  };

  // ------------------------------------------------------------------------- render
  const { totalHeight, contentWidth } = layout;
  const printed = printMode ? printedSheets(doc).filter((s) => !printOnly || s.id === printOnly) : [];
  const selectionHasInk = selStrokes.some((s) => s.tool === 'pen');

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <Toolbar
        tools={tools}
        setTools={setTools}
        canUndo={editor.canUndo}
        canRedo={editor.canRedo}
        onUndo={editor.undo}
        onRedo={editor.redo}
        title={doc.title}
        setTitle={(title) => editor.commit((d) => ({ ...d, title }))}
        paper={{ paperStyle: doc.paperStyle, paperColor: doc.paperColor, patternColor: doc.patternColor ?? null, size: doc.pageSize ?? 'letter', orientation: doc.orientation ?? 'portrait' }}
        setPaper={(patch: SetupPatch) => editor.commit((d) => setNotePaper(d, patch))}
        pagesOpen={pagesOpen}
        onTogglePages={() => setPagesOpen(!pagesOpen)}
        onBack={async () => {
          await editor.flush();
          onBack();
        }}
        onConvertPage={convertPage}
        onExport={() => setExportOpen(true)}
        onSettings={onOpenSettings}
        onDuplicatePage={() => duplicatePagesOf(currentIds())}
        onDeletePage={() => deletePagesOf(currentIds(), true)}
        onInsertLatex={insertLatexManually}
        onInsertImage={insertImage}
        onPaste={clipboard ? paste : undefined}
        currentPage={currentPage + 1}
        totalPages={pageCount}
        audioSlot={<AudioRecorder noteId={doc.id} onError={(m) => showToast(m, true)} />}
      />

      <div className="relative flex-1 flex min-h-0">
        {pagesOpen && (
          <>
            {/* Narrow screens: the panel covers the page; a tap beside it closes it. */}
            <div className="md:hidden absolute inset-0 z-30 bg-black/25" onClick={() => setPagesOpen(false)} data-no-pan />
            <div className="absolute md:relative z-40 h-full shadow-2xl md:shadow-none">
              <PageManager
                doc={doc}
                layout={sl}
                currentPage={Math.min(currentPage, pageCount - 1)}
                selected={selectedPages}
                setSelected={setSelectedPages}
                onJump={jumpToPage}
                onMove={(ids, to) => editor.commit((d) => moveSheets(d, ids, to))}
                onDelete={(ids) => deletePagesOf(ids)}
                onDuplicate={duplicatePagesOf}
                onCopy={copyPagesOf}
                onCut={cutPagesOf}
                onPaste={pastePages}
                canPaste={!!pageClipboard}
                onSetup={(ids, patch) => editor.commit((d) => setSheetsSetup(d, ids, patch))}
                onAddPage={addPage}
                onClose={() => setPagesOpen(false)}
              />
            </div>
          </>
        )}
        <div className="relative flex-1 min-w-0">
          {/* The text box being edited: its size, style, typeface and colour. */}
          {editingText && (
            <div className="absolute top-2 left-0 right-0 z-40 flex justify-center px-3 pointer-events-none">
              <div className="pointer-events-auto max-w-full">
                <TextFormatBar block={editingText} onChange={(patch) => editor.commitPage(surface.id, (p) => ({ ...p, textBlocks: (p.textBlocks ?? []).map((x) => (x.id === editingText.id ? { ...x, ...patch } : x)) }))} />
              </div>
            </div>
          )}
          <div
            ref={scrollRefCallback}
            onScroll={onScroll}
            className="absolute inset-0 overflow-auto bg-ui-desk dark:bg-ui-desk"
            style={{ touchAction: 'pan-x pan-y', overscrollBehavior: 'contain' }}
          >
            <div ref={outerRef} data-note-content style={{ width: contentWidth * zoom, height: totalHeight * zoom, margin: '0 auto', position: 'relative' }}>
              <div style={{ width: contentWidth, height: totalHeight, transform: `scale(${zoom})`, transformOrigin: '0 0', position: 'relative' }}>
                <div style={{ position: 'absolute', left: PAD, top: PAD }}>
                  <CanvasPage
                    page={surface}
                    layout={sl}
                    tools={tools}
                    zoom={zoom}
                    editor={editor.ops}
                    gestures={gestures}
                    selection={selection?.pageId === surface.id ? selection : null}
                    setSelection={setSelection}
                    selectedBlockId={selectedBlockId}
                    setSelectedBlockId={setSelectedBlockId}
                    editingTextId={editingTextId}
                    setEditingTextId={setEditingTextId}
                    onEditLatex={onEditLatex}
                    printMode={false}
                    scrollRoot={scrollEl}
                  />
                </div>
                <div className="absolute left-0 right-0 flex justify-center pointer-events-none" style={{ top: layout.bottom + 28 }}>
                  <div className="flex items-center gap-1.5 text-[13px] font-medium text-gray-400 dark:text-gray-500">
                    <Plus className="w-4 h-4" /> Pull up to add a page
                  </div>
                </div>
              </div>
            </div>
          </div>
          <PullIndicator bind={bindPull} />

          {/* Page indicator and zoom */}
          <div
            className="absolute right-3 z-30 flex items-center gap-1.5"
            style={{ bottom: `calc(${selection || (clipboard && tools.tool === 'lasso') ? 84 : 14}px + env(safe-area-inset-bottom))` }}
            data-no-pan
          >
            <div className="pointer-events-none px-3 py-1.5 rounded-full bg-black/55 text-white text-xs font-semibold tabular-nums backdrop-blur">
              {Math.min(currentPage, pageCount - 1) + 1} / {pageCount}
            </div>
            <div className="flex items-center rounded-full bg-black/55 text-white text-xs font-semibold tabular-nums backdrop-blur overflow-hidden">
              <button onClick={() => zoomBy(0.8)} className="hidden sm:flex px-2 py-1.5 hover:bg-white/10" title="Zoom out (⌘−)">
                <Minus className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={toggleFit}
                className="flex items-center gap-1.5 px-2.5 py-1.5 hover:bg-white/10"
                title={fitMode === 'width' ? 'Fit the whole page' : 'Fit the page width (⌘0)'}
              >
                {fitMode === 'width' ? <Maximize className="w-3.5 h-3.5" /> : <MoveHorizontal className="w-3.5 h-3.5" />}
                {Math.round(zoom * 100)}%
              </button>
              <button onClick={() => zoomBy(1.25)} disabled={zoom >= MAX_ZOOM - 1e-3} className="hidden sm:flex px-2 py-1.5 hover:bg-white/10 disabled:opacity-40" title="Zoom in (⌘+)">
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Paste (lasso tool, something copied, nothing selected) */}
      {!selection && clipboard && tools.tool === 'lasso' && (
        <div className="fixed left-0 right-0 z-40 flex justify-center px-3 pointer-events-none" style={{ bottom: `calc(16px + env(safe-area-inset-bottom))` }} data-no-pan>
          <button onClick={paste} className="pointer-events-auto flex items-center gap-2 bg-ui-bar/95 backdrop-blur-xl text-white rounded-3xl shadow-2xl ring-1 ring-white/10 px-4 py-2.5 text-sm font-semibold active:scale-95 transition" title="Paste the copied items here">
            <ClipboardPaste className="w-5 h-5" /> Paste
          </button>
        </div>
      )}

      {/* Selection action bar */}
      {selection && fillMenu && selectionHasInk && (
        <div className="fixed left-0 right-0 z-40 flex justify-center px-3" style={{ bottom: `calc(84px + env(safe-area-inset-bottom))` }} data-no-pan>
          <div className="flex items-center gap-1 bg-ui-bar/95 backdrop-blur-xl text-white rounded-3xl shadow-2xl ring-1 ring-white/10 px-2 py-2 text-xs font-semibold">
            {FILL_OPTIONS.map((f) => (
              <button key={f.id} onClick={() => { fillSelection(f.id); setFillMenu(false); }} className="flex flex-col items-center gap-1 px-2.5 py-1.5 rounded-2xl hover:bg-white/10 active:scale-95 transition" title={f.label}>
                <span className="scale-125"><FillSwatch fill={f.id} color="#E5E7EB" /></span>
                <span>{f.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {selection && (
        <div className="fixed left-0 right-0 z-40 flex justify-center px-3" style={{ bottom: `calc(16px + env(safe-area-inset-bottom))` }} data-no-pan>
          <div className="flex items-center gap-1.5 bg-ui-bar/95 backdrop-blur-xl text-white rounded-3xl shadow-2xl ring-1 ring-white/10 px-2.5 py-2 overflow-x-auto max-w-full text-sm font-semibold">
            {selectionHasInk && (
              <>
                <button onClick={() => convertSelection('math')} className={PILL + ' bg-blue-600'} title="Transcribe handwriting to LaTeX math (Qwen3-VL)">
                  <Sparkles className="w-5 h-5" /> LaTeX
                </button>
                <button onClick={() => convertSelection('text')} className={PILL + ' bg-blue-500/80'} title="Transcribe notes (text + math)">
                  <FileText className="w-5 h-5" /> Notes
                </button>
                <button onClick={() => convertSelection('tikz')} className={PILL + ' bg-indigo-600'} title="Diagram → TikZ (Qwen3-VL)">
                  <Share2 className="w-5 h-5" /> TikZ
                </button>
                <button onClick={vectorizeSelection} className={PILL + ' bg-white/10'} title="Convert ink geometry to TikZ offline (no AI)">
                  <Wand2 className="w-5 h-5" /> Vector
                </button>
                <button onClick={snapSelection} className={ICON_BTN} title="Snap to shapes"><Shapes className="w-5 h-5" /></button>
                <div className="w-px h-7 bg-white/15 mx-1 flex-shrink-0" />
                {['#111827', '#1A73E8', '#D93025', '#188038', '#9B51E0'].map((c) => (
                  <button key={c} onClick={() => recolorSelection(c)} className="w-8 h-8 rounded-full ring-2 ring-white/30 flex-shrink-0 active:scale-90 transition" style={{ backgroundColor: c }} title="Recolour" />
                ))}
                <div className="w-px h-7 bg-white/15 mx-1 flex-shrink-0" />
                {(['solid', 'dashed', 'dotted'] as LineStyle[]).map((ls) => (
                  <button key={ls} onClick={() => restyleSelection(ls)} className={ICON_BTN} title={ls[0].toUpperCase() + ls.slice(1)}>
                    <svg width="22" height="22" viewBox="0 0 22 22"><line x1="3" y1="11" x2="19" y2="11" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeDasharray={ls === 'dashed' ? '5 4' : ls === 'dotted' ? '0.1 4.5' : undefined} /></svg>
                  </button>
                ))}
                <button onClick={() => setFillMenu((v) => !v)} className={`${ICON_BTN} ${fillMenu ? 'bg-white/15' : ''}`} title="Fill closed shapes">
                  <PaintBucket className="w-5 h-5" />
                </button>
                <button onClick={toggleArrowSelection} className={ICON_BTN} title="Arrowhead on/off"><MoveUpRight className="w-5 h-5" /></button>
                <div className="w-px h-7 bg-white/15 mx-1 flex-shrink-0" />
              </>
            )}
            <button onClick={cutSelection} className={ICON_BTN} title="Cut"><Scissors className="w-5 h-5" /></button>
            <button onClick={copySelectionToClipboard} className={ICON_BTN} title="Copy (paste it later, on any page)"><ClipboardCopy className="w-5 h-5" /></button>
            <button onClick={duplicateSelection} className={ICON_BTN} title="Duplicate"><CopyPlus className="w-5 h-5" /></button>
            <button onClick={deleteSelection} className={ICON_BTN + ' text-red-400'} title="Delete"><Trash2 className="w-5 h-5" /></button>
            <button onClick={() => setSelectionState(null)} className={ICON_BTN} title="Done"><X className="w-5 h-5" /></button>
          </div>
        </div>
      )}

      {busy && (
        <div className="fixed inset-0 bg-black/35 z-50 flex items-center justify-center" data-no-pan>
          <div className="bg-white dark:bg-ui-panel px-6 py-5 rounded-3xl shadow-2xl flex flex-col items-center text-gray-900 dark:text-gray-100 max-w-xs text-center">
            <Loader2 className="w-7 h-7 text-blue-600 animate-spin mb-2" />
            <div className="font-bold text-sm">{busy.label}</div>
            {busy.detail && <div className="text-xs text-gray-400 mt-1">{busy.detail}</div>}
            <button
              className="mt-3 text-xs text-blue-600"
              onClick={cancelConversion}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed top-24 left-1/2 -translate-x-1/2 z-[70] max-w-[92vw]" data-no-pan>
          <div className={`px-4 py-2.5 rounded-2xl shadow-xl text-sm flex items-start gap-2 ${toast.error ? 'bg-red-600 text-white' : 'bg-gray-900 text-white'}`} onClick={() => setToast(null)}>
            {toast.error && <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />}
            <span>{toast.msg}</span>
          </div>
        </div>
      )}

      <LatexModal
        state={modal}
        onClose={() => {
          setModal(null);
          setTarget(null);
        }}
        onInsert={onModalInsert}
        onRetry={target?.kind === 'insert' ? () => {
          const t = target;
          setModal(null);
          void runConversion(t);
        } : undefined}
      />

      {printMode &&
        createPortal(
          <div className="on-print-root">
            {/* Each page cut from the surface, on its own sheet at its own size (named @page rules). */}
            <style>
              {[...new Set(printed.map((x) => `${x.width}x${x.height}`))]
                .map((k) => {
                  const [w, h] = k.split('x').map(Number);
                  return `@page on-${k} { size: ${(w / 96).toFixed(3)}in ${(h / 96).toFixed(3)}in; margin: 0; }`;
                })
                .join('\n')}
            </style>
            {printed.map((s) => (
              <div key={s.id} className="on-print-page" style={{ width: s.width, height: s.height, page: `on-${s.width}x${s.height}` } as React.CSSProperties}>
                <div style={{ transform: `translate(${-s.left}px, ${-s.top}px)` }}>
                  <CanvasPage
                    page={sheetSlice(surface, s)}
                    layout={sl}
                    tools={tools}
                    zoom={1}
                    editor={editor.ops}
                    gestures={gestures}
                    selection={null}
                    setSelection={() => undefined}
                    selectedBlockId={null}
                    setSelectedBlockId={() => undefined}
                    editingTextId={null}
                    setEditingTextId={() => undefined}
                    onEditLatex={() => undefined}
                    printMode
                    scrollRoot={null}
                  />
                </div>
              </div>
            ))}
          </div>,
          document.body
        )}

      <ExportModal isOpen={exportOpen} onClose={() => setExportOpen(false)} document={doc} onPdf={exportPdf} onPrint={printNote} onError={(m) => showToast(m, true)} />
    </div>
  );
};

