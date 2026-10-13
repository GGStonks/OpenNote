import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Maximize2 } from 'lucide-react';
import {
  EraserMode, FillType, LatexBlock, LineStyle, NotePage, PAGE_HEIGHT, PAGE_WIDTH, PaperColor, PaperStyle, PenStyle, Point, ShapeMode, Stroke,
  TextBlock, ToolType, newId,
} from '../types';
import {
  capsulePath, drawLiveStroke, drawStroke, drawStrokes, eraseStrokesPartial, isVariableWidth, strokeHitTest, strokeWidth, InkStyle, strokeToSvg, styleOf,
} from '../ink/strokeRenderer';
import { ModeledPoint, pressureWidth, trimLiftOff } from '../ink/inkEngine';
import { NibModeler } from '../ink/nib';
import { RecordedSample, penRecorder } from '../ink/penRecorder';
import { PencilListener, PencilSample, nativePencil } from '../ink/nativePencil';
import { detectShape } from '../services/shapeRecognition';
import { PageOps } from '../state/useNoteEditor';
import {
  SmartPenOptions, SmartPenState, SnapCache, beginSmartPen, buildSnapCache, findSnapKind, moveSmartPen, smartPenMeasure, smartPenShape, smartPenStroke,
} from '../editor/smartPen';
import { ShapeHandle, SnapAdjust, adjustSnappedShape, dragHandle, shapeHandles } from '../editor/shapeEdit';
import { haptic } from '../platform';
import { GestureBus } from '../editor/gestures';
import { Selection, computeBounds, selectInLasso, singleBlockSelection, transformSelection } from '../editor/selection';
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
  /** Snap the smart pen to the lattice of grid / dot paper. */
  shapeGridSnap: boolean;
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
  /** Pages (PAGE_HEIGHT bands) the surface shows. */
  pageCount: number;
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

/** Lattice spacing of grid and dot paper (see paperBackground), or null for other papers. */
export function paperGrid(style: PaperStyle): number | null {
  return style === 'grid' || style === 'dots' ? 24 : null;
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

const strokeBoxes = new WeakMap<Stroke, { minY: number; maxY: number }>();

function strokeYRange(s: Stroke) {
  let r = strokeBoxes.get(s);
  if (!r) {
    let minY = Infinity, maxY = -Infinity;
    for (const p of s.points) {
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const pad = (s.tool === 'highlighter' ? s.width * 3 : s.width * 2) + 12;
    r = { minY: minY - pad, maxY: maxY + pad };
    strokeBoxes.set(s, r);
  }
  return r;
}

/**
 * Committed ink of one page-high band of the surface. Tiles exist only near the viewport (a
 * canvas is up to 16 Mpx and WebKit has a tight total canvas budget). Strokes appended on top (the
 * common case while writing) are painted incrementally; anything else repaints the tile. Strokes
 * crossing a page line are painted by both tiles.
 */
const InkTile = React.memo(function InkTile(props: { band: number; strokes: Stroke[]; ratio: number; scrollRoot: HTMLElement | null }) {
  const { band, strokes, ratio, scrollRoot } = props;
  const holderRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(band < 2);
  useEffect(() => {
    const el = holderRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => setVisible(entries.some((en) => en.isIntersecting)), { root: scrollRoot, rootMargin: '100% 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [scrollRoot]);
  const top = band * PAGE_HEIGHT;
  const mine = useMemo(() => strokes.filter((s) => {
    const r = strokeYRange(s);
    return r.maxY >= top && r.minY <= top + PAGE_HEIGHT;
  }), [strokes, top]);
  const painted = useRef<{ strokes: Stroke[]; ratio: number } | null>(null);
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !visible) {
      painted.current = null;
      return;
    }
    const prev = painted.current;
    const appendOnly =
      prev &&
      prev.ratio === ratio &&
      mine.length > prev.strokes.length &&
      prev.strokes.every((s, i) => mine[i] === s) &&
      mine.slice(prev.strokes.length).every((s) => s.tool !== 'highlighter' && (!s.fill || s.fill === 'none'));
    const w = Math.round(PAGE_WIDTH * ratio), h = Math.round(PAGE_HEIGHT * ratio);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, -top * ratio);
    if (appendOnly) {
      for (const s of mine.slice(prev!.strokes.length)) drawStroke(ctx, s);
    } else {
      ctx.clearRect(0, top, PAGE_WIDTH, PAGE_HEIGHT);
      drawStrokes(ctx, mine);
    }
    painted.current = { strokes: mine, ratio };
  }, [mine, ratio, visible, top]);
  return (
    <div ref={holderRef} className="absolute left-0 pointer-events-none" style={{ top, width: PAGE_WIDTH, height: PAGE_HEIGHT }}>
      {visible && <canvas ref={canvasRef} style={{ width: PAGE_WIDTH, height: PAGE_HEIGHT }} />}
    </div>
  );
});

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

/** Snap indicator: orange for shapes (PDEDraw), a small blue dot for grid points. */
function drawSnapDot(ctx: CanvasRenderingContext2D, dot: { x: number; y: number }, grid: boolean, k: number): DirtyRect {
  const r = (grid ? 4 : 6) * k;
  ctx.save();
  ctx.fillStyle = grid ? '#3B82F6' : '#F97316';
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = 2 * k;
  ctx.beginPath();
  ctx.arc(dot.x, dot.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
  return { minX: dot.x - r - 2 * k, minY: dot.y - r - 2 * k, maxX: dot.x + r + 2 * k, maxY: dot.y + r + 2 * k };
}

/** Dimension label (length / angle / size) drawn next to the pen, constant size on screen. */
function drawMeasure(ctx: CanvasRenderingContext2D, text: string, at: { x: number; y: number }, k: number): DirtyRect {
  ctx.save();
  ctx.font = `600 ${12 * k}px -apple-system, system-ui, sans-serif`;
  const w = ctx.measureText(text).width + 12 * k;
  const h = 20 * k;
  // Above-right of the pen tip, kept on the page.
  const x = Math.min(PAGE_WIDTH - w - 2, Math.max(2, at.x + 14 * k));
  const y = Math.max(2, at.y - 14 * k - h);
  ctx.fillStyle = 'rgba(17,24,39,0.82)';
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, 6 * k);
  else ctx.rect(x, y, w, h);
  ctx.fill();
  ctx.fillStyle = '#FFFFFF';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 6 * k, y + h / 2);
  ctx.restore();
  return { minX: x - 1, minY: y - 1, maxX: x + w + 1, maxY: y + h + 1 };
}

