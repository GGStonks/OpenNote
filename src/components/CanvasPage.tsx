import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Maximize2 } from 'lucide-react';
import {
  EraserMode, FillType, LatexBlock, LineStyle, NotePage, PAGE_HEIGHT, PAGE_WIDTH, PaperColor, PaperStyle, PenStyle, Point, ShapeMode, Stroke,
  TextBlock, ToolType, newId,
} from '../types';
import { drawLiveStroke, drawStroke, drawStrokes, eraseStrokesPartial, strokeHitTest, InkStyle, strokeToSvg } from '../ink/strokeRenderer';
import { detectShape } from '../services/shapeRecognition';
import { PageOps } from '../state/useNoteEditor';
import { SmartPenOptions, SmartPenState, beginSmartPen, moveSmartPen, smartPenShape, smartPenStroke } from '../editor/smartPen';
import { haptic } from '../platform';
import { GestureBus } from '../editor/gestures';
import { Selection, selectInLasso, singleBlockSelection, transformSelection } from '../editor/selection';
import { ImageBlockView, LatexBlockView, TextBlockView } from './Blocks';

export interface ToolSettings {
  tool: ToolType;
  penColor: string;
  penWidth: number;
  penStyle: PenStyle;
  highlighterColor: string;
  highlighterWidth: number;
  eraserMode: EraserMode;
  eraserSize: number;
  stylusOnly: boolean;
  holdToSnap: boolean;
  /** Smart pen (PDEDraw engine). Uses the pen colour and width. */
  shapeMode: ShapeMode;
  shapeFill: FillType;
  shapeArrow: boolean;
  shapeLineStyle: LineStyle;
  shapeSnap: boolean;
}

interface CanvasPageProps {
  page: NotePage;
  pageIndex: number;
  paperStyle: PaperStyle;
  paperColor: PaperColor;
  tools: ToolSettings;
  zoom: number;
  editor: PageOps;
  gestures: GestureBus;
  selection: Selection | null;
  setSelection: (s: Selection | null) => void;
  selectedBlockId: string | null;
  setSelectedBlockId: (id: string | null) => void;
  editingTextId: string | null;
  setEditingTextId: (id: string | null) => void;
  onEditLatex: (pageId: string, block: LatexBlock) => void;
  printMode: boolean;
  scrollRoot: HTMLElement | null;
}

export const PAPER_COLORS: Record<PaperColor, string> = {
  white: '#FFFFFF',
  cream: '#FBF7EE',
  yellow: '#FEF9C3',
  dark: '#1C1C1F',
};

/** Paper patterns as CSS backgrounds (no canvas memory, prints as vectors). */
export function paperBackground(style: PaperStyle, color: PaperColor): React.CSSProperties {
  const dark = color === 'dark';
  const base = PAPER_COLORS[color];
  const line = dark ? 'rgba(255,255,255,0.13)' : 'rgba(59,130,246,0.22)';
  const grid = dark ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.08)';
  const margin = dark ? 'rgba(239,68,68,0.35)' : 'rgba(239,68,68,0.4)';
  const css: React.CSSProperties = { backgroundColor: base };
  if (style === 'ruled') {
    css.backgroundImage = [
      `linear-gradient(to right, transparent 79px, ${margin} 79px, ${margin} 80px, transparent 80px)`,
      `linear-gradient(${base}, ${base})`,
      `linear-gradient(to bottom, transparent 31px, ${line} 31px, ${line} 32px)`,
    ].join(',');
    css.backgroundSize = `100% 100%, 100% 79px, 100% 32px`;
    css.backgroundPosition = `0 0, 0 0, 0 48px`;
    css.backgroundRepeat = 'no-repeat, no-repeat, repeat';
  } else if (style === 'grid') {
    css.backgroundImage = `linear-gradient(to right, ${grid} 1px, transparent 1px), linear-gradient(to bottom, ${grid} 1px, transparent 1px)`;
    css.backgroundSize = '24px 24px';
  } else if (style === 'dots') {
    css.backgroundImage = `radial-gradient(circle, ${dark ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.22)'} 1.3px, transparent 1.7px)`;
    css.backgroundSize = '24px 24px';
    css.backgroundPosition = '12px 12px';
  }
  return css;
}

