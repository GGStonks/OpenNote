import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import {
  Sparkles, Share2, Shapes, Copy, Trash2, X, Wand2, FileText, Loader2, AlertCircle, PaintBucket, MoveUpRight, Scissors, ClipboardCopy,
  ClipboardPaste, CopyPlus,
} from 'lucide-react';
import { copySelection, pasteClipboard, useClipboard } from '../editor/clipboard';
import { FillType, LatexBlock, NoteDocument, NotePage, PAGE_HEIGHT, PAGE_WIDTH, Rect, Stroke, newId, LineStyle } from '../types';
import { useNoteEditor } from '../state/useNoteEditor';
import { CanvasPage, ToolSettings } from './CanvasPage';
import { Toolbar } from './Toolbar';
import { LatexModal, LatexModalState } from './LatexModal';
import { ExportModal } from './ExportModal';
import { AudioRecorder } from './AudioRecorder';
import { GestureBus } from '../editor/gestures';
import { useViewport } from '../editor/useViewport';
import { Selection, computeBounds, isEmptySelection, removeSelection } from '../editor/selection';
import { AppSettings, saveSettings } from '../settings';
import { ConversionMode, convertImage } from '../services/vlmService';
import { boundsOfStrokes, renderInkImage } from '../services/rasterize';
import { DEFAULT_INKS, InkColorInfo, colorHint, enforceColors, inkColors } from '../services/inkColors';
import { renderLatexContent } from '../services/latexRender';
import { TikzLabel, convertStrokesToTikz, snapStroke } from '../services/shapeRecognition';
import { FILL_OPTIONS, FillSwatch } from './Toolbar';
import { bandSlice, bandStrokes, deleteBand, duplicateBand, surfacePageCount } from '../editor/surface';
import { printDocument } from '../platform';

