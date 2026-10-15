import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Maximize2, RotateCw } from 'lucide-react';
import {
  EraserMode, FillType, LatexBlock, LineStyle, NotePage, PaperColor, PaperStyle, PenStyle, Point, ShapeMode, Stroke,
  TextBlock, ToolType, newId,
} from '../types';
import {
  drawLiveStroke, drawStroke, drawStrokes, eraseStrokesPartial, isVariableWidth, paintStrokeFill, paintStrokeInk, strokeHitTest, strokePaintBounds,
  strokeWidth, InkStyle, strokeToSvg, styleOf, prepareStroke,
} from '../ink/strokeRenderer';
import { LiveStroke } from '../ink/engine';
import { RecordedSample, penRecorder } from '../ink/penRecorder';
import { PencilListener, PencilSample, nativePencil } from '../ink/nativePencil';
import { InkTransform, NativeInk, nativeInkUnit } from '../ink/nativeInk';
import { record } from '../ink/inkRecorder';
import { tileWork } from '../editor/tileWork';
import { sceneItem } from '../ink/pinchScene';
import { detectShape } from '../services/shapeRecognition';
import { PageOps } from '../state/useNoteEditor';
import {
  SmartPenOptions, SmartPenState, SnapCache, beginSmartPen, findSnapKind, moveSmartPen, smartPenMeasure, smartPenShape, smartPenStroke, snapCacheFor,
} from '../editor/smartPen';
import { prewarmTools } from '../editor/prewarm';
import { ShapeHandle, SnapAdjust, adjustSnappedShape, dragHandle, shapeHandles } from '../editor/shapeEdit';
import { haptic } from '../platform';
import { GestureBus } from '../editor/gestures';
import {
  Selection, computeBounds, normDeg, resetRotation, selectInLasso, selectionRotation, singleBlockSelection, transformSelection,
} from '../editor/selection';
import { ImageBlockView, LatexBlockView, TextBlockView } from './Blocks';
import { SheetBox, SurfaceLayout, sheetIndexAt } from '../editor/sheets';
import { ZLayer, zLayers } from '../editor/zorder';

export interface ToolSettings {
  tool: ToolType;
  penColor: string;
  /** Colour of the Draw tool (smart pen), independent of the pen's. */
  shapeColor: string;
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
  /** The note's surface (all of its content). */
  page: NotePage;
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
  /** The surface's size and the pages it is cut into (editor/sheets.ts). */
  layout: SurfaceLayout;
}

export const PAPER_COLORS: Record<PaperColor, string> = {
  white: '#FFFFFF',
  cream: '#FBF7EE',
  yellow: '#FEF9C3',
  ochre: '#F1DFAE',
  blue: '#E6F0FB',
  green: '#E8F4E5',
  pink: '#FBE7EE',
  gray: '#EDEDED',
  dark: '#1C1C1F',
};

/**
 * Paper patterns as CSS backgrounds (no canvas memory, prints as vectors). `origin`: where the
 * paper sits on the surface, so grid and dot lattices of every page line up with the surface's
 * lattice (the one the Draw tool snaps to).
 */
export function paperBackground(style: PaperStyle, color: PaperColor, origin = { x: 0, y: 0 }): React.CSSProperties {
  const dark = color === 'dark';
  const base = PAPER_COLORS[color] ?? PAPER_COLORS.white;
  const line = dark ? 'rgba(255,255,255,0.13)' : 'rgba(59,130,246,0.22)';
  const grid = dark ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.08)';
  const margin = dark ? 'rgba(239,68,68,0.35)' : 'rgba(239,68,68,0.4)';
  const css: React.CSSProperties = { backgroundColor: base };
  if (style === 'ruled' || style === 'narrow') {
    const gap = style === 'narrow' ? 24 : 32;
    css.backgroundImage = [
      `linear-gradient(to right, transparent 79px, ${margin} 79px, ${margin} 80px, transparent 80px)`,
      `linear-gradient(${base}, ${base})`,
      `linear-gradient(to bottom, transparent ${gap - 1}px, ${line} ${gap - 1}px, ${line} ${gap}px)`,
    ].join(',');
    css.backgroundSize = `100% 100%, 100% 79px, 100% ${gap}px`;
    css.backgroundPosition = `0 0, 0 0, 0 ${80 - gap}px`;
    css.backgroundRepeat = 'no-repeat, no-repeat, repeat';
  } else if (style === 'grid') {
    css.backgroundImage = `linear-gradient(to right, ${grid} 1px, transparent 1px), linear-gradient(to bottom, ${grid} 1px, transparent 1px)`;
    css.backgroundSize = '24px 24px';
    css.backgroundPosition = `${-origin.x}px ${-origin.y}px`;
  } else if (style === 'graph') {
    // Millimetre-style graph paper: fine lines every 12 px, stronger ones every 60 px.
    const major = dark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.13)';
    const minor = dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)';
    css.backgroundImage = [
      `linear-gradient(to right, ${major} 1px, transparent 1px)`,
      `linear-gradient(to bottom, ${major} 1px, transparent 1px)`,
      `linear-gradient(to right, ${minor} 1px, transparent 1px)`,
      `linear-gradient(to bottom, ${minor} 1px, transparent 1px)`,
    ].join(',');
    css.backgroundSize = '60px 60px, 60px 60px, 12px 12px, 12px 12px';
    css.backgroundPosition = `${-origin.x}px ${-origin.y}px`;
  } else if (style === 'dots') {
    css.backgroundImage = `radial-gradient(circle, ${dark ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.22)'} 1.3px, transparent 1.7px)`;
    css.backgroundSize = '24px 24px';
    css.backgroundPosition = `${12 - origin.x}px ${12 - origin.y}px`;
  }
  return css;
}

/** Lattice spacing of grid and dot paper (see paperBackground), or null for other papers. */
export function paperGrid(style: PaperStyle): number | null {
  return style === 'grid' || style === 'dots' ? 24 : style === 'graph' ? 12 : null;
}

const MAX_CANVAS_PIXELS = 16_000_000;
/** Above this zoom committed ink is drawn as SVG (sharp at any zoom) instead of page canvases. */
const VECTOR_ZOOM = 2.5;
/** A rotation within this many degrees of a multiple of 15° (0° included) snaps to it. */
const ROTATE_SNAP = 3;

/**
 * Backing-store scale of a canvas covering `area` page px². Quantised in half-zoom steps so that
 * zooming does not reallocate and repaint the canvases for every small zoom change.
 */
function canvasRatio(zoom: number, area: number): number {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const z = Math.ceil(Math.max(1, Math.min(zoom, 5)) * 2) / 2;
  const maxByBudget = Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, area));
  return Math.max(1, Math.min(dpr * z, maxByBudget));
}

/** Committed ink as SVG markup (cached per stroke): high zoom and printing. `paperOf`: for "hole" fills. */
const svgCache = new WeakMap<Stroke, { paper: string; svg: string }>();
function strokesSvg(strokes: Stroke[], paperOf: (s: Stroke) => string): string {
  const one = (s: Stroke) => {
    const paper = paperOf(s);
    const c = svgCache.get(s);
    if (c && c.paper === paper) return c.svg;
    const svg = strokeToSvg(s, 0, paper);
    svgCache.set(s, { paper, svg });
    return svg;
  };
  return [...strokes.filter((s) => s.tool === 'highlighter'), ...strokes.filter((s) => s.tool !== 'highlighter')].map(one).join('');
}

/** Painting a tile that is not on screen yet is spread over frames, this many ms per frame. */
const TILE_SLICE_MS = 6;
/** A change covering more than this share of a tile repaints the whole tile. */
const TILE_FULL_REPAINT = 0.5;