function unionRect(a: DirtyRect | null, b: DirtyRect | null): DirtyRect | null {
  if (!a) return b;
  if (!b) return a;
  return { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) };
}


/** Time to wait for the iOS shell's first Pencil samples before using the web events. */
const NATIVE_GRACE_MS = 120;
/** The shell's samples stopped while web pointer events keep coming: switch to the web events. */
const NATIVE_STALL_MS = 60;
/** Longest wait for the shell's final samples after the web pointerup. */
const NATIVE_END_WAIT_MS = 80;

/** A raw sample for the pen recorder; `arrival` is when the app got it, on the stroke's clock. */
function recSample(pt: Point, force: number, start: number): RecordedSample {
  const r = (v: number, k = 100) => Math.round(v * k) / k;
  return [r(pt.x), r(pt.y), pt.t ?? 0, r(force > 0 ? force : 0, 10000), r(performance.now() - start, 10), r(pt.alt ?? 0, 1000), r(pt.az ?? 0, 1000)];
}

/** Event time on the performance.now() clock (coalesced samples carry their own time). */
function eventTime(e: { timeStamp?: number }): number {
  const now = performance.now();
  const ts = e.timeStamp;
  return typeof ts === 'number' && ts > 0 && Math.abs(now - ts) < 1000 ? ts : now;
}

/**
 * The Pencil's predicted sample, used to hide a frame of latency, only while the pen is not
 * slowing down and only half way: full predictions shot past the end of every stroke and were
 * then pulled back.
 */
function dampedPrediction(points: Point[], q: Point | null): Point[] {
  const n = points.length;
  if (!q || n < 3) return [];
  const [a, b, c] = [points[n - 3], points[n - 2], points[n - 1]];
  const speed = (u: Point, v: Point) => Math.hypot(v.x - u.x, v.y - u.y) / Math.max(1, (v.t ?? 0) - (u.t ?? 0));
  if (speed(b, c) < speed(a, b) * 0.9) return [];
  return [{ ...q, x: c.x + (q.x - c.x) * 0.5, y: c.y + (q.y - c.y) * 0.5 }];
}