const MAX_CANVAS_PIXELS = 16_000_000;

/**
 * Backing-store scale of the page canvases. Quantised in half-zoom steps so that zooming does not
 * reallocate and repaint the canvases for every small zoom change.
 */
function canvasRatio(zoom: number): number {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const z = Math.ceil(Math.max(1, Math.min(zoom, 2.5)) * 2) / 2;
  const maxByBudget = Math.sqrt(MAX_CANVAS_PIXELS / (PAGE_WIDTH * PAGE_HEIGHT));
  return Math.max(1, Math.min(dpr * z, maxByBudget));
}

function setupCanvas(canvas: HTMLCanvasElement, ratio: number): CanvasRenderingContext2D | null {
  const w = Math.round(PAGE_WIDTH * ratio);
  const h = Math.round(PAGE_HEIGHT * ratio);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  ctx?.setTransform(ratio, 0, 0, ratio, 0, 0);
  return ctx;
}

/**
 * Only one page at a time keeps a full-size live-ink canvas (the one being written on); the others
 * release theirs. A page canvas is up to 16 Mpx (64 MB) and WebKit has a tight total canvas budget.
 */
let liveOwner: { release: () => void } | null = null;

function stylusAngles(e: PointerEvent): { alt?: number; az?: number } {
  const anyE = e as PointerEvent & { altitudeAngle?: number; azimuthAngle?: number };
  if (e.pointerType !== 'pen') return {};
  if (typeof anyE.altitudeAngle === 'number') return { alt: anyE.altitudeAngle, az: anyE.azimuthAngle };
  if (e.tiltX || e.tiltY) {
    const tx = (e.tiltX * Math.PI) / 180, ty = (e.tiltY * Math.PI) / 180;
    return { alt: Math.PI / 2 - Math.atan(Math.hypot(Math.tan(tx), Math.tan(ty))), az: Math.atan2(Math.tan(ty), Math.tan(tx)) };
  }
  return {};
}

type DirtyRect = { minX: number; minY: number; maxX: number; maxY: number };

function unionRect(a: DirtyRect | null, b: DirtyRect | null): DirtyRect | null {
  if (!a) return b;
  if (!b) return a;
  return { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) };
}