type TilePaint = { strokes: Stroke[]; ratio: number; complete: boolean };

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
 * Committed ink of one page of the surface (its height, the surface's whole width: ink may go
 * beside a narrower page). Tiles exist only near the viewport (a canvas
 * is up to 16 Mpx and WebKit has a tight total canvas budget), and each one is the cached bitmap of
 * its band: it is painted once and then only where something changed.
 *
 *  - Strokes appended on top (the common case while writing) are painted on top.
 *  - Any other change (erasing, undo, moving, restyling) repaints only the area of the strokes that
 *    were removed or added, clipped to it, instead of the whole page: the precision eraser on a
 *    full page repainted hundreds of strokes for every eraser sample.
 *  - A tile is created when it comes within a screen of the viewport and kept until it is more
 *    than 2.5 screens away (scrolling back and forth does not repaint), and a tile that is still
 *    off screen is painted a few ms per frame, so scrolling a dense note does not stall on it.
 *
 * Strokes crossing a page line are painted by both tiles.
 */
/**
 * One page band of ink as SVG (zoomed in past VECTOR_ZOOM: sharp at any zoom). Like InkTile it is
 * built only near the view and dropped far from it: one SVG of the whole note was rebuilt and
 * parsed (megabytes of markup on a long note) every time a pinch ended past VECTOR_ZOOM.
 */
const VectorTile = React.memo(function VectorTile(props: { top: number; width: number; height: number; strokes: Stroke[]; scrollRoot: HTMLElement | null; paperOf: (s: Stroke) => string }) {
  const { top, width: W, height: H, strokes, scrollRoot } = props;
  const paperOf = useRef(props.paperOf);
  paperOf.current = props.paperOf;
  const mine = useMemo(() => strokes.filter((s) => {
    const r = strokeYRange(s);
    return r.maxY >= top && r.minY <= top + H;
  }), [strokes, top, H]);
  const holderRef = useRef<HTMLDivElement>(null);
  const [alive, setAlive] = useState(false);
  // Made under the pinch overlay: the overlay waits until this tile knows whether it is near the view
  // and, if it is, has its SVG.
  const token = useRef({});
  const reported = useRef(false);
  useEffect(() => {
    if (tileWork.deferring) tileWork.pending.add(token.current);
    return () => {
      tileWork.pending.delete(token.current);
    };
  }, []);
  useEffect(() => {
    const el = holderRef.current;
    if (!el) return;
    const near = new IntersectionObserver((en) => {
      reported.current = true;
      if (en.some((e) => e.isIntersecting)) setAlive(true);
      else tileWork.pending.delete(token.current);
    }, { root: scrollRoot, rootMargin: '50% 0px' });
    const far = new IntersectionObserver((en) => !en.some((e) => e.isIntersecting) && setAlive(false), { root: scrollRoot, rootMargin: '150% 0px' });
    near.observe(el);
    far.observe(el);
    return () => {
      near.disconnect();
      far.disconnect();
    };
  }, [scrollRoot]);
  // Built after the render, and not while two fingers are zooming (tileWork.paused).
  const [svg, setSvg] = useState('');
  useEffect(() => {
    if (!alive || !mine.length) {
      setSvg('');
      return;
    }
    const make = () => setSvg(strokesSvg(mine, (s) => paperOf.current(s)));
    if (!tileWork.paused) {
      make();
      return;
    }
    tileWork.resume.add(make);
    return () => {
      tileWork.resume.delete(make);
    };
  }, [alive, mine]);
  useEffect(() => {
    if (reported.current && (svg || !mine.length || !alive)) tileWork.pending.delete(token.current);
  }, [alive, svg, mine.length]);
  return (
    <div ref={holderRef} data-ink-layer className="absolute left-0 pointer-events-none" style={{ top, width: W, height: H }}>
      {svg && <svg className="absolute inset-0" width={W} height={H} viewBox={`0 ${top} ${W} ${H}`} dangerouslySetInnerHTML={{ __html: svg }} />}
    </div>
  );
});