const PAD = 16;
const CONTENT_WIDTH = PAGE_WIDTH + PAD * 2;

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
    penStyle: settings.penStyle,
    highlighterColor: '#FDE047',
    highlighterWidth: 4,
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
  /** The note's continuous surface (one NotePage; see editor/surface.ts). */
  const surface = doc.pages[0];
  const pageCount = useMemo(() => surfacePageCount(surface), [surface]);
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
  const { scrollRef, outerRef, zoom } = useViewport({ contentWidth: CONTENT_WIDTH, fingersNavigate, gestures, onFingerTap });
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);

  const [selection, setSelectionState] = useState<Selection | null>(null);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
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
  const [currentPage, setCurrentPage] = useState(0);

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

  // Track the page under the viewport centre.
  const onScroll = useCallback(() => {
    const el = scrollRef.current, outer = outerRef.current;
    if (!el || !outer) return;
    const y = (el.scrollTop + el.clientHeight / 3 - outer.offsetTop) / zoom - PAD;
    setCurrentPage(Math.max(0, Math.min(pageCount - 1, Math.floor(y / PAGE_HEIGHT))));
  }, [zoom, pageCount, scrollRef, outerRef]);

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
    const strokes = selPage.strokes.filter((s) => sel.strokeIds.includes(s.id)).map((s) => ({ ...s, id: newId('stroke'), points: s.points.map((p) => ({ ...p, x: p.x + off, y: p.y + off })) }));
    const latex = selPage.latexBlocks.filter((b) => sel.latexIds.includes(b.id)).map((b) => ({ ...b, id: newId('latex'), x: b.x + off, y: b.y + off }));
    const texts = (selPage.textBlocks ?? []).filter((b) => sel.textIds.includes(b.id)).map((b) => ({ ...b, id: newId('text'), x: b.x + off, y: b.y + off }));
    const images = (selPage.imageBlocks ?? []).filter((b) => sel.imageIds.includes(b.id)).map((b) => ({ ...b, id: newId('image'), x: b.x + off, y: b.y + off }));
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
    const el = scrollRef.current;
    const viewH = el ? el.clientHeight / zoom : PAGE_HEIGHT / 2;
    const res = pasteClipboard(surface, { x: PAGE_WIDTH / 2, y: visibleTopOnPage() + viewH / 2 }, PAGE_WIDTH);
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
    const page = surface;
    const ink = bandStrokes(surface, currentPage).filter((s) => s.tool === 'pen');
    const b = boundsOfStrokes(ink);
    if (!b) return showToast('This page has no handwriting to transcribe');
    const colors = inkColors(ink, b);
    const image = renderInkImage(ink, b, [], colors.colors.length > 1 ? new Map(colors.colors.map((c) => [c.hex, c.imageColor])) : undefined);
    void runConversion({ kind: 'insert', pageId: page.id, bounds: b, strokeIds: ink.map((s) => s.id), textIds: [], mode: 'text', image, hint: colorHint(colors, 'text') || undefined, colors });
  };

  const onModalInsert = (code: string, isTikz: boolean, replaceInk: boolean) => {
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
    const width =
      t.kind === 'insert' && !(mixedContent && !textual)
        ? textual
          ? Math.min(PAGE_WIDTH - at.x - 24, Math.max(t.bounds.width, 560))
          : Math.max(isTikz ? 160 : 60, t.bounds.width)
        : isTikz
          ? 360
          : mixedContent
            ? Math.min(PAGE_WIDTH - at.x - 24, 600)
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
    setTarget({ kind: 'new', pageId: surface.id, at: { x: 96, y: visibleTopOnPage() + 80 } });
    setModal({ latex: '', isTikz: false, origin: 'new', canReplaceInk: false });
  };

  // ------------------------------------------------------------------------- pages & media
  // Pages are bands of the surface (always one blank page at the end, see surfacePageCount).
  const duplicatePage = () => editor.commitPage(surface.id, (p) => duplicateBand(p, currentPage));

  const deletePage = () => {
    if (pageCount <= 1) return showToast('A note needs at least one page');
    if (!window.confirm(`Delete page ${currentPage + 1}? (Undo can bring it back)`)) return;
    editor.commitPage(surface.id, (p) => deleteBand(p, currentPage));
  };

  /** Surface y of the top of the viewport (for placing new content). */
  const visibleTopOnPage = () => {
    const el = scrollRef.current, outer = outerRef.current;
    if (!el || !outer) return 40;
    return Math.max(24, (el.scrollTop - outer.offsetTop) / zoom - PAD);
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
        const w = Math.min(PAGE_WIDTH - 160, c.width);
        const h = (w * c.height) / c.width;
        editor.commitPage(surface.id, (p) => ({
          ...p,
          imageBlocks: [...(p.imageBlocks ?? []), { id: newId('image'), x: (PAGE_WIDTH - w) / 2, y: visibleTopOnPage() + 60, width: w, height: h, dataUrl, createdAt: Date.now() }],
        }));
        setTools({ tool: 'lasso' });
        showToast('Image inserted — use the lasso to move or resize it');
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  };

  const exportPdf = async () => {
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
  const totalHeight = PAD * 2 + pageCount * PAGE_HEIGHT + 80;
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
        paperStyle={doc.paperStyle}
        setPaperStyle={(paperStyle) => editor.commit((d) => ({ ...d, paperStyle }))}
        paperColor={doc.paperColor}
        setPaperColor={(paperColor) => editor.commit((d) => ({ ...d, paperColor }))}
        onBack={async () => {
          await editor.flush();
          onBack();
        }}
        onConvertPage={convertPage}
        onExport={() => setExportOpen(true)}
        onSettings={onOpenSettings}
        onDuplicatePage={duplicatePage}
        onDeletePage={deletePage}
        onInsertLatex={insertLatexManually}
        onInsertImage={insertImage}
        onPaste={clipboard ? paste : undefined}
        currentPage={currentPage + 1}
        totalPages={pageCount}
        audioSlot={<AudioRecorder noteId={doc.id} onError={(m) => showToast(m, true)} />}
      />

      <div
        ref={(el) => {
          scrollRef.current = el;
          if (el !== scrollEl) setScrollEl(el);
        }}
        onScroll={onScroll}
        className="relative flex-1 overflow-y-auto overflow-x-hidden bg-[#E5E5EA] dark:bg-[#0E0E10]"
        style={{ touchAction: 'none', overscrollBehavior: 'contain' }}
      >
        <div ref={outerRef} style={{ width: CONTENT_WIDTH * zoom, height: totalHeight * zoom, margin: '0 auto', position: 'relative' }}>
          <div style={{ width: CONTENT_WIDTH, transform: `scale(${zoom})`, transformOrigin: '0 0', padding: PAD }}>
            {[surface].map((page) => (
              <div key={page.id}>
                <CanvasPage
                  page={page}
                  pageIndex={0}
                  pageCount={pageCount}
                  paperStyle={doc.paperStyle}
                  paperColor={doc.paperColor}
                  tools={tools}
                  zoom={zoom}
                  editor={editor.ops}
                  gestures={gestures}
                  selection={selection?.pageId === page.id ? selection : null}
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
            ))}
          </div>
        </div>
      </div>

      {/* Page indicator */}
      <div
        className="fixed right-4 z-30 pointer-events-none px-3 py-1.5 rounded-full bg-black/55 text-white text-xs font-semibold tabular-nums backdrop-blur"
        style={{ bottom: `calc(${selection ? 96 : 18}px + env(safe-area-inset-bottom))` }}
      >
        {currentPage + 1} / {pageCount}
      </div>

      {/* Paste (lasso tool, something copied, nothing selected) */}
      {!selection && clipboard && tools.tool === 'lasso' && (
        <div className="fixed left-0 right-0 z-40 flex justify-center px-3 pointer-events-none" style={{ bottom: `calc(16px + env(safe-area-inset-bottom))` }} data-no-pan>
          <button onClick={paste} className="pointer-events-auto flex items-center gap-2 bg-[#1C1C1E]/95 backdrop-blur-xl text-white rounded-3xl shadow-2xl ring-1 ring-white/10 px-4 py-2.5 text-sm font-semibold active:scale-95 transition" title="Paste the copied items here">
            <ClipboardPaste className="w-5 h-5" /> Paste
          </button>
        </div>
      )}

      {/* Selection action bar */}
      {selection && fillMenu && selectionHasInk && (
        <div className="fixed left-0 right-0 z-40 flex justify-center px-3" style={{ bottom: `calc(84px + env(safe-area-inset-bottom))` }} data-no-pan>
          <div className="flex items-center gap-1 bg-[#1C1C1E]/95 backdrop-blur-xl text-white rounded-3xl shadow-2xl ring-1 ring-white/10 px-2 py-2 text-xs font-semibold">
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
          <div className="flex items-center gap-1.5 bg-[#1C1C1E]/95 backdrop-blur-xl text-white rounded-3xl shadow-2xl ring-1 ring-white/10 px-2.5 py-2 overflow-x-auto max-w-full text-sm font-semibold">
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
          <div className="bg-white dark:bg-[#1C1C1E] px-6 py-5 rounded-3xl shadow-2xl flex flex-col items-center text-gray-900 dark:text-gray-100 max-w-xs text-center">
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
            {/* The surface cut into US Letter pages at the page lines (the trailing blank page is not printed). */}
            {Array.from({ length: Math.max(1, pageCount - 1) }, (_, k) => (
              <div key={k} className="on-print-page">
                <div style={{ transform: `translateY(${-k * PAGE_HEIGHT}px)` }}>
                <CanvasPage
                  page={bandSlice(surface, k)}
                  pageIndex={k}
                  pageCount={pageCount}
                  paperStyle={doc.paperStyle}
                  paperColor={doc.paperColor}
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

      <ExportModal isOpen={exportOpen} onClose={() => setExportOpen(false)} document={doc} onPdf={exportPdf} onError={(m) => showToast(m, true)} />
    </div>
  );
};