const CanvasPageImpl: React.FC<CanvasPageProps> = (props) => {
  const {
    page, pageIndex, paperStyle, paperColor, tools, zoom, editor, gestures, selection, setSelection,
    selectedBlockId, setSelectedBlockId, editingTextId, setEditingTextId, onEditLatex, printMode, scrollRoot,
  } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const strokeCanvasRef = useRef<HTMLCanvasElement>(null);
  const activeCanvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(pageIndex < 2);
  const darkPaper = paperColor === 'dark';
  const defaultInk = darkPaper ? '#F3F4F6' : '#111827';
  const pageRef = useRef(page);
  pageRef.current = page;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  // Only pages near the viewport get canvases (memory on long notes).
  useEffect(() => {
    const el = containerRef.current;
    if (!el || printMode) return;
    const io = new IntersectionObserver((entries) => setVisible(entries.some((en) => en.isIntersecting)), {
      root: scrollRoot,
      rootMargin: '100% 0px',
    });
    io.observe(el);
    return () => io.disconnect();
  }, [scrollRoot, printMode]);

  // Committed ink. Strokes appended on top (the common case while writing) are painted
  // incrementally; anything else repaints the page.
  const ratio = canvasRatio(zoom);
  const painted = useRef<{ strokes: Stroke[]; ratio: number } | null>(null);
  useLayoutEffect(() => {
    const canvas = strokeCanvasRef.current;
    if (!canvas || !visible) {
      painted.current = null;
      return;
    }
    const prev = painted.current;
    const strokes = page.strokes;
    const appendOnly =
      prev &&
      prev.ratio === ratio &&
      strokes.length > prev.strokes.length &&
      prev.strokes.every((s, i) => strokes[i] === s) &&
      strokes.slice(prev.strokes.length).every((s) => s.tool !== 'highlighter' && (!s.fill || s.fill === 'none'));
    const ctx = setupCanvas(canvas, ratio);
    if (!ctx) return;
    if (appendOnly) {
      for (const s of strokes.slice(prev!.strokes.length)) drawStroke(ctx, s);
    } else {
      ctx.clearRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT);
      drawStrokes(ctx, strokes);
    }
    painted.current = { strokes, ratio };
  }, [page.strokes, ratio, visible]);

  // ------------------------------------------------------------------ live layer
  const liveHandle = useRef<{ release: () => void } | null>(null);
  const dirty = useRef<DirtyRect | null>(null);

  const claimLive = useCallback((): CanvasRenderingContext2D | null => {
    const canvas = activeCanvasRef.current;
    if (!canvas) return null;
    if (!liveHandle.current) {
      liveHandle.current = {
        release: () => {
          const c = activeCanvasRef.current;
          if (c) {
            c.width = 0;
            c.height = 0;
          }
          dirty.current = null;
        },
      };
    }
    if (liveOwner !== liveHandle.current) {
      liveOwner?.release();
      liveOwner = liveHandle.current;
      dirty.current = null;
    }
    const fresh = canvas.width === 0;
    const ctx = setupCanvas(canvas, canvasRatio(zoomRef.current));
    if (ctx && fresh) ctx.clearRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT);
    return ctx;
  }, []);

  // Release the live canvas when the page scrolls away or unmounts.
  useEffect(() => {
    if (visible) return;
    if (liveHandle.current && liveOwner === liveHandle.current) {
      liveOwner = null;
      liveHandle.current.release();
    }
  }, [visible]);
  useEffect(
    () => () => {
      if (liveHandle.current && liveOwner === liveHandle.current) liveOwner = null;
    },
    []
  );

  // Zoom changed: resize the live canvas if this page owns it.
  useLayoutEffect(() => {
    const c = activeCanvasRef.current;
    if (c && visible && liveHandle.current && liveOwner === liveHandle.current && c.width > 0) {
      setupCanvas(c, ratio);
      dirty.current = null;
    }
  }, [ratio, visible]);

  // iPadOS Scribble / system gestures: Pencil strokes on the canvas must never be interpreted as
  // handwriting input or scrolling, which delays and drops strokes.
  useEffect(() => {
    const c = activeCanvasRef.current;
    if (!c) return;
    const block = (e: TouchEvent) => {
      if (e.cancelable) e.preventDefault();
    };
    c.addEventListener('touchstart', block, { passive: false });
    c.addEventListener('touchmove', block, { passive: false });
    return () => {
      c.removeEventListener('touchstart', block);
      c.removeEventListener('touchmove', block);
    };
  }, [visible, printMode]);

  // ------------------------------------------------------------------ input state
  const drawing = useRef<{
    pointerId: number;
    pointerType: string;
    tool: ToolType;
    points: Point[];
    predicted: Point[];
    start: number;
    snapped: { points: Point[]; closed: boolean; kind: Stroke['shapeKind'] } | null;
    holdTimer: ReturnType<typeof setTimeout> | null;
    lastMove: { x: number; y: number };
    smart: SmartPenState | null;
    pressure: number;
  } | null>(null);
  const raf = useRef<number | null>(null);
  const eraserPos = useRef<{ x: number; y: number } | null>(null);
  const toolsRef = useRef(tools);
  toolsRef.current = tools;

  const liveStyle = (tool: ToolType): InkStyle => {
    const t = toolsRef.current;
    return tool === 'highlighter'
      ? { tool: 'highlighter', color: t.highlighterColor, width: t.highlighterWidth, penStyle: 'ballpoint' }
      : { tool: 'pen', color: t.penColor, width: t.penWidth, penStyle: t.penStyle };
  };

  const smartOptions = (): SmartPenOptions => {
    const t = toolsRef.current;
    return { mode: t.shapeMode, color: t.penColor, width: t.penWidth, fill: t.shapeFill, arrow: t.shapeArrow, lineStyle: t.shapeLineStyle, snap: t.shapeSnap };
  };

  const renderActive = () => {
    raf.current = null;
    const canvas = activeCanvasRef.current;
    if (!canvas || canvas.width === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const prev = dirty.current;
    if (prev) ctx.clearRect(prev.minX - 3, prev.minY - 3, prev.maxX - prev.minX + 6, prev.maxY - prev.minY + 6);
    let next: DirtyRect | null = null;
    const d = drawing.current;
    const k = 1 / Math.max(0.3, zoomRef.current);
    if (d && d.smart) {
      const opts = smartOptions();
      const shape = smartPenShape(d.smart, false);
      if (shape) {
        next = drawLiveStroke(ctx, shape.points, {
          tool: 'pen', color: opts.color, width: opts.width, penStyle: 'ballpoint', isShape: true, closed: shape.closed, shapeKind: shape.kind,
          lineStyle: shape.kind === 'point' ? 'solid' : opts.lineStyle,
          fill: shape.closed ? opts.fill : undefined,
          arrow: !shape.closed && opts.arrow,
        });
      }
      const dot = d.smart.snapDot;
      if (dot) {
        const r = 6 * k;
        ctx.save();
        ctx.fillStyle = '#F97316';
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 2 * k;
        ctx.beginPath();
        ctx.arc(dot.x, dot.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
        next = unionRect(next, { minX: dot.x - r - 2 * k, minY: dot.y - r - 2 * k, maxX: dot.x + r + 2 * k, maxY: dot.y + r + 2 * k });
      }
    } else if (d && (d.tool === 'pen' || d.tool === 'highlighter')) {
      if (d.snapped) {
        next = drawLiveStroke(ctx, d.snapped.points, { ...liveStyle(d.tool), isShape: true, closed: d.snapped.closed, shapeKind: d.snapped.kind });
      } else {
        next = drawLiveStroke(ctx, d.predicted.length ? [...d.points, ...d.predicted] : d.points, liveStyle(d.tool));
      }
    } else if (d && d.tool === 'lasso' && d.points.length > 1) {
      ctx.save();
      ctx.strokeStyle = '#3B82F6';
      ctx.lineWidth = 1.5 * k;
      ctx.setLineDash([6 * k, 5 * k]);
      ctx.fillStyle = 'rgba(59,130,246,0.07)';
      ctx.beginPath();
      ctx.moveTo(d.points[0].x, d.points[0].y);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of d.points) {
        ctx.lineTo(p.x, p.y);
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      next = { minX: minX - 2 * k, minY: minY - 2 * k, maxX: maxX + 2 * k, maxY: maxY + 2 * k };
    }
    const ep = eraserPos.current;
    if (ep && (d?.tool === 'eraser' || !d)) {
      const r = toolsRef.current.eraserSize;
      ctx.save();
      ctx.strokeStyle = 'rgba(100,116,139,0.9)';
      ctx.fillStyle = 'rgba(148,163,184,0.15)';
      ctx.lineWidth = k;
      ctx.beginPath();
      ctx.arc(ep.x, ep.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      next = unionRect(next, { minX: ep.x - r - 2, minY: ep.y - r - 2, maxX: ep.x + r + 2, maxY: ep.y + r + 2 });
    }
    dirty.current = next;
  };
  const renderRef = useRef(renderActive);
  renderRef.current = renderActive;

  const requestRender = useCallback(() => {
    if (raf.current === null) raf.current = requestAnimationFrame(() => renderRef.current());
  }, []);

  const clearActive = useCallback(() => {
    drawing.current = null;
    eraserPos.current = null;
    requestRender();
  }, [requestRender]);

  // A pinch starting with a finger that was drawing cancels that stroke.
  useEffect(
    () =>
      gestures.onCancel(() => {
        const d = drawing.current;
        if (d && d.pointerType === 'touch') {
          if (d.holdTimer) clearTimeout(d.holdTimer);
          if (d.tool === 'eraser') editor.endGesture();
          clearActive();
        }
      }),
    [gestures, clearActive, editor]
  );

  // getBoundingClientRect forces layout: measure once per input event, not per coalesced sample.
  const rectCache = useRef<DOMRect | null>(null);
  const canvasRect = () => (rectCache.current ??= activeCanvasRef.current!.getBoundingClientRect());

  const toPoint = (e: { clientX: number; clientY: number; pressure: number; pointerType: string }, start: number, angles = {}): Point => {
    const rect = canvasRect();
    return {
      x: ((e.clientX - rect.left) * PAGE_WIDTH) / rect.width,
      y: ((e.clientY - rect.top) * PAGE_HEIGHT) / rect.height,
      pressure: e.pointerType === 'pen' ? (e.pressure > 0 ? e.pressure : 0.5) : 0.5,
      t: Math.round(performance.now() - start),
      ...angles,
    };
  };

  const eraseAt = (x: number, y: number) => {
    const r = toolsRef.current.eraserSize;
    if (toolsRef.current.eraserMode === 'partial') {
      editor.previewPage(page.id, (p) => {
        const res = eraseStrokesPartial(p.strokes, x, y, r, () => newId('stroke'));
        return res.changed ? { ...p, strokes: res.strokes } : p;
      });
    } else {
      editor.previewPage(page.id, (p) => {
        const keep = p.strokes.filter((s) => !strokeHitTest(s, x, y, r));
        return keep.length === p.strokes.length ? p : { ...p, strokes: keep };
      });
    }
  };

  const armHoldToSnap = () => {
    const d = drawing.current;
    if (!d || d.tool !== 'pen' || !toolsRef.current.holdToSnap || d.snapped) return;
    if (d.holdTimer) clearTimeout(d.holdTimer);
    d.holdTimer = setTimeout(() => {
      const cur = drawing.current;
      if (!cur || cur !== d || cur.points.length < 6) return;
      const shape = detectShape(cur.points);
      if (shape) {
        cur.snapped = { points: shape.points, closed: shape.closed, kind: shape.kind };
        haptic('snap');
        requestRender();
      }
    }, 550);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const tool = tools.tool;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (tool === 'hand') return;
    if (e.pointerType === 'touch' && (tools.stylusOnly || gestures.touches > 1 || gestures.navigating)) return;
    const existing = drawing.current;
    if (existing) {
      // Palm rejection: a pencil touching down replaces a finger/palm stroke in progress.
      if (existing.pointerType === 'touch' && e.pointerType === 'pen') {
        if (existing.holdTimer) clearTimeout(existing.holdTimer);
        drawing.current = null;
      } else if (existing.pointerId === e.pointerId || e.pointerType === existing.pointerType) {
        // A pointerup was lost (e.g. pointer capture dropped by the system): finish the old stroke
        // instead of ignoring every following stroke.
        finishStroke(existing, false);
      } else return;
    }
    e.preventDefault();
    if (selectedBlockId) setSelectedBlockId(null);

    if (tool === 'text') {
      if (editingTextId) {
        setEditingTextId(null);
        return;
      }
      const pt = toPoint(e, performance.now());
      const block: TextBlock = {
        id: newId('text'),
        x: pt.x,
        y: pt.y - 14,
        width: Math.max(160, Math.min(520, PAGE_WIDTH - pt.x - 32)),
        text: '',
        fontSize: 18,
        color: '#111827',
        createdAt: Date.now(),
      };
      editor.commitPage(page.id, (p) => ({ ...p, textBlocks: [...(p.textBlocks ?? []), block] }));
      setEditingTextId(block.id);
      return;
    }

    if (selection && tool !== 'lasso') setSelection(null);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    rectCache.current = null;
    claimLive();
    const start = performance.now();
    const pt = toPoint(e, start, stylusAngles(e.nativeEvent));
    drawing.current = {
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      tool,
      points: [pt],
      predicted: [],
      start,
      snapped: null,
      holdTimer: null,
      lastMove: { x: pt.x, y: pt.y },
      smart: tool === 'shape' ? beginSmartPen(pt, smartOptions(), page.strokes, zoomRef.current) : null,
      pressure: pt.pressure,
    };
    if (drawing.current.smart?.snapDot) haptic('snap');
    if (tool === 'lasso') setSelection(null);
    if (tool === 'eraser') {
      editor.beginGesture();
      eraserPos.current = pt;
      eraseAt(pt.x, pt.y);
    }
    requestRender();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drawing.current;
    if (!d) {
      // Hover preview of the eraser (Apple Pencil hover / mouse).
      if (tools.tool === 'eraser' && e.pointerType !== 'touch') {
        if (!claimLive()) return;
        rectCache.current = null;
        const pt = toPoint(e, performance.now());
        eraserPos.current = { x: pt.x, y: pt.y };
        requestRender();
      }
      return;
    }
    if (e.pointerId !== d.pointerId) return;
    rectCache.current = null;
    const native = e.nativeEvent;
    const coalesced: PointerEvent[] = native.getCoalescedEvents ? native.getCoalescedEvents() : [];
    const events = coalesced.length ? coalesced : [native];
    let snapTick = false;
    for (const ce of events) {
      const pt = toPoint(ce, d.start, stylusAngles(ce));
      const last = d.points[d.points.length - 1];
      if (Math.abs(pt.x - last.x) < 0.2 && Math.abs(pt.y - last.y) < 0.2) continue;
      // Light smoothing of the Pencil's force signal: raw values jitter and made the fountain-pen
      // outline wobble.
      d.pressure = d.pressure * 0.55 + pt.pressure * 0.45;
      pt.pressure = d.pressure;
      d.points.push(pt);
      if (d.smart) snapTick = moveSmartPen(d.smart, pt) || snapTick;
      else if (d.tool === 'eraser') {
        eraserPos.current = pt;
        eraseAt(pt.x, pt.y);
      }
    }
    if (snapTick) haptic('snap');
    if (!d.smart && (d.tool === 'pen' || d.tool === 'highlighter')) {
      const predicted = native.getPredictedEvents ? native.getPredictedEvents() : [];
      d.predicted = predicted.slice(0, 2).map((pe) => ({ ...toPoint(pe, d.start), pressure: d.pressure }));
      const last = d.points[d.points.length - 1];
      if (!d.snapped && Math.hypot(last.x - d.lastMove.x, last.y - d.lastMove.y) > 3) {
        d.lastMove = { x: last.x, y: last.y };
        armHoldToSnap();
      }
    }
    requestRender();
  };

  function finishStroke(d: NonNullable<typeof drawing.current>, cancelled: boolean, pointerType?: string) {
    if (d.holdTimer) clearTimeout(d.holdTimer);
    drawing.current = null;

    if (!cancelled && d.smart) {
      const stroke = smartPenStroke(d.smart, smartOptions(), newId('stroke'));
      if (stroke) {
        editor.commitPage(page.id, (p) => ({ ...p, strokes: [...p.strokes, stroke] }));
        if (stroke.closed && d.smart.closing) haptic('success');
      }
    } else if (!cancelled && (d.tool === 'pen' || d.tool === 'highlighter')) {
      const style = liveStyle(d.tool);
      const stroke: Stroke = {
        id: newId('stroke'),
        tool: d.tool,
        color: style.color,
        width: style.width,
        opacity: 1,
        penStyle: style.penStyle,
        lineStyle: 'solid',
        points: d.snapped ? d.snapped.points : d.points,
        ...(d.snapped ? { isShape: true, closed: d.snapped.closed, shapeKind: d.snapped.kind } : {}),
      };
      editor.commitPage(page.id, (p) => ({ ...p, strokes: [...p.strokes, stroke] }));
    } else if (d.tool === 'eraser') {
      editor.endGesture();
      if (pointerType === 'touch') eraserPos.current = null;
    } else if (!cancelled && d.tool === 'lasso') {
      if (d.points.length > 3) setSelection(selectInLasso(pageRef.current, d.points));
    }
    // The committed canvas paints in the same frame as React's commit (layout effect), so the
    // live layer can be cleared on the next frame without flicker.
    requestRender();
  }

  const finish = (e: React.PointerEvent<HTMLCanvasElement>, cancelled: boolean) => {
    const d = drawing.current;
    if (!d || e.pointerId !== d.pointerId) return;
    rectCache.current = null;
    if (!cancelled && d.tool !== 'eraser' && d.tool !== 'lasso') {
      // Include the final sample of the stroke.
      const pt = toPoint(e, d.start, stylusAngles(e.nativeEvent));
      const last = d.points[d.points.length - 1];
      if (Math.hypot(pt.x - last.x, pt.y - last.y) > 0.2) {
        pt.pressure = d.pressure;
        d.points.push(pt);
        if (d.smart) moveSmartPen(d.smart, pt);
      }
    }
    finishStroke(d, cancelled, e.pointerType);
  };

  // ------------------------------------------------------------------ selection transform
  const transform = useRef<{ mode: 'move' | 'scale'; startX: number; startY: number; snapshot: NotePage; sel: Selection; pointerId: number } | null>(null);
  const [liveBounds, setLiveBounds] = useState<Selection['bounds'] | null>(null);
  const shownBounds = liveBounds ?? selection?.bounds ?? null;

  const startTransform = (e: React.PointerEvent, mode: 'move' | 'scale') => {
    if (!selection) return;
    if (e.pointerType === 'touch' && tools.stylusOnly && mode === 'move' && gestures.touches > 1) return;
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    editor.beginGesture();
    transform.current = { mode, startX: e.clientX, startY: e.clientY, snapshot: page, sel: selection, pointerId: e.pointerId };
  };

  const moveTransform = (e: React.PointerEvent) => {
    const t = transform.current;
    if (!t || e.pointerId !== t.pointerId) return;
    e.stopPropagation();
    const dx = (e.clientX - t.startX) / zoom;
    const dy = (e.clientY - t.startY) / zoom;
    const b = t.sel.bounds;
    if (t.mode === 'move') {
      editor.previewPage(page.id, () => transformSelection(t.snapshot, t.sel, dx, dy, 1));
      setLiveBounds({ ...b, x: b.x + dx, y: b.y + dy });
    } else {
      const f = Math.max(0.2, Math.min(5, Math.max((b.width + dx) / b.width, (b.height + dy) / b.height)));
      editor.previewPage(page.id, () => transformSelection(t.snapshot, t.sel, 0, 0, f));
      setLiveBounds({ ...b, width: b.width * f, height: b.height * f });
    }
  };

  const endTransform = (e: React.PointerEvent) => {
    const t = transform.current;
    if (!t || e.pointerId !== t.pointerId) return;
    transform.current = null;
    editor.endGesture();
    if (liveBounds) setSelection({ ...t.sel, bounds: liveBounds });
    setLiveBounds(null);
  };

  // ------------------------------------------------------------------ render
  const blocksInteractive = tools.tool === 'lasso' || tools.tool === 'text';
  const pageStyle: React.CSSProperties = {
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    ...paperBackground(paperStyle, paperColor),
  };

  const latexHandlers = (b: LatexBlock) => ({
    onSelect: () => {
      if (tools.tool === 'lasso') {
        setSelection(singleBlockSelection(page, 'latex', b.id));
        setSelectedBlockId(null);
      } else setSelectedBlockId(b.id);
    },
    onEdit: () => onEditLatex(page.id, b),
    onDelete: () => {
      setSelectedBlockId(null);
      editor.commitPage(page.id, (p) => ({ ...p, latexBlocks: p.latexBlocks.filter((x) => x.id !== b.id) }));
    },
    onSilentUpdate: (patch: Partial<LatexBlock>) =>
      editor.silentPage(page.id, (p) => ({ ...p, latexBlocks: p.latexBlocks.map((x) => (x.id === b.id ? { ...x, ...patch } : x)) })),
  });

  return (
    <div
      ref={containerRef}
      className="on-page relative select-none shadow-[0_4px_24px_rgba(0,0,0,0.12)] rounded-[3px] overflow-hidden"
      style={pageStyle}
      data-page-index={pageIndex}
    >
      {printMode ? (
        <svg className="absolute inset-0" width={PAGE_WIDTH} height={PAGE_HEIGHT} viewBox={`0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}`}
          dangerouslySetInnerHTML={{
            __html: [...page.strokes.filter((s) => s.tool === 'highlighter'), ...page.strokes.filter((s) => s.tool !== 'highlighter')].map((s) => strokeToSvg(s, 0, PAPER_COLORS[paperColor])).join(''),
          }}
        />
      ) : visible ? (
        <canvas ref={strokeCanvasRef} className="absolute inset-0 pointer-events-none" style={{ width: PAGE_WIDTH, height: PAGE_HEIGHT }} />
      ) : null}

      {/* Typed / converted content */}
      {(page.imageBlocks ?? []).map((im) => (
        <ImageBlockView key={im.id} block={im} selected={!!selection?.imageIds.includes(im.id)} />
      ))}
      {page.latexBlocks.map((b) => (
        <LatexBlockView
          key={b.id}
          block={b}
          inkColor={defaultInk}
          darkPaper={darkPaper}
          interactive={blocksInteractive && !printMode}
          selected={selectedBlockId === b.id}
          zoom={zoom}
          measure={!printMode}
          {...latexHandlers(b)}
        />
      ))}
      {(page.textBlocks ?? []).map((t) => (
        <TextBlockView
          key={t.id}
          block={t}
          interactive={blocksInteractive && !printMode}
          editing={editingTextId === t.id}
          selected={false}
          zoom={zoom}
          darkPaper={darkPaper}
          onStartEdit={() => {
            if (tools.tool === 'lasso') setSelection(singleBlockSelection(page, 'text', t.id));
            else setEditingTextId(t.id);
          }}
          onCommit={(text) => {
            setEditingTextId(null);
            if (!text.trim()) editor.commitPage(page.id, (p) => ({ ...p, textBlocks: (p.textBlocks ?? []).filter((x) => x.id !== t.id) }));
            else if (text !== t.text) editor.commitPage(page.id, (p) => ({ ...p, textBlocks: (p.textBlocks ?? []).map((x) => (x.id === t.id ? { ...x, text } : x)) }));
          }}
          onDelete={() => editor.commitPage(page.id, (p) => ({ ...p, textBlocks: (p.textBlocks ?? []).filter((x) => x.id !== t.id) }))}
          onSilentUpdate={() => undefined}
        />
      ))}

      {/* Input layer (pen, highlighter, eraser, lasso, text placement) */}
      {visible && !printMode && (
        <canvas
          ref={activeCanvasRef}
          className="absolute inset-0 z-10"
          style={{
            width: PAGE_WIDTH,
            height: PAGE_HEIGHT,
            touchAction: 'none',
            pointerEvents: tools.tool === 'hand' ? 'none' : 'auto',
            cursor: tools.tool === 'text' ? 'text' : tools.tool === 'eraser' ? 'cell' : 'crosshair',
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => finish(e, false)}
          onPointerCancel={(e) => finish(e, true)}
          onPointerLeave={() => {
            if (!drawing.current && eraserPos.current) {
              eraserPos.current = null;
              requestRender();
            }
          }}
        />
      )}

      {/* Lasso selection box */}
      {shownBounds && selection && !printMode && (
        <div
          className="absolute z-20 border-2 border-dashed border-blue-500 bg-blue-500/5 rounded-lg cursor-move"
          style={{ left: shownBounds.x, top: shownBounds.y, width: shownBounds.width, height: shownBounds.height, touchAction: 'none' }}
          onPointerDown={(e) => startTransform(e, 'move')}
          onPointerMove={moveTransform}
          onPointerUp={endTransform}
          onPointerCancel={endTransform}
        >
          <div
            className="absolute -right-3 -bottom-3 w-7 h-7 bg-blue-600 text-white rounded-full flex items-center justify-center shadow-md cursor-nwse-resize"
            style={{ transform: `scale(${Math.max(1, 1 / zoom)})`, touchAction: 'none' }}
            onPointerDown={(e) => startTransform(e, 'scale')}
            onPointerMove={moveTransform}
            onPointerUp={endTransform}
            onPointerCancel={endTransform}
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </div>
        </div>
      )}

      {!printMode && (
        <div className="absolute bottom-2 right-4 text-[11px] font-medium text-gray-400 pointer-events-none">{pageIndex + 1}</div>
      )}
    </div>
  );
};

export const CanvasPage = React.memo(CanvasPageImpl);