const InkTile = React.memo(function InkTile(props: { eager: boolean; top: number; width: number; height: number; strokes: Stroke[]; ratio: number; scrollRoot: HTMLElement | null }) {
  const { eager, top, width: W, height: H, strokes, ratio, scrollRoot } = props;
  const mine = useMemo(() => strokes.filter((s) => {
    const r = strokeYRange(s);
    return r.maxY >= top && r.minY <= top + H;
  }), [strokes, top, H]);
  const holderRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [alive, setAlive] = useState(eager);
  const onScreen = useRef(eager);
  /** Within half a screen of the view: the canvas is displayed (see `shown` below). */
  const shown = useRef(true);
  const applyShown = () => {
    const c = canvasRef.current;
    if (c) c.style.display = shown.current ? '' : 'none';
  };
  useEffect(() => {
    const el = holderRef.current;
    if (!el) return;
    const near = new IntersectionObserver((en) => en.some((e) => e.isIntersecting) && setAlive(true), { root: scrollRoot, rootMargin: '100% 0px' });
    const far = new IntersectionObserver((en) => !en.some((e) => e.isIntersecting) && setAlive(false), { root: scrollRoot, rootMargin: '250% 0px' });
    const view = new IntersectionObserver((en) => (onScreen.current = en.some((e) => e.isIntersecting)), { root: scrollRoot, rootMargin: '0px' });
    // A painted tile that is off screen keeps its pixels but leaves the rendering (display: none):
    // every displayed canvas was handed to the compositor again on each frame, so with all the
    // tiles kept around the view, writing on a long note got slower with every page (measured:
    // 8 pages took 3x the frame work of 1 and dropped frames on a slower tablet). It is shown
    // again, without repainting, before it scrolls into view.
    const show = new IntersectionObserver((en) => {
      shown.current = en.some((e) => e.isIntersecting);
      applyShown();
    }, { root: scrollRoot, rootMargin: '50% 0px' });
    near.observe(el);
    far.observe(el);
    view.observe(el);
    show.observe(el);
    return () => {
      near.disconnect();
      far.disconnect();
      view.disconnect();
      show.disconnect();
    };
  }, [scrollRoot]);
  const painted = useRef<TilePaint | null>(null);
  const slicing = useRef<number | null>(null);
  const token = useRef({});
  useEffect(() => () => {
    if (slicing.current !== null) cancelAnimationFrame(slicing.current);
    tileWork.pending.delete(token.current);
  }, []);
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    tileWork.pending.delete(token.current);
    if (slicing.current !== null) {
      cancelAnimationFrame(slicing.current);
      slicing.current = null;
    }
    if (!canvas || !alive) {
      painted.current = null;
      return;
    }
    applyShown();
    const w = Math.round(W * ratio), h = Math.round(H * ratio);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      painted.current = null;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, -top * ratio);
    const prev = painted.current && painted.current.complete && painted.current.ratio === ratio ? painted.current : null;
    painted.current = { strokes: mine, ratio, complete: true };
    if (prev && prev.strokes === mine) return;
    // Every edit gives every tile a new list; a tile whose strokes are the same ones in the same
    // order has nothing to paint. (It used to fall through to "same strokes in another order" and
    // repaint completely: each finished stroke repainted every page kept around the view.)
    if (prev && prev.strokes.length === mine.length && prev.strokes.every((s, i) => mine[i] === s)) return;

    if (prev) {
      // Appended pen strokes: painted on top.
      const n = prev.strokes.length;
      if (mine.length > n && prev.strokes.every((s, i) => mine[i] === s) && mine.slice(n).every((s) => s.tool !== 'highlighter' && (!s.fill || s.fill === 'none'))) {
        for (const s of mine.slice(n)) drawStroke(ctx, s);
        return;
      }
      // Anything else: repaint the area of what changed.
      const before = new Set(prev.strokes), after = new Set(mine);
      let area: DirtyRect | null = null;
      for (const s of prev.strokes) if (!after.has(s)) area = unionRect(area, strokePaintBounds(s));
      for (const s of mine) if (!before.has(s)) area = unionRect(area, strokePaintBounds(s));
      if (!area) {
        // Same strokes in another order: repaint all of them.
        area = { minX: 0, minY: top, maxX: W, maxY: top + H };
      }
      const x0 = Math.max(0, Math.floor(area.minX * ratio) / ratio), y0 = Math.max(top, Math.floor(area.minY * ratio) / ratio);
      const x1 = Math.min(W, Math.ceil(area.maxX * ratio) / ratio), y1 = Math.min(top + H, Math.ceil(area.maxY * ratio) / ratio);
      if (x1 <= x0 || y1 <= y0) return;
      if ((x1 - x0) * (y1 - y0) < TILE_FULL_REPAINT * W * H) {
        const hit = mine.filter((s) => {
          const b = strokePaintBounds(s);
          return b.maxX >= x0 && b.minX <= x1 && b.maxY >= y0 && b.minY <= y1;
        });
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, y0, x1 - x0, y1 - y0);
        ctx.clip();
        ctx.clearRect(x0, y0, x1 - x0, y1 - y0);
        drawStrokes(ctx, hit);
        ctx.restore();
        return;
      }
    }

    ctx.clearRect(0, top, W, H);
    // After a zoom the observer has not caught up with where the tile now is: it is measured, so a
    // tile on screen is painted at once (the pinch's ink overlay hands over to it on the next frame).
    const inView = () => {
      const r = holderRef.current?.getBoundingClientRect();
      const v = scrollRoot?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
      return !!r && r.bottom > v.top && r.top < v.bottom;
    };
    // Under the pinch overlay every tile repaints in slices (it is covered until it is done).
    if (!tileWork.deferring && (onScreen.current || mine.length < 40 || inView())) {
      drawStrokes(ctx, mine);
      return;
    }
    tileWork.pending.add(token.current);
    // Off screen (scrolling towards it): paint in slices, in the order drawStrokes uses
    // (highlighters, then fills, then ink), and take the tile as painted only at the end.
    painted.current = { strokes: mine, ratio, complete: false };
    const passes: ((s: Stroke) => boolean)[] = [
      (s) => s.tool === 'highlighter',
      (s) => s.tool !== 'highlighter' && !!s.fill && s.fill !== 'none',
      (s) => s.tool !== 'highlighter',
    ];
    let pass = 0, i = 0;
    const job = mine;
    const step = () => {
      slicing.current = null;
      if (painted.current?.strokes !== job) return;
      if (tileWork.paused) {
        slicing.current = requestAnimationFrame(step);
        return;
      }
      const until = performance.now() + TILE_SLICE_MS;
      while (pass < passes.length) {
        for (; i < job.length; i++) {
          if (performance.now() > until && (!onScreen.current || tileWork.deferring)) {
            slicing.current = requestAnimationFrame(step);
            return;
          }
          const s = job[i];
          if (!passes[pass](s) || !s.points.length) continue;
          if (pass === 0) drawStrokes(ctx, [s]);
          else if (pass === 1) paintStrokeFill(ctx, s);
          else paintStrokeInk(ctx, s);
        }
        pass++;
        i = 0;
      }
      painted.current = { strokes: job, ratio, complete: true };
      tileWork.pending.delete(token.current);
    };
    step();
  }, [mine, ratio, alive, top, W, H]);
  return (
    <div ref={holderRef} data-ink-layer className="absolute left-0 pointer-events-none" style={{ top, width: W, height: H }}>
      {alive && mine.length > 0 && <canvas ref={canvasRef} style={{ width: W, height: H }} />}
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
function drawMeasure(ctx: CanvasRenderingContext2D, text: string, at: { x: number; y: number }, k: number, pageWidth: number): DirtyRect {
  ctx.save();
  ctx.font = `600 ${12 * k}px -apple-system, system-ui, sans-serif`;
  const w = ctx.measureText(text).width + 12 * k;
  const h = 20 * k;
  // Above-right of the pen tip, kept on the page.
  const x = Math.min(pageWidth - w - 2, Math.max(2, at.x + 14 * k));
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
/** Web samples closer together in time than this (ms) have unreliable timestamps (retimeWebSamples). */
const MIN_SAMPLE_DT = 1;
/** The shell's samples stopped while web pointer events keep coming: switch to the web events. */
const NATIVE_STALL_MS = 60;
/** ... and only once the web events show the pen this far (px) from the last native sample. */
const NATIVE_STALL_PX = 2;
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
    page, tools, zoom, editor, gestures, selection, setSelection,
    selectedBlockId, setSelectedBlockId, editingTextId, setEditingTextId, onEditLatex, printMode, scrollRoot, layout,
  } = props;
  const pageIndex = 0;
  const PAGE_W = layout.width, PAGE_H = layout.height;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  /** The page (sheet) at surface height y. */
  const sheetAt = (y: number): SheetBox => layoutRef.current.sheets[sheetIndexAt(layoutRef.current, y)];
  const sizeRef = useRef({ w: PAGE_W, h: PAGE_H });
  sizeRef.current = { w: PAGE_W, h: PAGE_H };
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLDivElement>(null);
  const activeCanvasRef = useRef<HTMLCanvasElement>(null);
  const visible = true;
  /** Blocks: the default ink follows the paper of the page they are on. */
  const darkAt = (y: number) => sheetAt(y).paperColor === 'dark';
  const inkAt = (y: number) => (darkAt(y) ? '#F3F4F6' : '#111827');
  const pageRef = useRef(page);
  pageRef.current = page;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  /** Paper under the pen (the Draw tool snaps to its lattice). */
  const paperStyleRef = useRef(layout.sheets[0].paperStyle);

  // Strokes being moved / reshaped are drawn on a floating or live layer instead of the page canvas.
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string> | null>(null);
  const shownStrokes = useMemo(() => (hiddenIds ? page.strokes.filter((s) => !hiddenIds.has(s.id)) : page.strokes), [page.strokes, hiddenIds]);

  const ratio = canvasRatio(zoom, PAGE_W * PAGE_H);
  /** High zoom: the committed ink is drawn as SVG, which stays sharp where canvases hit their budget. */
  // Vector ink above VECTOR_ZOOM, and also wherever a page canvas would be held below the screen's
  // resolution by its pixel budget (MAX_CANVAS_PIXELS; on a 3x Android screen from about 1.4x zoom):
  // those canvases were drawn soft and then stretched.
  const tileArea = Math.max(1, ...layout.sheets.map((sh) => PAGE_W * sh.height));
  const vector = printMode || zoom > VECTOR_ZOOM || canvasRatio(zoom, tileArea) + 1e-6 < (Math.min(window.devicePixelRatio || 1, 3) * Math.ceil(Math.max(1, Math.min(zoom, 5)) * 2)) / 2;
  /** Paper under a stroke ("hole" fills in SVG). */
  const svgPaperOf = (st: Stroke) => PAPER_COLORS[sheetAt(strokeYRange(st).minY + 12).paperColor] ?? '#FFFFFF';
  /** SVG of each ink layer, made again only when the layer's strokes (or the pages) change. */
  const layerSvgs = useMemo(() => new WeakMap<Stroke[], string>(), [layout, vector]);
  const layerSvg = (strokes: Stroke[]) => {
    let svg = layerSvgs.get(strokes);
    if (svg === undefined) layerSvgs.set(strokes, (svg = strokesSvg(strokes, svgPaperOf)));
    return svg;
  };

  // ------------------------------------------------------------------ live layer
  const dirty = useRef<DirtyRect | null>(null);
  /** Part of the surface the live canvas covers (surface px) and its backing scale. */
  const live = useRef<{ top: number; height: number; ratio: number } | null>(null);

  /**
   * The live canvas covers the visible part of the surface plus a margin (not whole page bands),
   * so it stays small, and it is placed ahead of time, when scrolling stops (see below): a stroke
   * starting after a scroll used to allocate and clear a canvas of up to 16 Mpx on pen-down. When
   * the view moved but the size did not, the canvas is only moved and cleared. Ink drawn on it
   * uses surface coordinates.
   */
  const claimLive = useCallback((): CanvasRenderingContext2D | null => {
    const canvas = activeCanvasRef.current, cont = containerRef.current;
    if (!canvas || !cont) return null;
    const { w: W, h: H } = sizeRef.current;
    const c = cont.getBoundingClientRect();
    const root = scrollRoot?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
    const scale = c.height / H || 1;
    const v0 = Math.max(0, (root.top - c.top) / scale), v1 = Math.min(H, (root.bottom - c.top) / scale);
    const view = Math.max(1, (root.bottom - root.top) / scale);
    const height = Math.min(H, Math.ceil(view * 1.5));
    const r = canvasRatio(zoomRef.current, W * height);
    const cur = live.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    if (cur && canvas.width > 0 && cur.top <= v0 && cur.top + cur.height >= v1 && cur.height === height && Math.abs(cur.ratio - r) < 1e-6 && canvas.width === Math.round(W * r)) return ctx;
    const top = Math.max(0, Math.min(H - height, (v0 + v1) / 2 - height / 2));
    const w = Math.round(W * r), h = Math.round(height * r);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      canvas.style.width = `${W}px`;
      canvas.style.height = `${height}px`;
    }
    canvas.style.top = `${top}px`;
    ctx.setTransform(r, 0, 0, r, 0, -top * r);
    ctx.clearRect(0, top, W, height);
    live.current = { top, height, ratio: r };
    dirty.current = null;
    return ctx;
  }, [scrollRoot]);

  // Zoom changed (rotation): the live canvas is re-created.
  useLayoutEffect(() => {
    const c = activeCanvasRef.current;
    if (c && !drawing.current) {
      c.width = 0;
      c.height = 0;
      live.current = null;
      dirty.current = null;
    }
  }, [ratio]);

  // The pen's page position is measured once per stroke (getBoundingClientRect forces a layout):
  // only scrolling, zooming or resizing moves the page under the pen. When scrolling stops the live
  // canvas is placed for the next stroke.
  useEffect(() => {
    let idle: ReturnType<typeof setTimeout> | null = null;
    const place = () => {
      idle = null;
      if (!drawing.current && !handleDrag.current) claimLive();
    };
    const onMove = () => {
      rectCache.current = null;
      if (idle) clearTimeout(idle);
      idle = setTimeout(place, 140);
    };
    const target: HTMLElement | Window = scrollRoot ?? window;
    target.addEventListener('scroll', onMove, { passive: true });
    window.addEventListener('resize', onMove);
    onMove();
    return () => {
      if (idle) clearTimeout(idle);
      target.removeEventListener('scroll', onMove);
      window.removeEventListener('resize', onMove);
    };
  }, [scrollRoot, claimLive, ratio, PAGE_W, PAGE_H]);

  // First-stroke lag: every tool's code is run once in idle time after the note opens (prewarm.ts).
  // The rect is re-measured after a zoom.
  useEffect(() => {
    if (!printMode) prewarmTools();
  }, [printMode]);
  useEffect(() => {
    rectCache.current = null;
  }, [zoom]);
  // Scrolling a long note: every stroke's geometry (the ink engine's model of the line) is built
  // the first time its page is painted, which on a slower tablet stalled scrolling into pages not
  // seen yet. After the note opens or changes, it is built in the background a few ms at a time,
  // nearest to the view first, and paused while a pen, finger or gesture is down.
  useEffect(() => {
    if (printMode) return;
    const strokes = page.strokes;
    let order: Stroke[] | null = null;
    let i = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const slice = () => {
      timer = null;
      if (drawing.current || gestures.inking || gestures.touches > 0) {
        timer = setTimeout(slice, 200);
        return;
      }
      if (!order) {
        const cont = containerRef.current;
        const c = cont?.getBoundingClientRect();
        const root = scrollRoot?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
        const scale = c && sizeRef.current.h ? c.height / sizeRef.current.h : 1;
        const mid = c ? ((root.top + root.bottom) / 2 - c.top) / (scale || 1) : 0;
        const dist = new Map(strokes.map((s) => {
          const r = strokeYRange(s);
          return [s, Math.max(0, r.minY - mid, mid - r.maxY)];
        }));
        order = strokes.slice().sort((a, b) => dist.get(a)! - dist.get(b)!);
      }
      const until = performance.now() + 4;
      while (i < order.length && performance.now() < until) {
        const s = order[i++];
        prepareStroke(s);
        // What the pinch overlay's worker needs (encoding it at the first pinch made it stutter).
        sceneItem(s);
      }
      if (i < order.length) timer = setTimeout(slice, 16);
    };
    timer = setTimeout(slice, 300);
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [printMode, page.strokes, scrollRoot]);
  // Shape tool: the page's snap targets are built ahead of the first shape, and again after edits.
  useEffect(() => {
    if (printMode || tools.tool !== 'shape') return;
    const grid = tools.shapeGridSnap ? paperGrid(paperStyleRef.current) : null;
    const strokes = page.strokes;
    const id = setTimeout(() => snapCacheFor(strokes, tools.shapeSnap, grid), 50);
    return () => clearTimeout(id);
  }, [printMode, tools.tool, tools.shapeSnap, tools.shapeGridSnap, page.strokes]);

  // iPadOS Scribble / system gestures: Pencil strokes on the canvas must never be interpreted as
  // handwriting input or scrolling, which delays and drops strokes. Fingers that do not draw are let
  // through: they scroll the note natively (useViewport.ts decides which touches may).
  useEffect(() => {
    const c = inputRef.current;
    if (!c) return;
    const block = (e: TouchEvent) => {
      const stylus = [...e.touches].some((t) => (t as Touch & { touchType?: string }).touchType === 'stylus');
      if (toolsRef.current.stylusOnly && !stylus && !gestures.inking) return;
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
    /** Pen tool: the stroke being written (Nib model + live painter, src/ink/engine). */
    model: LiveStroke | null;
    realPressure: boolean;
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
    recFrames: number[];
    /** Pen tool in the app: the shell draws the live stroke natively too (src/ink/nativeInk.ts). */
    ink: NativeInk | null;
    inkTf: InkTransform | null;
    /** The pen lifted before the shell's last samples arrived: finish when they do. */
    finishPending: { cancelled: boolean; pointerType: string; timer: ReturnType<typeof setTimeout> } | null;
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
    return {
      mode: t.shapeMode, color: t.shapeColor, width: t.penWidth, fill: t.shapeFill, arrow: t.shapeArrow, lineStyle: t.shapeLineStyle, snap: t.shapeSnap,
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
      next = paintSmart(ctx, d, k);
      const m = smartPenMeasure(d.smart);
      if (m) next = unionRect(next, drawMeasure(ctx, m.text, m.at, k, sizeRef.current.w));
    } else if (d && d.model && !d.snapped) {
      if (d.rec) d.recFrames.push(Math.round((performance.now() - d.start) * 10) / 10);
      const style = liveStyle('pen');
      d.model.paint(ctx, { color: style.color, width: strokeWidth({ ...style, isShape: false }), variable: isVariableWidth(style) && d.realPressure });
    } else if (d && (d.tool === 'pen' || d.tool === 'highlighter')) {
      if (d.snapped) {
        next = paintSnapped(ctx, d);
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
  /** The Draw tool's shape in progress and its snap dot (the measure label is drawn by renderActive). */
  function paintSmart(ctx: CanvasRenderingContext2D, d: NonNullable<typeof drawing.current>, k: number): DirtyRect | null {
    let next: DirtyRect | null = null;
    const opts = smartOptions();
    const shape = d.snapped ?? (d.smart ? smartPenShape(d.smart, false) : null);
    if (shape) {
      next = drawLiveStroke(ctx, shape.points, {
        tool: 'pen', color: opts.color, width: opts.width, penStyle: 'ballpoint', isShape: true, closed: shape.closed, shapeKind: shape.kind,
        lineStyle: shape.kind === 'point' ? 'solid' : opts.lineStyle,
        fill: shape.closed ? opts.fill : undefined,
        arrow: !shape.closed && opts.arrow,
      });
    }
    const dot = d.snapped ? null : d.smart?.snapDot;
    if (dot) next = unionRect(next, drawSnapDot(ctx, dot, d.smart?.snapKind === 'grid', k));
    return next;
  }

  /** A pen or highlighter stroke snapped to a shape (hold to snap). */
  function paintSnapped(ctx: CanvasRenderingContext2D, d: NonNullable<typeof drawing.current>): DirtyRect | null {
    if (!d.snapped) return null;
    return drawLiveStroke(ctx, d.snapped.points, { ...liveStyle(d.tool as 'pen' | 'highlighter'), isShape: true, closed: d.snapped.closed, shapeKind: d.snapped.kind });
  }

  /** Settled live ink of a finished/cancelled stroke, cleared on the next frame. */
  const staleInk = useRef<DirtyRect | null>(null);

  const retireInk = (d: NonNullable<typeof drawing.current>) => {
    staleInk.current = unionRect(staleInk.current, d.model?.bounds ?? null);
  };

  const renderRef = useRef(renderActive);
  renderRef.current = renderActive;

  const requestRender = useCallback(() => {
    if (raf.current === null) raf.current = requestAnimationFrame(() => renderRef.current());
  }, []);

  const clearActive = useCallback(() => {
    if (drawing.current) retireInk(drawing.current);
    drawing.current?.ink?.cancel();
    drawing.current = null;
    gestures.inking = false;
    eraserPos.current = null;
    requestRender();
  }, [requestRender]);

  // A second finger (pinch / two-finger scroll) cancels what the first finger started, leaving no
  // trace: the stroke in progress is dropped, what it erased comes back, a text box it was about to
  // place is not placed.
  useEffect(
    () =>
      gestures.onCancel(() => {
        pendingText.current = null;
        const d = drawing.current;
        if (d && d.pointerType === 'touch') {
          if (d.holdTimer) clearTimeout(d.holdTimer);
          if (d.tool === 'eraser') editor.cancelGesture();
          clearActive();
        }
      }),
    [gestures, clearActive, editor]
  );
  /** Text tool, finger: the text box is placed when the finger lifts (a second finger may make it a pinch). */
  const pendingText = useRef<{ pointerId: number; pt: Point } | null>(null);

  // getBoundingClientRect forces a layout: measured at pen-down and again only after the page moved.
  const rectCache = useRef<DOMRect | null>(null);
  const canvasRect = () => (rectCache.current ??= inputRef.current!.getBoundingClientRect());

  const toPoint = (e: { clientX: number; clientY: number; pressure: number; pointerType: string; timeStamp?: number }, start: number, angles = {}): Point => {
    const rect = canvasRect();
    return {
      x: ((e.clientX - rect.left) * sizeRef.current.w) / rect.width,
      y: ((e.clientY - rect.top) * sizeRef.current.h) / rect.height,
      pressure: e.pointerType === 'pen' ? (e.pressure > 0 ? e.pressure : 0.5) : 0.5,
      t: Math.round((eventTime(e) - start) * 10) / 10,
      ...angles,
    };
  };

  /** Strokes the precision eraser made in the current gesture (the fill it leaves of a shape stays). */
  const eraseMade = useRef(new Set<string>());
  const eraseAt = (x: number, y: number) => {
    const r = toolsRef.current.eraserSize;
    if (toolsRef.current.eraserMode === 'partial') {
      const made = eraseMade.current;
      const makeId = () => {
        const id = newId('stroke');
        made.add(id);
        return id;
      };
      editor.previewPage(page.id, (p) => {
        const res = eraseStrokesPartial(p.strokes, x, y, r, makeId, made);
        return res.changed ? { ...p, strokes: res.strokes } : p;
      });
    } else {
      editor.previewPage(page.id, (p) => {
        const keep = p.strokes.filter((s) => !strokeHitTest(s, x, y, r));
        return keep.length === p.strokes.length ? p : { ...p, strokes: keep };
      });
    }
  };

  /**
   * Draw & hold: the pen held still at the end of a stroke turns it into the clean shape (circle,
   * polygon, line...), which the pen then sizes until it lifts. Pen and Draw tool (smart curve):
   * for the Draw tool the line as drawn is used, already closed when it came back to its start.
   */
  const armHoldToSnap = () => {
    const d = drawing.current;
    const smartCurve = d?.tool === 'shape' && d.smart?.mode === 'curve';
    if (!d || (d.tool !== 'pen' && !smartCurve) || !toolsRef.current.holdToSnap || d.snapped) return;
    if (d.holdTimer) clearTimeout(d.holdTimer);
    d.holdTimer = setTimeout(() => {
      const cur = drawing.current;
      if (!cur || cur !== d || cur.points.length < 6) return;
      let source: Point[] = cur.points;
      if (cur.smart) {
        const line = smartPenShape(cur.smart, false);
        if (!line || line.points.length < 3) return;
        source = line.closed ? [...line.points, line.points[0]] : line.points;
      }
      const shape = detectShape(source);
      if (shape) {
        cur.snapped = { points: shape.points, closed: shape.closed, kind: shape.kind };
        const pen = cur.points[cur.points.length - 1];
        cur.adjust = { kind: shape.kind, base: shape.points, closed: shape.closed, pen0: { x: pen.x, y: pen.y } };
        retireInk(cur);
        syncInk(cur);
        haptic('snap');
        requestRender();
      }
    }, 450);
  };

  const placeText = (pt: Point) => {
    const block: TextBlock = {
      id: newId('text'),
      x: pt.x,
      y: pt.y - 14,
      width: (() => {
        const sh = sheetAt(pt.y);
        return Math.max(160, Math.min(520, sh.left + sh.width - pt.x - 32));
      })(),
      text: '',
      fontSize: 18,
      color: '#111827',
      createdAt: Date.now(),
    };
    editor.commitPage(page.id, (p) => ({ ...p, textBlocks: [...(p.textBlocks ?? []), block] }));
    setEditingTextId(block.id);
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
        existing.ink?.cancel();
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
      if (e.pointerType === 'touch') {
        pendingText.current = { pointerId: e.pointerId, pt };
        return;
      }
      placeText(pt);
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
    paperStyleRef.current = sheetAt(pt.y).paperStyle;
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
      model: tool === 'pen' ? new LiveStroke() : null,
      ink: (tool === 'pen' || tool === 'shape') && NativeInk.available ? new NativeInk() : null,
      inkTf: null,
      realPressure: e.pointerType === 'pen' && e.pressure > 0 && e.pressure !== 0.5,
      native: null,
      nativeSeen: false,
      nativeEnded: false,
      lastNativeAt: 0,
      webBuffer: [],
      finishPending: null,
      rec: tool === 'pen' && penRecorder.enabled ? [recSample(pt, e.pointerType === 'pen' ? e.pressure : 0.5, start)] : null,
      recFrames: [],
    };
    drawing.current.model?.add(pt.x, pt.y, pt.t ?? 0, pt.pressure);
    syncInk(drawing.current);
    gestures.inking = true;
    gestures.inkingWith = e.pointerType;
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
      eraseMade.current = new Set();
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
      // A Pencil held still can go quiet: only a pen that has moved away means the samples stopped.
      if (d.nativeSeen) {
        const at = toPoint(native, d.start), last = d.points[d.points.length - 1];
        if (Math.hypot(at.x - last.x, at.y - last.y) < NATIVE_STALL_PX) return;
      }
      nativePencil.detach(d.native);
      d.native = null;
      const lastT = d.points[d.points.length - 1].t ?? 0;
      events.splice(0, events.length, ...d.webBuffer.filter((w) => eventTime(w) - d.start > lastT));
      d.webBuffer = [];
    }
    const predicted = native.getPredictedEvents ? native.getPredictedEvents() : [];
    ingestSamples(d, retimeWebSamples(d, events), predicted[0] ?? null);
    requestRender();
  };

  /**
   * Web pointer events (Android, browsers): the samples' own timestamps drive the ink engine, so
   * they must be real sample times. Chromium gives every coalesced event its hardware time, but
   * some WebViews stamp a whole batch (or a burst of events) with nearly the same time: the engine
   * then reads tens of px in a fraction of a millisecond as a huge speed, and its fit at the start
   * of a stroke flung the ink far off. Bunched timestamps are spread evenly over the time since the
   * previous sample, and times always increase.
   */
  function retimeWebSamples(d: NonNullable<typeof drawing.current>, events: PointerEvent[]): (PointerEvent | PencilSample)[] {
    if (!events.length) return events;
    const times = events.map((e) => eventTime(e));
    const prev = d.start + (d.points[d.points.length - 1].t ?? 0);
    const end = Math.max(times[times.length - 1], prev + events.length * MIN_SAMPLE_DT);
    let bunched = false;
    for (let i = 0; i < times.length; i++) if (times[i] - (i ? times[i - 1] : prev) < MIN_SAMPLE_DT) bunched = true;
    if (!bunched) return events;
    return events.map((e, i) => {
      const anyE = e as PointerEvent & { altitudeAngle?: number; azimuthAngle?: number };
      return {
        clientX: e.clientX, clientY: e.clientY, pressure: e.pressure, pointerType: 'pen' as const,
        timeStamp: prev + ((end - prev) * (i + 1)) / events.length,
        altitudeAngle: anyE.altitudeAngle ?? 0, azimuthAngle: anyE.azimuthAngle ?? 0, tiltX: e.tiltX, tiltY: e.tiltY,
        ...(e.pointerType !== 'pen' ? { pointerType: e.pointerType as 'pen' } : {}),
      };
    });
  }

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
      // The smart curve's ink engine needs to know the pen is in the air (force-less) too.
      if (d.smart) {
        if (!d.snapped) snapTick = moveSmartPen(d.smart, lifting ? { ...pt, pressure: 0 } : pt) || snapTick;
      }
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
    if (d.smart?.mode === 'curve' && !d.snapped) {
      const last = d.points[d.points.length - 1];
      if (Math.hypot(last.x - d.lastMove.x, last.y - d.lastMove.y) > 3) {
        d.lastMove = { x: last.x, y: last.y };
        armHoldToSnap();
      }
    }
    if (!d.smart && (d.tool === 'pen' || d.tool === 'highlighter')) {
      d.predicted = dampedPrediction(d.points, predictedEvent ? { ...toPoint(predictedEvent, d.start), pressure: d.pressure } : null);
      const last = d.points[d.points.length - 1];
      if (!d.snapped && Math.hypot(last.x - d.lastMove.x, last.y - d.lastMove.y) > 3) {
        d.lastMove = { x: last.x, y: last.y };
        armHoldToSnap();
      }
    }
    syncInk(d);
    requestRender();
  }

  /** Page px to the shell's view units, measured once per stroke (the page does not move under the pen). */
  function inkTransform(): InkTransform {
    const rect = canvasRect();
    const unit = nativeInkUnit();
    const root = scrollRoot?.getBoundingClientRect() ?? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    return {
      ox: rect.left * unit,
      oy: rect.top * unit,
      k: (rect.width / sizeRef.current.w) * unit,
      clip: { x: root.left * unit, y: root.top * unit, w: root.width * unit, h: root.height * unit },
    };
  }

  /** Sends the live stroke or shape to the shell's native ink layer (iOS / Android app). */
  function syncInk(d: NonNullable<typeof drawing.current>) {
    if (!d.ink) return;
    d.inkTf ??= inkTransform();
    if (d.smart || d.snapped) {
      // Shapes (Draw tool, or a pen stroke held still and snapped): the whole drawing, as the page draws it.
      const k = 1 / Math.max(0.3, zoomRef.current);
      d.ink.drawing(record(d.inkTf, (ctx) => (d.smart ? paintSmart(ctx, d, k) : paintSnapped(ctx, d))), d.inkTf);
      return;
    }
    if (!d.model) return;
    const style = liveStyle('pen');
    d.ink.update(d.model, { color: style.color, width: strokeWidth({ ...style, isShape: false }), variable: isVariableWidth(style) && d.realPressure }, d.inkTf);
  }

  const nativeInputRef = useRef<(d: NonNullable<typeof drawing.current>, samples: PencilSample[], predicted: PencilSample[], ended: boolean) => void>(() => {});
  nativeInputRef.current = (d, samples, predicted, ended) => {
    if (drawing.current !== d || d.nativeEnded) return;
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
      d.points = [pt];
      d.pressure = pt.pressure;
      d.force = [first.pressure > 0 ? pt.pressure : 0];
      d.lastMove = { x: pt.x, y: pt.y };
      d.realPressure = first.pressure > 0 && first.pressure !== 0.5;
      d.model = new LiveStroke();
      d.model.add(pt.x, pt.y, pt.t ?? 0, pt.pressure);
      if (d.rec) d.rec = [recSample(pt, first.pressure, d.start)];
      samples = samples.slice(1);
    }
    if (!d.nativeSeen && samples.length && d.smart?.mode === 'curve' && d.points.length === 1) {
      // The smart curve is drawn by the ink engine too: it also starts on the shell's first sample.
      const first = samples[0];
      d.start = first.timeStamp;
      const pt = toPoint(first, d.start, stylusAngles(first as unknown as PointerEvent));
      retireInk(d);
      d.points = [pt];
      d.force = [first.pressure > 0 ? pt.pressure : 0];
      d.lastMove = { x: pt.x, y: pt.y };
      d.smart = beginSmartPen(pt, smartOptions(), page.strokes, zoomRef.current);
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
    gestures.inking = false;
    retireInk(d);
    if (d.ink) {
      const ink = d.ink;
      // The finished stroke is painted with React's commit below; the shell's layer is cleared
      // once a frame showing it has been drawn, so the ink never blinks.
      if (cancelled) ink.cancel();
      else requestAnimationFrame(() => requestAnimationFrame(() => ink.end()));
    }

    if (!cancelled && d.smart && d.snapped) {
      // Draw & hold made a clean shape: it keeps the Draw tool's style.
      const opts = smartOptions();
      const sh = d.snapped;
      const stroke: Stroke = {
        id: newId('stroke'), createdAt: Date.now(), tool: 'pen', color: opts.color, width: opts.width, opacity: 1, penStyle: 'ballpoint',
        lineStyle: opts.lineStyle, points: sh.points, isShape: true, closed: sh.closed, shapeKind: sh.kind,
        ...(sh.closed && opts.fill !== 'none' ? { fill: opts.fill } : {}),
        ...(!sh.closed && opts.arrow ? { arrow: true } : {}),
      };
      editor.commitPage(page.id, (p) => ({ ...p, strokes: [...p.strokes, stroke] }));
      haptic('success');
    } else if (!cancelled && d.smart) {
      const made = smartPenStroke(d.smart, smartOptions(), newId('stroke'));
      if (made) {
        const stroke: Stroke = { ...made, createdAt: Date.now() };
        editor.commitPage(page.id, (p) => ({ ...p, strokes: [...p.strokes, stroke] }));
        if (stroke.closed && d.smart.closing) haptic('success');
      }
    } else if (!cancelled && (d.tool === 'pen' || d.tool === 'highlighter')) {
      const style = liveStyle(d.tool);
      if (d.rec) {
        penRecorder.add({
          tool: d.tool, penStyle: style.penStyle, width: style.width, source: d.nativeSeen ? 'native' : 'web',
          pointerType: d.pointerType, zoom: zoomRef.current, recordedAt: Date.now(), samples: d.rec,
          frames: d.recFrames,
        });
      }
      const stroke: Stroke = {
        id: newId('stroke'),
        createdAt: Date.now(),
        tool: d.tool,
        color: style.color,
        width: style.width,
        opacity: 1,
        penStyle: style.penStyle,
        lineStyle: 'solid',
        // Pen strokes keep their lift-off samples: Nib leaves them out of the ink (nib.ts, 4b), the
        // same way live and when the stroke is drawn later.
        points: d.snapped ? d.snapped.points : d.points,
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
        if (d.smart) moveSmartPen(d.smart, { ...pt, pressure: 0 });
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
  // Rotation: the rotate handle turns the selection about its centre; the angle is shown, and
  // snaps to every 15° (0° included) within ROTATE_SNAP. Items remember their total rotation.
  const transform = useRef<{
    mode: 'move' | 'scale' | 'rotate'; startX: number; startY: number; sel: Selection; pointerId: number; dx: number; dy: number; f: number;
    rot: number; startAngle: number; base: number | null;
  } | null>(null);
  const [drag, setDrag] = useState<{ sel: Selection; dx: number; dy: number; f: number; rot: number; base: number | null } | null>(null);
  const dragFrame = useRef<number | null>(null);
  const floatCanvasRef = useRef<HTMLCanvasElement>(null);
  const [liveBounds, setLiveBounds] = useState<Selection['bounds'] | null>(null);
  const shownBounds = drag
    ? { x: drag.sel.bounds.x + drag.dx, y: drag.sel.bounds.y + drag.dy, width: drag.sel.bounds.width * drag.f, height: drag.sel.bounds.height * drag.f }
    : liveBounds ?? selection?.bounds ?? null;
  /** The rotation the selected items share (null: they differ). */
  const selRotation = useMemo(() => (selection ? selectionRotation(page, selection) : null), [page, selection]);

  const centreOf = (b: Selection['bounds']) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
  const angleTo = (e: { clientX: number; clientY: number }, c: { x: number; y: number }) => {
    const p = pagePoint(e);
    return (Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI;
  };

  const startTransform = (e: React.PointerEvent, mode: 'move' | 'scale' | 'rotate') => {
    if (!selection) return;
    // Another finger is already down: the fingers scroll the page (useViewport), nothing is dragged.
    if (e.pointerType === 'touch' && gestures.touches > 1) return;
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const base = selRotation;
    transform.current = {
      mode, startX: e.clientX, startY: e.clientY, sel: selection, pointerId: e.pointerId, dx: 0, dy: 0, f: 1,
      rot: 0, startAngle: mode === 'rotate' ? angleTo(e, centreOf(selection.bounds)) : 0, base,
    };
    gestures.dragging = true;
    setDrag({ sel: selection, dx: 0, dy: 0, f: 1, rot: 0, base });
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
      // Not off the sheet, where the page clips it and it could not be picked up again.
      // (Never pulled back from where it already is: the bounds carry a margin.)
      t.dx = Math.max(Math.min(0, -b.x), Math.min(Math.max(0, PAGE_W - b.x - b.width), dx));
      t.dy = Math.max(Math.min(0, -b.y), Math.min(Math.max(0, PAGE_H - b.y - b.height), dy));
    } else if (t.mode === 'scale') {
      t.f = Math.max(0.2, Math.min(5, Math.max((b.width + dx) / b.width, (b.height + dy) / b.height)));
    } else {
      let rot = normDeg(angleTo(e, centreOf(b)) - t.startAngle);
      // Snap the resulting orientation (or, for items turned differently, the turn) to 15° steps.
      const total = (t.base ?? 0) + rot;
      const near = Math.round(total / 15) * 15;
      if (Math.abs(total - near) < ROTATE_SNAP) rot = near - (t.base ?? 0);
      t.rot = normDeg(rot);
    }
    // One React update per frame, however many pointer events arrive.
    if (dragFrame.current === null) {
      dragFrame.current = requestAnimationFrame(() => {
        dragFrame.current = null;
        const cur = transform.current;
        if (cur) setDrag({ sel: cur.sel, dx: cur.dx, dy: cur.dy, f: cur.f, rot: cur.rot, base: cur.base });
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
    const moved = Math.abs(t.dx) > 0.01 || Math.abs(t.dy) > 0.01 || Math.abs(t.f - 1) > 1e-4 || Math.abs(t.rot) > 1e-3;
    if (moved && !cancelled) {
      const next = transformSelection(pageRef.current, t.sel, t.dx, t.dy, t.f, t.rot);
      editor.commitPage(page.id, (p) => transformSelection(p, t.sel, t.dx, t.dy, t.f, t.rot));
      const b = t.rot ? computeBounds(next, t.sel) : null;
      const o = t.sel.bounds;
      setSelection({ ...t.sel, bounds: b ?? { x: o.x + t.dx, y: o.y + t.dy, width: o.width * t.f, height: o.height * t.f } });
    }
    setDrag(null);
    setHiddenIds(null);
  };

  /** Turns the selection back to its original orientation (0°). */
  const resetSelectionRotation = () => {
    if (!selection) return;
    const sel = selection;
    const next = resetRotation(pageRef.current, sel);
    if (next === pageRef.current) return;
    editor.commitPage(page.id, (p) => resetRotation(p, sel));
    const b = computeBounds(next, sel);
    if (b) setSelection({ ...sel, bounds: b });
  };

  // Two fingers came down (useViewport): a drag in progress is dropped, nothing is committed, and
  // everything stays where it was before the drag.
  useEffect(
    () =>
      gestures.onDragCancel(() => {
        if (transform.current) {
          transform.current = null;
          if (dragFrame.current !== null) cancelAnimationFrame(dragFrame.current);
          dragFrame.current = null;
          setDrag(null);
          setHiddenIds(null);
        }
        if (handleDrag.current) {
          handleDrag.current = null;
          setHiddenIds(null);
          setEditHandles(null);
          setLiveBounds(null);
          requestRender();
        }
      }),
    [gestures, requestRender]
  );

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
    () => (drag && drag.sel.latexIds.length + drag.sel.textIds.length + drag.sel.imageIds.length ? transformSelection({ ...page, strokes: [] }, drag.sel, drag.dx, drag.dy, drag.f, drag.rot) : page),
    [drag, page]
  );
  /** The content in stacking order (editor/zorder.ts); unchanged ink layers keep their arrays. */
  const layersRef = useRef<ZLayer[] | undefined>(undefined);
  const layers = useMemo(() => (layersRef.current = zLayers({ ...blockPage, strokes: shownStrokes }, layersRef.current)), [blockPage, shownStrokes]);

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
    return { x: ((e.clientX - rect.left) * sizeRef.current.w) / rect.width, y: ((e.clientY - rect.top) * sizeRef.current.h) / rect.height };
  };

  const startHandle = (e: React.PointerEvent, h: ShapeHandle) => {
    if (!editShape || !selection) return;
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const others = page.strokes.filter((s) => s.id !== editShape.id);
    const grid = tools.shapeGridSnap ? paperGrid(sheetAt(h.y).paperStyle) : null;
    const cache = snapCacheFor(others, tools.shapeSnap, grid);
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
  const pageStyle: React.CSSProperties = { width: PAGE_W, height: PAGE_H };

  // Block views are memoised and keep their first handlers: these read the current tool and page.
  const latexHandlers = (b: LatexBlock) => ({
    onSelect: () => {
      if (toolsRef.current.tool === 'lasso') {
        setSelection(singleBlockSelection(pageRef.current, 'latex', b.id));
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
      className="on-page relative select-none overflow-hidden"
      style={pageStyle}
      data-page-index={pageIndex}
    >
      {/* The pages' paper: one continuous strip, cut where a page ends (a hairline). */}
      {layout.sheets.map((sh) => (
        <div
          key={sh.id}
          className={`absolute pointer-events-none ${printMode ? '' : 'shadow-[0_4px_24px_rgba(0,0,0,0.12)]'}`}
          style={{ left: sh.left, top: sh.top, width: sh.width, height: sh.height, ...paperBackground(sh.paperStyle, sh.paperColor, { x: sh.left, y: sh.top }) }}
        />
      ))}
      {/*
        Stacking: the paper, then the content in the order it was made (editor/zorder.ts): strokes
        made before an image or a block are under it, strokes made after it over it. Then the
        selection being moved and the input layer.
      */}
      {layers.map((l) => {
        if (l.kind === 'ink') {
          if (vector && !printMode) {
            return (
              <React.Fragment key={l.key}>
                {layout.sheets.map((sh) => (
                  <VectorTile key={sh.id} top={sh.top} width={PAGE_W} height={sh.height} strokes={l.strokes} scrollRoot={scrollRoot} paperOf={svgPaperOf} />
                ))}
              </React.Fragment>
            );
          }
          return vector ? (
            <svg
              key={l.key}
              className="absolute inset-0 pointer-events-none"
              width={PAGE_W}
              height={PAGE_H}
              viewBox={`0 0 ${PAGE_W} ${PAGE_H}`}
              dangerouslySetInnerHTML={{ __html: layerSvg(l.strokes) }}
            />
          ) : (
            <React.Fragment key={l.key}>
              {layout.sheets.map((sh) => (
                <InkTile key={sh.id} eager={sh.index < 2} top={sh.top} width={PAGE_W} height={sh.height} strokes={l.strokes} ratio={canvasRatio(zoom, PAGE_W * sh.height)} scrollRoot={scrollRoot} />
              ))}
            </React.Fragment>
          );
        }
        if (l.kind === 'image') return <ImageBlockView key={l.key} block={l.block} selected={!!selection?.imageIds.includes(l.block.id)} />;
        if (l.kind === 'latex') {
          const b = l.block;
          return (
            <LatexBlockView
              key={l.key}
              block={b}
              inkColor={inkAt(b.y + b.height / 2)}
              darkPaper={darkAt(b.y + b.height / 2)}
              interactive={blocksInteractive && !printMode}
              selected={selectedBlockId === b.id}
              zoom={zoom}
              measure={!printMode}
              {...latexHandlers(b)}
            />
          );
        }
        const t = l.block;
        return (
          <TextBlockView
            key={l.key}
            block={t}
            interactive={blocksInteractive && !printMode}
            editing={editingTextId === t.id}
            selected={false}
            zoom={zoom}
            darkPaper={darkAt(t.y)}
            onStartEdit={() => {
              if (toolsRef.current.tool === 'lasso') setSelection(singleBlockSelection(pageRef.current, 'text', t.id));
              else setEditingTextId(t.id);
            }}
            onCommit={(text) => {
              setEditingTextId(null);
              const cur = (pageRef.current.textBlocks ?? []).find((x) => x.id === t.id);
              if (!cur) return;
              if (!text.trim()) editor.commitPage(page.id, (p) => ({ ...p, textBlocks: (p.textBlocks ?? []).filter((x) => x.id !== t.id) }));
              else if (text !== cur.text) editor.commitPage(page.id, (p) => ({ ...p, textBlocks: (p.textBlocks ?? []).map((x) => (x.id === t.id ? { ...x, text } : x)) }));
            }}
            onDelete={() => editor.commitPage(page.id, (p) => ({ ...p, textBlocks: (p.textBlocks ?? []).filter((x) => x.id !== t.id) }))}
            onSilentUpdate={() => undefined}
          />
        );
      })}
      {layerSel && layerSel.strokeIds.length > 0 && (
        <canvas
          ref={floatCanvasRef}
          className="absolute pointer-events-none z-[5]"
          style={{
            left: layerSel.bounds.x - FLOAT_PAD,
            top: layerSel.bounds.y - FLOAT_PAD,
            width: layerSel.bounds.width + FLOAT_PAD * 2,
            height: layerSel.bounds.height + FLOAT_PAD * 2,
            transformOrigin: drag?.rot ? 'center' : `${FLOAT_PAD}px ${FLOAT_PAD}px`,
            transform: drag ? (drag.rot ? `rotate(${drag.rot}deg)` : `translate(${drag.dx}px, ${drag.dy}px) scale(${drag.f})`) : undefined,
            willChange: drag ? 'transform' : undefined,
          }}
        />
      )}

      {/* Input layer (pen, highlighter, eraser, lasso, text placement) */}
      {!printMode && <canvas ref={activeCanvasRef} className="absolute left-0 z-10 pointer-events-none" style={{ top: 0, width: PAGE_W, height: 0 }} />}
      {visible && !printMode && (
        <div
          ref={inputRef}
          data-ink-input
          className="absolute inset-0 z-10"
          style={{
            // Fingers that do not draw scroll the note natively (useViewport.ts); the Pencil's touches
            // are cancelled there before they can scroll.
            touchAction: tools.stylusOnly ? 'pan-x pan-y' : 'none',
            pointerEvents: tools.tool === 'hand' ? 'none' : 'auto',
            cursor: tools.tool === 'text' ? 'text' : tools.tool === 'eraser' ? 'cell' : 'crosshair',
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => {
            const t = pendingText.current;
            if (t && t.pointerId === e.pointerId) {
              pendingText.current = null;
              if (gestures.touches <= 1 && !gestures.navigating) placeText(t.pt);
            }
            finish(e, false);
          }}
          onPointerCancel={(e) => {
            if (pendingText.current?.pointerId === e.pointerId) pendingText.current = null;
            finish(e, true);
          }}
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
          data-no-pan
          className="absolute z-20 border-2 border-dashed border-blue-500 bg-blue-500/5 rounded-lg cursor-move"
          style={{
            left: shownBounds.x, top: shownBounds.y, width: shownBounds.width, height: shownBounds.height, touchAction: 'none',
            transform: drag?.rot ? `rotate(${drag.rot}deg)` : undefined,
          }}
          onPointerDown={(e) => startTransform(e, 'move')}
          onPointerMove={moveTransform}
          onPointerUp={(e) => endTransform(e)}
          onPointerCancel={(e) => endTransform(e, true)}
        >
          {/* Rotate handle, and the rotation from the original orientation (with a reset to 0°). */}
          <div
            className={`absolute left-1/2 flex items-center pointer-events-none ${shownBounds.y < 80 ? 'top-full flex-col-reverse' : 'bottom-full flex-col'}`}
            style={{
              transform: `translateX(-50%) scale(${Math.max(1, 1 / zoom)})`,
              transformOrigin: shownBounds.y < 80 ? 'top center' : 'bottom center',
              ...(shownBounds.y < 80 ? { paddingTop: 6 } : { paddingBottom: 6 }),
            }}
          >
            <div className="flex items-center gap-1 my-1 pointer-events-auto" onPointerDown={(e) => e.stopPropagation()}>
              {drag && transform.current?.mode === 'rotate' ? (
                <span className="px-2 py-0.5 rounded-full bg-gray-900/85 text-white text-[11px] font-semibold tabular-nums">
                  {drag.base !== null ? `${normDeg(drag.base + drag.rot)}°` : `${drag.rot > 0 ? '+' : ''}${drag.rot}°`}
                </span>
              ) : (
                !drag && selRotation !== 0 && (
                  <>
                    <span className="px-2 py-0.5 rounded-full bg-gray-900/85 text-white text-[11px] font-semibold tabular-nums" title="Rotation from the original orientation">
                      {selRotation === null ? 'mixed' : `${selRotation}°`}
                    </span>
                    <button
                      className="px-2 py-0.5 rounded-full bg-blue-600 text-white text-[11px] font-semibold"
                      title="Back to the original orientation (0°)"
                      onClick={resetSelectionRotation}
                    >
                      ↺ 0°
                    </button>
                  </>
                )
              )}
            </div>
            <div
              data-no-pan
              className="w-7 h-7 bg-white text-blue-600 border-2 border-blue-600 rounded-full flex items-center justify-center shadow-md cursor-grab pointer-events-auto"
              style={{ touchAction: 'none' }}
              title="Rotate (snaps every 15°)"
              onPointerDown={(e) => startTransform(e, 'rotate')}
              onPointerMove={moveTransform}
              onPointerUp={(e) => endTransform(e)}
              onPointerCancel={(e) => endTransform(e, true)}
            >
              <RotateCw className="w-3.5 h-3.5" />
            </div>
            <div className="w-px h-3 bg-blue-500" />
          </div>
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

      {/* Page lines and numbers; the PDF is cut at the lines. */}
      {!printMode &&
        layout.sheets.map((sh) => (
          <React.Fragment key={sh.id}>
            {sh.index > 0 && (
              <div
                className="absolute pointer-events-none"
                style={{
                  left: Math.min(sh.left, layout.sheets[sh.index - 1].left), width: Math.max(sh.width, layout.sheets[sh.index - 1].width), top: sh.top - 0.5, height: 1,
                  background: sh.paperColor === 'dark' ? 'rgba(255,255,255,0.18)' : 'rgba(100,116,139,0.35)',
                }}
              />
            )}
            <div className="absolute text-[11px] font-medium text-gray-400 pointer-events-none" style={{ left: sh.left + sh.width - 40, width: 24, textAlign: 'right', top: sh.top + sh.height - 22 }}>
              {sh.index + 1}
            </div>
          </React.Fragment>
        ))}
    </div>
  );
};

export const CanvasPage = React.memo(CanvasPageImpl);