const CanvasPageImpl: React.FC<CanvasPageProps> = (props) => {
  const {
    page, pageIndex, paperStyle, paperColor, tools, zoom, editor, gestures, selection, setSelection,
    selectedBlockId, setSelectedBlockId, editingTextId, setEditingTextId, onEditLatex, printMode, scrollRoot, pageCount,
  } = props;
  void pageIndex;
  const SURF_H = pageCount * PAGE_HEIGHT;
  const surfHRef = useRef(SURF_H);
  surfHRef.current = SURF_H;
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLDivElement>(null);
  const activeCanvasRef = useRef<HTMLCanvasElement>(null);
  const visible = true;
  const darkPaper = paperColor === 'dark';
  const defaultInk = darkPaper ? '#F3F4F6' : '#111827';
  const pageRef = useRef(page);
  pageRef.current = page;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const paperStyleRef = useRef(paperStyle);
  paperStyleRef.current = paperStyle;

  // Strokes being moved / reshaped are drawn on a floating or live layer instead of the page canvas.
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string> | null>(null);
  const shownStrokes = useMemo(() => (hiddenIds ? page.strokes.filter((s) => !hiddenIds.has(s.id)) : page.strokes), [page.strokes, hiddenIds]);

  const ratio = canvasRatio(zoom);

  // ------------------------------------------------------------------ live layer
  const dirty = useRef<DirtyRect | null>(null);
  /** Bands of the surface the live canvas currently covers. */
  const live = useRef<{ band: number; count: number; ratio: number } | null>(null);

  /**
   * The live canvas covers only the page bands visible on screen (2–3 at most), placed when a
   * stroke starts; ink drawn on it uses surface coordinates.
   */
  const claimLive = useCallback((): CanvasRenderingContext2D | null => {
    const canvas = activeCanvasRef.current, cont = containerRef.current;
    if (!canvas || !cont) return null;
    const H = surfHRef.current;
    const c = cont.getBoundingClientRect();
    const root = scrollRoot?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
    const scale = c.height / H || 1;
    const v0 = Math.max(0, (root.top - c.top) / scale), v1 = Math.min(H, (root.bottom - c.top) / scale);
    const pages = Math.max(1, Math.round(H / PAGE_HEIGHT));
    const b0 = Math.min(pages - 1, Math.floor(v0 / PAGE_HEIGHT));
    const b1 = Math.max(b0, Math.min(pages - 1, Math.floor((v1 - 0.01) / PAGE_HEIGHT)));
    const r = Math.min(canvasRatio(zoomRef.current), Math.sqrt(MAX_CANVAS_PIXELS / (PAGE_WIDTH * PAGE_HEIGHT * (b1 - b0 + 1))));
    const cur = live.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    if (cur && canvas.width > 0 && cur.band <= b0 && cur.band + cur.count - 1 >= b1 && Math.abs(cur.ratio - r) < 1e-6) return ctx;
    const count = b1 - b0 + 1;
    canvas.width = Math.round(PAGE_WIDTH * r);
    canvas.height = Math.round(PAGE_HEIGHT * count * r);
    canvas.style.top = `${b0 * PAGE_HEIGHT}px`;
    canvas.style.height = `${PAGE_HEIGHT * count}px`;
    ctx.setTransform(r, 0, 0, r, 0, -b0 * PAGE_HEIGHT * r);
    ctx.clearRect(0, b0 * PAGE_HEIGHT, PAGE_WIDTH, PAGE_HEIGHT * count);
    live.current = { band: b0, count, ratio: r };
    dirty.current = null;
    return ctx;
  }, [scrollRoot]);

  // Zoom changed (rotation): the live canvas is re-created at the next stroke.
  useLayoutEffect(() => {
    const c = activeCanvasRef.current;
    if (c && !drawing.current) {
      c.width = 0;
      c.height = 0;
      live.current = null;
      dirty.current = null;
    }
  }, [ratio]);

  // iPadOS Scribble / system gestures: Pencil strokes on the canvas must never be interpreted as
  // handwriting input or scrolling, which delays and drops strokes.
  useEffect(() => {
    const c = inputRef.current;
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
    /** After a hold-snap the pen keeps sizing the shape until it lifts. */
    adjust: SnapAdjust | null;
    holdTimer: ReturnType<typeof setTimeout> | null;
    lastMove: { x: number; y: number };
    smart: SmartPenState | null;
    pressure: number;
    /** Raw Pencil force of each sample (lift-off trimming). */
    force: number[];
    /** Handwriting model (pen tool): its settled points are drawn once, incrementally. */
    model: NibModeler | null;
    drawn: number;
    realPressure: boolean;
    inkRect: DirtyRect | null;
    /** iOS app: 240 Hz samples from the shell replace the web events' positions. */
    native: PencilListener | null;
    nativeSeen: boolean;
    /** The shell delivered this touch's final samples. */
    nativeEnded: boolean;
    /** performance.now() of the last delivery from the shell (stall detection). */
    lastNativeAt: number;
    /** Web samples held back while waiting for the shell's first samples (replayed on fallback). */
    webBuffer: PointerEvent[];
    /** Raw input of the stroke for the pen recorder (Settings > Diagnostics); null when off. */
    rec: RecordedSample[] | null;
    /** The pen lifted before the shell's last samples arrived: finish when they do. */
    finishPending: { cancelled: boolean; pointerType: string; timer: ReturnType<typeof setTimeout> } | null;
  } | null>(null);
  const tailCanvasRef = useRef<HTMLCanvasElement>(null);
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
    return {
      mode: t.shapeMode, color: t.penColor, width: t.penWidth, fill: t.shapeFill, arrow: t.shapeArrow, lineStyle: t.shapeLineStyle, snap: t.shapeSnap,
      grid: t.shapeGridSnap ? paperGrid(paperStyleRef.current) : null,
    };
  };

  const renderActive = () => {
    raf.current = null;
    const canvas = activeCanvasRef.current;
    if (!canvas || canvas.width === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const prev = unionRect(dirty.current, staleInk.current);
    staleInk.current = null;
    if (prev) ctx.clearRect(prev.minX - 3, prev.minY - 3, prev.maxX - prev.minX + 6, prev.maxY - prev.minY + 6);
    let next: DirtyRect | null = null;
    const d = drawing.current;
    const k = 1 / Math.max(0.3, zoomRef.current);
    const edit = handleDrag.current;
    if (edit) {
      next = unionRect(next, drawLiveStroke(ctx, edit.last.points, styleOf(edit.last)));
      if (edit.snapDot) next = unionRect(next, drawSnapDot(ctx, edit.snapDot, false, k));
    }
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
      if (dot) next = unionRect(next, drawSnapDot(ctx, dot, d.smart.snapKind === 'grid', k));
      const m = smartPenMeasure(d.smart);
      if (m) next = unionRect(next, drawMeasure(ctx, m.text, m.at, k));
    } else if (d && d.model && !d.snapped) {
      drawModeledInk(ctx, d);
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
      ctx.lineDashOffset = -((performance.now() / 40) % 11) * k;
      ctx.lineJoin = 'round';
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
  /** Settled live ink of a finished/cancelled stroke, cleared on the next frame. */
  const staleInk = useRef<DirtyRect | null>(null);

  const retireInk = (d: NonNullable<typeof drawing.current>) => {
    staleInk.current = unionRect(staleInk.current, d.inkRect);
    d.inkRect = null;
    const tc = tailCanvasRef.current;
    if (tc) tc.style.display = 'none';
  };

  /**
   * Live handwriting: the model's settled points never change, so only the ones that arrived since
   * the last frame are drawn (no per-frame redraw of the whole stroke). The provisional end —
   * catch-up to the pen plus the Pencil's predicted samples — is drawn on a small canvas that
   * follows the pen and is redrawn every frame.
   */
  function drawModeledInk(ctx: CanvasRenderingContext2D, d: NonNullable<typeof drawing.current>) {
    const m = d.model!;
    const style = liveStyle('pen');
    const base = strokeWidth({ ...style, isShape: false });
    const variable = isVariableWidth(style) && d.realPressure;
    const widthOf = (q: ModeledPoint) => (variable ? pressureWidth(base, q.p) : base);
    const pts = m.points;
    const paint = (c: CanvasRenderingContext2D, seq: ModeledPoint[], from: number) => {
      if (seq.length === 0) return;
      c.save();
      if (variable) {
        c.fillStyle = style.color;
        c.fill(capsulePath(seq, seq.map(widthOf), from));
      } else {
        c.strokeStyle = style.color;
        c.lineWidth = base;
        c.lineCap = 'round';
        c.lineJoin = 'round';
        c.beginPath();
        const s0 = seq[Math.max(0, from - 1)];
        c.moveTo(s0.x, s0.y);
        if (seq.length === 1) c.lineTo(s0.x + 0.01, s0.y);
        for (let i = Math.max(1, from); i < seq.length; i++) c.lineTo(seq[i].x, seq[i].y);
        c.stroke();
      }
      c.restore();
    };
    if (d.drawn < pts.length) {
      const from = Math.max(1, d.drawn);
      const seg = pts.slice(from - 1);
      paint(ctx, seg, d.drawn === 0 ? 0 : 1);
      let r = d.inkRect;
      const pad = base * 1.7 + 2;
      for (const q of seg) r = unionRect(r, { minX: q.x - pad, minY: q.y - pad, maxX: q.x + pad, maxY: q.y + pad });
      d.inkRect = r;
      d.drawn = pts.length;
    }
    // Provisional tail.
    const tc = tailCanvasRef.current;
    if (!tc) return;
    // The engine's own prediction (nib.ts), not the platform's predicted touches. Nothing may be
    // settled yet in the first milliseconds: then the tail is the whole stroke (or a dot).
    const tail = pts.length ? [pts[pts.length - 1], ...m.tail(true)] : m.tail(true);
    if (tail.length < (pts.length ? 2 : 1)) {
      tc.style.display = 'none';
      return;
    }
    const pad = base * 1.7 + 2;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const q of tail) {
      minX = Math.min(minX, q.x); minY = Math.min(minY, q.y); maxX = Math.max(maxX, q.x); maxY = Math.max(maxY, q.y);
    }
    minX = Math.floor(minX - pad); minY = Math.floor(minY - pad);
    const w = Math.ceil(maxX + pad - minX), h = Math.ceil(maxY + pad - minY);
    const r = canvasRatio(zoomRef.current);
    const cw = Math.ceil(w * r), ch = Math.ceil(h * r);
    if (tc.width < cw || tc.height < ch) {
      tc.width = Math.max(cw, tc.width, 64);
      tc.height = Math.max(ch, tc.height, 64);
    }
    tc.style.display = 'block';
    tc.style.left = `${minX}px`;
    tc.style.top = `${minY}px`;
    tc.style.width = `${tc.width / r}px`;
    tc.style.height = `${tc.height / r}px`;
    const tctx = tc.getContext('2d');
    if (!tctx) return;
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    tctx.clearRect(0, 0, tc.width, tc.height);
    tctx.setTransform(r, 0, 0, r, -minX * r, -minY * r);
    paint(tctx, tail, 0);
  }

  const renderRef = useRef(renderActive);
  renderRef.current = renderActive;

  const requestRender = useCallback(() => {
    if (raf.current === null) raf.current = requestAnimationFrame(() => renderRef.current());
  }, []);

  const clearActive = useCallback(() => {
    if (drawing.current) retireInk(drawing.current);
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
  const canvasRect = () => (rectCache.current ??= inputRef.current!.getBoundingClientRect());

  const toPoint = (e: { clientX: number; clientY: number; pressure: number; pointerType: string; timeStamp?: number }, start: number, angles = {}): Point => {
    const rect = canvasRect();
    return {
      x: ((e.clientX - rect.left) * PAGE_WIDTH) / rect.width,
      y: ((e.clientY - rect.top) * surfHRef.current) / rect.height,
      pressure: e.pointerType === 'pen' ? (e.pressure > 0 ? e.pressure : 0.5) : 0.5,
      t: Math.round((eventTime(e) - start) * 10) / 10,
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
        const pen = cur.points[cur.points.length - 1];
        cur.adjust = { kind: shape.kind, base: shape.points, closed: shape.closed, pen0: { x: pen.x, y: pen.y } };
        retireInk(cur);
        haptic('snap');
        requestRender();
      }
    }, 450);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const tool = tools.tool;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (tool === 'hand') return;
    if (e.pointerType === 'touch' && (tools.stylusOnly || gestures.touches > 1 || gestures.navigating)) return;
    const existing = drawing.current;
    if (existing) {
      // Palm rejection: a pencil touching down replaces a finger/palm stroke in progress.
      if (existing.pointerType === 'touch' && e.pointerType === 'pen') {
        if (existing.holdTimer) clearTimeout(existing.holdTimer);
        retireInk(existing);
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
    const start = eventTime(e.nativeEvent);
    const pt = toPoint(e, start, stylusAngles(e.nativeEvent));
    // The pen engine takes a force-less pen sample as unknown, not as the 0.5 fallback.
    if (tool === 'pen' && e.pointerType === 'pen' && !(e.pressure > 0)) pt.pressure = 0;
    drawing.current = {
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      tool,
      points: [pt],
      predicted: [],
      start,
      snapped: null,
      adjust: null,
      holdTimer: null,
      lastMove: { x: pt.x, y: pt.y },
      smart: tool === 'shape' ? beginSmartPen(pt, smartOptions(), page.strokes, zoomRef.current) : null,
      pressure: pt.pressure,
      force: [pt.pressure],
      model: tool === 'pen' ? new NibModeler() : null,
      drawn: 0,
      realPressure: e.pointerType === 'pen' && e.pressure > 0 && e.pressure !== 0.5,
      inkRect: null,
      native: null,
      nativeSeen: false,
      nativeEnded: false,
      lastNativeAt: 0,
      webBuffer: [],
      finishPending: null,
      rec: tool === 'pen' && penRecorder.enabled ? [recSample(pt, e.pointerType === 'pen' ? e.pressure : 0.5, start)] : null,
    };
    drawing.current.model?.add(pt.x, pt.y, pt.t ?? 0, pt.pressure);
    if (e.pointerType === 'pen' && (nativePencil.available || window.OpenNoteNative?.platform === 'ios')) {
      const d = drawing.current;
      const listener: PencilListener = (samples, predicted, ended) => nativeInputRef.current(d, samples, predicted, ended);
      d.native = listener;
      const queued = nativePencil.attach(listener);
      if (queued.length) nativeInputRef.current(d, queued, [], nativePencil.ended);
    }
    if (drawing.current.smart?.snapDot) haptic('snap');
    if (tool === 'lasso') setSelection(null);
    if (tool === 'eraser') {
      editor.beginGesture();
      eraserPos.current = pt;
      eraseAt(pt.x, pt.y);
    }
    requestRender();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
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
    if (d.native) {
      // The shell's 240 Hz samples drive the stroke; the web events are held back and take over if
      // the shell's samples do not arrive or stop arriving while the pen is still moving, so a
      // stroke is never cut short.
      d.webBuffer.push(...events);
      const now = performance.now();
      if (d.nativeSeen ? d.nativeEnded || now - d.lastNativeAt < NATIVE_STALL_MS : now - d.start < NATIVE_GRACE_MS) return;
      nativePencil.detach(d.native);
      d.native = null;
      const lastT = d.points[d.points.length - 1].t ?? 0;
      events.splice(0, events.length, ...d.webBuffer.filter((w) => eventTime(w) - d.start > lastT));
      d.webBuffer = [];
    }
    const predicted = native.getPredictedEvents ? native.getPredictedEvents() : [];
    ingestSamples(d, events, predicted[0] ?? null);
    requestRender();
  };

  /** Adds pen samples (web pointer events or the shell's 240 Hz Pencil samples) to the stroke. */
  function ingestSamples(d: NonNullable<typeof drawing.current>, events: (PointerEvent | PencilSample)[], predictedEvent: PointerEvent | PencilSample | null) {
    let snapTick = false;
    for (const ce of events) {
      const pt = toPoint(ce, d.start, stylusAngles(ce as PointerEvent));
      if (d.rec) d.rec.push(recSample(pt, ce.pointerType === 'pen' ? ce.pressure : 0.5, d.start));
      const last = d.points[d.points.length - 1];
      if (Math.abs(pt.x - last.x) < 0.2 && Math.abs(pt.y - last.y) < 0.2) continue;
      // A pen sample without force is the Pencil leaving the glass: it must not read as 0.5.
      const lifting = ce.pointerType === 'pen' && !(ce.pressure > 0);
      d.force.push(lifting ? 0 : pt.pressure);
      // Light smoothing of the Pencil's force signal: raw values jitter and made the fountain-pen
      // outline wobble.
      // pen: the raw force (the engine smooths it with no lag; 0 = lifting, force unknown);
      // highlighter / shapes: light smoothing, raw values jitter.
      if (d.model) pt.pressure = lifting ? 0 : pt.pressure;
      else {
        if (!lifting) d.pressure = d.pressure * 0.55 + pt.pressure * 0.45;
        pt.pressure = d.pressure;
      }
      d.points.push(pt);
      if (ce.pointerType === 'pen' && ce.pressure > 0 && ce.pressure !== 0.5) d.realPressure = true;
      if (d.model && !d.snapped) d.model.add(pt.x, pt.y, pt.t ?? 0, pt.pressure);
      if (d.smart) snapTick = moveSmartPen(d.smart, pt) || snapTick;
      else if (d.tool === 'eraser') {
        eraserPos.current = pt;
        eraseAt(pt.x, pt.y);
      }
    }
    if (snapTick) haptic('snap');
    if (d.snapped && d.adjust) {
      const pen = d.points[d.points.length - 1];
      d.snapped = { ...d.snapped, points: adjustSnappedShape(d.adjust, pen) };
    }
    if (!d.smart && (d.tool === 'pen' || d.tool === 'highlighter')) {
      d.predicted = dampedPrediction(d.points, predictedEvent ? { ...toPoint(predictedEvent, d.start), pressure: d.pressure } : null);
      const last = d.points[d.points.length - 1];
      if (!d.snapped && Math.hypot(last.x - d.lastMove.x, last.y - d.lastMove.y) > 3) {
        d.lastMove = { x: last.x, y: last.y };
        armHoldToSnap();
      }
    }
    requestRender();
  }

  const nativeInputRef = useRef<(d: NonNullable<typeof drawing.current>, samples: PencilSample[], predicted: PencilSample[], ended: boolean) => void>(() => {});
  nativeInputRef.current = (d, samples, predicted, ended) => {
    if (drawing.current !== d || d.nativeEnded) return;
    rectCache.current = null;
    d.lastNativeAt = performance.now();
    // Web events up to here are covered by these samples.
    d.webBuffer = [];
    if (!d.nativeSeen && samples.length && d.model && d.points.length === 1) {
      // Restart the stroke on the shell's first sample. The pointerdown point is a different
      // reading of the same touch: a less precise position and a time on another clock. Native
      // samples stamped before it all had their times clamped to +0.5 ms steps by the model, so
      // the first milliseconds of every stroke were squeezed together and the start was bent.
      const first = samples[0];
      d.start = first.timeStamp;
      const pt = toPoint(first, d.start, stylusAngles(first as unknown as PointerEvent));
      if (!(first.pressure > 0)) pt.pressure = 0;
      retireInk(d);
      d.drawn = 0;
      d.points = [pt];
      d.pressure = pt.pressure;
      d.force = [first.pressure > 0 ? pt.pressure : 0];
      d.lastMove = { x: pt.x, y: pt.y };
      d.realPressure = first.pressure > 0 && first.pressure !== 0.5;
      d.model = new NibModeler();
      d.model.add(pt.x, pt.y, pt.t ?? 0, pt.pressure);
      if (d.rec) d.rec = [recSample(pt, first.pressure, d.start)];
      samples = samples.slice(1);
    }
    d.nativeSeen = true;
    if (ended) d.nativeEnded = true;
    ingestSamples(d, samples, ended ? null : predicted[0] ?? null);
    if (ended && d.finishPending) {
      clearTimeout(d.finishPending.timer);
      finishStroke(d, d.finishPending.cancelled, d.finishPending.pointerType);
    }
  };

  /** The shell's samples stopped: the web events held back since its last delivery continue the stroke. */
  function ingestWebAfterNative(d: NonNullable<typeof drawing.current>) {
    if (d.native) nativePencil.detach(d.native);
    d.native = null;
    const lastT = d.points[d.points.length - 1].t ?? 0;
    const rest = d.webBuffer.filter((w) => eventTime(w) - d.start > lastT);
    d.webBuffer = [];
    if (rest.length) ingestSamples(d, rest, null);
  }

  function finishStroke(d: NonNullable<typeof drawing.current>, cancelled: boolean, pointerType?: string) {
    if (d.holdTimer) clearTimeout(d.holdTimer);
    if (d.finishPending) clearTimeout(d.finishPending.timer);
    if (d.native) nativePencil.detach(d.native);
    if (drawing.current !== d) return;
    drawing.current = null;
    retireInk(d);

    if (!cancelled && d.smart) {
      const stroke = smartPenStroke(d.smart, smartOptions(), newId('stroke'));
      if (stroke) {
        editor.commitPage(page.id, (p) => ({ ...p, strokes: [...p.strokes, stroke] }));
        if (stroke.closed && d.smart.closing) haptic('success');
      }
    } else if (!cancelled && (d.tool === 'pen' || d.tool === 'highlighter')) {
      const style = liveStyle(d.tool);
      if (d.rec) {
        penRecorder.add({
          tool: d.tool, penStyle: style.penStyle, width: style.width, source: d.nativeSeen ? 'native' : 'web',
          pointerType: d.pointerType, zoom: zoomRef.current, recordedAt: Date.now(), samples: d.rec,
        });
      }
      const stroke: Stroke = {
        id: newId('stroke'),
        tool: d.tool,
        color: style.color,
        width: style.width,
        opacity: 1,
        penStyle: style.penStyle,
        lineStyle: 'solid',
        points: d.snapped ? d.snapped.points : d.realPressure && d.tool === 'pen' ? trimLiftOff(d.points, d.force) : d.points,
        ...(d.snapped ? { isShape: true, closed: d.snapped.closed, shapeKind: d.snapped.kind } : {}),
      };
      editor.commitPage(page.id, (p) => ({ ...p, strokes: [...p.strokes, stroke] }));
    } else if (d.tool === 'eraser') {
      editor.endGesture();
      if (pointerType === 'touch') eraserPos.current = null;
    } else if (!cancelled && d.tool === 'lasso') {
      let len = 0;
      for (let i = 1; i < d.points.length; i++) len += Math.hypot(d.points[i].x - d.points[i - 1].x, d.points[i].y - d.points[i - 1].y);
      if (len < 12) {
        // A tap with the lasso selects the stroke under it (topmost first).
        const at = d.points[0];
        const pg = pageRef.current;
        const hit = [...pg.strokes].reverse().find((s) => strokeHitTest(s, at.x, at.y, 6 / Math.max(0.3, zoomRef.current)));
        if (hit) {
          const sel = { pageId: pg.id, strokeIds: [hit.id], latexIds: [], textIds: [], imageIds: [] };
          const bounds = computeBounds(pg, sel);
          if (bounds) setSelection({ ...sel, bounds });
        }
      } else if (d.points.length > 3) setSelection(selectInLasso(pageRef.current, d.points));
    }
    // The committed canvas paints in the same frame as React's commit (layout effect), so the
    // live layer can be cleared on the next frame without flicker.
    requestRender();
  }

  const finish = (e: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const d = drawing.current;
    if (!d || e.pointerId !== d.pointerId) return;
    rectCache.current = null;
    if (d.native && d.nativeSeen) {
      const stalled = !d.nativeEnded && performance.now() - d.lastNativeAt >= NATIVE_STALL_MS;
      if (!stalled) {
        // The shell's final samples (the true lift-off point) may still be on their way; if they
        // never come, the web events held back since its last samples finish the stroke.
        if (cancelled || d.nativeEnded) finishStroke(d, cancelled, e.pointerType);
        else if (!d.finishPending) {
          const timer = setTimeout(() => {
            if (drawing.current === d && !d.nativeEnded) ingestWebAfterNative(d);
            finishStroke(d, cancelled, e.pointerType);
          }, NATIVE_END_WAIT_MS);
          d.finishPending = { cancelled, pointerType: e.pointerType, timer };
        }
        return;
      }
      ingestWebAfterNative(d);
    }
    if (d.webBuffer.length) {
      ingestSamples(d, d.webBuffer, null);
      d.webBuffer = [];
    }
    if (!cancelled && d.tool !== 'eraser' && d.tool !== 'lasso') {
      // Include the final sample of the stroke.
      const pt = toPoint(e, d.start, stylusAngles(e.nativeEvent));
      const last = d.points[d.points.length - 1];
      if (Math.hypot(pt.x - last.x, pt.y - last.y) > 0.2) {
        pt.pressure = d.model ? 0 : d.pressure;
        if (d.rec) d.rec.push(recSample(pt, 0, d.start));
        d.force.push(0); // the pen has left the glass
        d.points.push(pt);
        if (d.smart) moveSmartPen(d.smart, pt);
        if (d.model && !d.snapped) d.model.add(pt.x, pt.y, pt.t ?? 0, pt.pressure);
      }
    }
    finishStroke(d, cancelled, e.pointerType);
  };

  // ------------------------------------------------------------------ selection transform
  // While a selection is moved or scaled nothing is written to the document: the selected ink is
  // painted once into a floating canvas that follows the pointer as a CSS transform (composited on
  // the GPU) and is hidden on the page canvas; selected blocks are shifted in place. The change is
  // committed once, on release, as one undo step. Rewriting the document on every pointermove
  // repainted the whole page, rebuilt the pressure outline of every moved stroke and re-rendered
  // the editor, which made moving anything lag.
  const transform = useRef<{ mode: 'move' | 'scale'; startX: number; startY: number; sel: Selection; pointerId: number; dx: number; dy: number; f: number } | null>(null);
  const [drag, setDrag] = useState<{ sel: Selection; dx: number; dy: number; f: number } | null>(null);
  const dragFrame = useRef<number | null>(null);
  const floatCanvasRef = useRef<HTMLCanvasElement>(null);
  const [liveBounds, setLiveBounds] = useState<Selection['bounds'] | null>(null);
  const shownBounds = drag
    ? { x: drag.sel.bounds.x + drag.dx, y: drag.sel.bounds.y + drag.dy, width: drag.sel.bounds.width * drag.f, height: drag.sel.bounds.height * drag.f }
    : liveBounds ?? selection?.bounds ?? null;

  const startTransform = (e: React.PointerEvent, mode: 'move' | 'scale') => {
    if (!selection) return;
    if (e.pointerType === 'touch' && tools.stylusOnly && mode === 'move' && gestures.touches > 1) return;
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    transform.current = { mode, startX: e.clientX, startY: e.clientY, sel: selection, pointerId: e.pointerId, dx: 0, dy: 0, f: 1 };
    gestures.dragging = true;
    setDrag({ sel: selection, dx: 0, dy: 0, f: 1 });
    if (selection.strokeIds.length) setHiddenIds(new Set(selection.strokeIds));
  };

  const moveTransform = (e: React.PointerEvent) => {
    const t = transform.current;
    if (!t || e.pointerId !== t.pointerId) return;
    e.stopPropagation();
    const dx = (e.clientX - t.startX) / zoom;
    const dy = (e.clientY - t.startY) / zoom;
    const b = t.sel.bounds;
    if (t.mode === 'move') {
      t.dx = dx;
      t.dy = dy;
    } else {
      t.f = Math.max(0.2, Math.min(5, Math.max((b.width + dx) / b.width, (b.height + dy) / b.height)));
    }
    // One React update per frame, however many pointer events arrive.
    if (dragFrame.current === null) {
      dragFrame.current = requestAnimationFrame(() => {
        dragFrame.current = null;
        const cur = transform.current;
        if (cur) setDrag({ sel: cur.sel, dx: cur.dx, dy: cur.dy, f: cur.f });
      });
    }
  };

  const endTransform = (e: React.PointerEvent, cancelled = false) => {
    const t = transform.current;
    if (!t || e.pointerId !== t.pointerId) return;
    transform.current = null;
    gestures.dragging = false;
    if (dragFrame.current !== null) cancelAnimationFrame(dragFrame.current);
    dragFrame.current = null;
    const moved = Math.abs(t.dx) > 0.01 || Math.abs(t.dy) > 0.01 || Math.abs(t.f - 1) > 1e-4;
    if (moved && !cancelled) {
      editor.commitPage(page.id, (p) => transformSelection(p, t.sel, t.dx, t.dy, t.f));
      const b = t.sel.bounds;
      setSelection({ ...t.sel, bounds: { x: b.x + t.dx, y: b.y + t.dy, width: b.width * t.f, height: b.height * t.f } });
    }
    setDrag(null);
    setHiddenIds(null);
  };

  // Selection layer: the selected ink drawn again on its own canvas with a blue glow (Notability
  // style). While dragging, the same canvas carries the ink (hidden on the page canvas) and moves
  // as a CSS transform, so picking a selection up costs nothing extra.
  const FLOAT_PAD = 24;
  const layerSel = drag?.sel ?? (selection && !printMode && !hiddenIds && selection.strokeIds.length ? selection : null);
  const dragging = !!drag;
  useLayoutEffect(() => {
    const c = floatCanvasRef.current;
    if (!c || !layerSel) return;
    const b = layerSel.bounds;
    const w = b.width + FLOAT_PAD * 2, h = b.height + FLOAT_PAD * 2;
    const r = Math.min(ratio, Math.sqrt(MAX_CANVAS_PIXELS / 2 / Math.max(1, w * h)));
    c.width = Math.max(1, Math.round(w * r));
    c.height = Math.max(1, Math.round(h * r));
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(r, 0, 0, r, -(b.x - FLOAT_PAD) * r, -(b.y - FLOAT_PAD) * r);
    const ids = new Set(layerSel.strokeIds);
    // Idle: highlighters stay on the page only (drawing them twice would darken them).
    const strokes = pageRef.current.strokes.filter((s) => ids.has(s.id) && (dragging || s.tool !== 'highlighter'));
    ctx.save();
    ctx.shadowColor = 'rgba(37, 99, 235, 0.9)';
    ctx.shadowBlur = 7 * r;
    drawStrokes(ctx, strokes);
    ctx.restore();
    drawStrokes(ctx, strokes);
  }, [layerSel, dragging, ratio, page.strokes]);

  // Blocks of the selection follow the drag without touching the document.
  const blockPage = useMemo(
    () => (drag && drag.sel.latexIds.length + drag.sel.textIds.length + drag.sel.imageIds.length ? transformSelection({ ...page, strokes: [] }, drag.sel, drag.dx, drag.dy, drag.f) : page),
    [drag, page]
  );

  // ------------------------------------------------------------------ shape editing (handles)
  // Same idea for reshaping: the edited shape is drawn on the live layer while dragging and
  // committed on release.
  const editShape =
    selection && !printMode && selection.strokeIds.length === 1 && !selection.latexIds.length && !selection.textIds.length && !selection.imageIds.length
      ? page.strokes.find((s) => s.id === selection.strokeIds[0])
      : undefined;
  const handles = editShape && !drag ? shapeHandles(editShape) : null;
  const handleDrag = useRef<{
    pointerId: number; orig: Stroke; handle: ShapeHandle; cache: SnapCache | null; sel: Selection; last: Stroke; snapped: boolean; snapDot: { x: number; y: number } | null;
  } | null>(null);
  const [editHandles, setEditHandles] = useState<ShapeHandle[] | null>(null);

  const pagePoint = (e: { clientX: number; clientY: number }) => {
    const rect = containerRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - rect.left) * PAGE_WIDTH) / rect.width, y: ((e.clientY - rect.top) * surfHRef.current) / rect.height };
  };

  const startHandle = (e: React.PointerEvent, h: ShapeHandle) => {
    if (!editShape || !selection) return;
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const others = page.strokes.filter((s) => s.id !== editShape.id);
    const grid = tools.shapeGridSnap ? paperGrid(paperStyle) : null;
    const cache = tools.shapeSnap || grid ? buildSnapCache(tools.shapeSnap ? others : [], grid) : null;
    if (!claimLive()) return;
    handleDrag.current = { pointerId: e.pointerId, orig: editShape, handle: h, cache, sel: selection, last: editShape, snapped: false, snapDot: null };
    gestures.dragging = true;
    setHiddenIds(new Set([editShape.id]));
    requestRender();
  };

  const moveHandle = (e: React.PointerEvent) => {
    const d = handleDrag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    e.stopPropagation();
    const p = pagePoint(e);
    const snap = d.cache ? findSnapKind(d.cache, p, zoom) : null;
    const shapeSnap = snap?.kind === 'shape';
    if (shapeSnap && !d.snapped) haptic('snap');
    d.snapped = shapeSnap;
    d.snapDot = shapeSnap ? snap!.at : null;
    d.last = dragHandle(d.orig, d.handle, snap?.at ?? p);
    requestRender();
    setEditHandles(shapeHandles(d.last));
    setLiveBounds(computeBounds({ ...pageRef.current, strokes: [d.last] }, d.sel));
  };

  const endHandle = (e: React.PointerEvent, cancelled = false) => {
    const d = handleDrag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    handleDrag.current = null;
    gestures.dragging = false;
    if (!cancelled && d.last !== d.orig) {
      const next = d.last;
      editor.commitPage(page.id, (pg) => ({ ...pg, strokes: pg.strokes.map((s) => (s.id === d.orig.id ? next : s)) }));
      const b = computeBounds({ ...pageRef.current, strokes: [next] }, d.sel);
      if (b) setSelection({ ...d.sel, bounds: b });
    }
    setHiddenIds(null);
    setEditHandles(null);
    setLiveBounds(null);
    requestRender();
  };

  // ------------------------------------------------------------------ render
  const blocksInteractive = tools.tool === 'lasso' || tools.tool === 'text';
  const pageStyle: React.CSSProperties = {
    width: PAGE_WIDTH,
    height: SURF_H,
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
      className="on-page relative select-none shadow-[0_4px_24px_rgba(0,0,0,0.12)] overflow-hidden"
      style={pageStyle}
      data-page-index={pageIndex}
    >
      {printMode ? (
        <svg className="absolute inset-0" width={PAGE_WIDTH} height={SURF_H} viewBox={`0 0 ${PAGE_WIDTH} ${SURF_H}`}
          dangerouslySetInnerHTML={{
            __html: [...page.strokes.filter((s) => s.tool === 'highlighter'), ...page.strokes.filter((s) => s.tool !== 'highlighter')].map((s) => strokeToSvg(s, 0, PAPER_COLORS[paperColor])).join(''),
          }}
        />
      ) : (
        Array.from({ length: pageCount }, (_, k) => <InkTile key={k} band={k} strokes={shownStrokes} ratio={ratio} scrollRoot={scrollRoot} />)
      )}
      {layerSel && layerSel.strokeIds.length > 0 && (
        <canvas
          ref={floatCanvasRef}
          className="absolute pointer-events-none"
          style={{
            left: layerSel.bounds.x - FLOAT_PAD,
            top: layerSel.bounds.y - FLOAT_PAD,
            width: layerSel.bounds.width + FLOAT_PAD * 2,
            height: layerSel.bounds.height + FLOAT_PAD * 2,
            transformOrigin: `${FLOAT_PAD}px ${FLOAT_PAD}px`,
            transform: drag ? `translate(${drag.dx}px, ${drag.dy}px) scale(${drag.f})` : undefined,
            willChange: drag ? 'transform' : undefined,
          }}
        />
      )}

      {/* Typed / converted content */}
      {(blockPage.imageBlocks ?? []).map((im) => (
        <ImageBlockView key={im.id} block={im} selected={!!selection?.imageIds.includes(im.id)} />
      ))}
      {blockPage.latexBlocks.map((b) => (
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
      {(blockPage.textBlocks ?? []).map((t) => (
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
      {!printMode && <canvas ref={activeCanvasRef} className="absolute left-0 z-10 pointer-events-none" style={{ top: 0, width: PAGE_WIDTH, height: 0 }} />}
      {visible && !printMode && (
        <div
          ref={inputRef}
          data-ink-input
          className="absolute inset-0 z-10"
          style={{
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

      {visible && !printMode && (
        <canvas ref={tailCanvasRef} className="absolute z-10 pointer-events-none" style={{ display: 'none', left: 0, top: 0 }} />
      )}

      {/* Lasso selection box */}
      {shownBounds && selection && !printMode && (
        <div
          data-no-pan
          className="absolute z-20 border-2 border-dashed border-blue-500 bg-blue-500/5 rounded-lg cursor-move"
          style={{ left: shownBounds.x, top: shownBounds.y, width: shownBounds.width, height: shownBounds.height, touchAction: 'none' }}
          onPointerDown={(e) => startTransform(e, 'move')}
          onPointerMove={moveTransform}
          onPointerUp={(e) => endTransform(e)}
          onPointerCancel={(e) => endTransform(e, true)}
        >
          <div
            data-no-pan
            className="absolute -right-3 -bottom-3 w-7 h-7 bg-blue-600 text-white rounded-full flex items-center justify-center shadow-md cursor-nwse-resize"
            style={{ transform: `scale(${Math.max(1, 1 / zoom)})`, touchAction: 'none' }}
            onPointerDown={(e) => startTransform(e, 'scale')}
            onPointerMove={moveTransform}
            onPointerUp={(e) => endTransform(e)}
            onPointerCancel={(e) => endTransform(e, true)}
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </div>
        </div>
      )}

      {/* Shape handles (single smart shape selected) */}
      {handles && selection &&
        (editHandles ?? handles).map((h, i) => (
          <div
            key={i}
            data-no-pan
            className="absolute z-30 flex items-center justify-center"
            style={{ left: h.x - 15, top: h.y - 15, width: 30, height: 30, transform: `scale(${1 / zoom})`, touchAction: 'none', cursor: 'grab' }}
            onPointerDown={(e) => startHandle(e, handles[i] ?? h)}
            onPointerMove={moveHandle}
            onPointerUp={(e) => endHandle(e)}
            onPointerCancel={(e) => endHandle(e, true)}
          >
            <span
              className={`block shadow-md border-2 ${h.role === 'center' ? 'w-3 h-3 rounded-sm bg-blue-600 border-white' : h.role === 'axisA' || h.role === 'axisB' ? 'w-3.5 h-3.5 rounded-full bg-blue-600 border-white' : 'w-3.5 h-3.5 rounded-full bg-white border-blue-600'}`}
            />
          </div>
        ))}

      {/* Page breaks: a hairline and the page number; the PDF is cut here. */}
      {!printMode &&
        Array.from({ length: pageCount }, (_, k) => (
          <React.Fragment key={k}>
            {k > 0 && (
              <div className="absolute left-0 right-0 pointer-events-none" style={{ top: k * PAGE_HEIGHT - 0.5, height: 1, background: darkPaper ? 'rgba(255,255,255,0.18)' : 'rgba(100,116,139,0.35)' }} />
            )}
            <div className="absolute right-4 text-[11px] font-medium text-gray-400 pointer-events-none" style={{ top: (k + 1) * PAGE_HEIGHT - 22 }}>{k + 1}</div>
          </React.Fragment>
        ))}
    </div>
  );
};

export const CanvasPage = React.memo(CanvasPageImpl);
