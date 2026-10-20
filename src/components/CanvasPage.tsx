import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Maximize2, RotateCw } from 'lucide-react';
import {
  EraserMode, FillType, LatexBlock, LineStyle, NotePage, PaperColor, PaperStyle, PenStyle, Point, ShapeMode, Stroke,
  TextBlock, ToolType, newId,
} from '../types';
import {
  drawLiveStroke, drawStroke, drawStrokes, eraseStrokesPartial, isVariableWidth, paintStrokeFill, paintStrokeInk, strokeHitTest, strokePaintBounds,
  strokeWidth, InkStyle, strokeToSvg, styleOf, prepareStroke, strokeBuilt,
} from '../ink/strokeRenderer';
import { SmoothLiveStroke, pixelAligned } from '../ink/smoothLiveStroke';
import { crashLog } from '../services/crashLog';
import { SampleDensifier } from '../ink/densify';
import { RecordedSample, penRecorder } from '../ink/penRecorder';
import { PencilListener, PencilSample, nativePencil } from '../ink/nativePencil';
import { InkTransform, NativeInk, nativeInkUnit } from '../ink/nativeInk';
import { record } from '../ink/inkRecorder';
import { tileWork } from '../editor/tileWork';
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
/**
 * The paper's pattern as CSS backgrounds. `scale`: how much the page is shrunk where it is shown
 * (thumbnails, ~0.2-0.3): lines and dots are then drawn thicker and stronger in page px so they
 * stay at least about one screen pixel, and graph paper keeps only its major lines. At full size
 * the 1 px grid lines fell below a pixel in the thumbnails and grid / graph pages looked blank.
 */
export function paperBackground(style: PaperStyle, color: PaperColor, origin = { x: 0, y: 0 }, scale = 1, swatch = false): React.CSSProperties {
  const dark = color === 'dark';
  const base = PAPER_COLORS[color] ?? PAPER_COLORS.white;
  const small = scale < 0.6;
  // Line thickness in page px, so a line covers about 0.9 screen px at this scale.
  const lw = small ? Math.max(1, 0.9 / scale) : 1;
  const boost = (a: number) => (small ? Math.min(1, a * 1.5) : a);
  const line = dark ? `rgba(255,255,255,${boost(0.13)})` : `rgba(59,130,246,${boost(0.22)})`;
  const grid = dark ? `rgba(255,255,255,${boost(0.09)})` : `rgba(0,0,0,${boost(0.08)})`;
  const margin = dark ? 'rgba(239,68,68,0.35)' : 'rgba(239,68,68,0.4)';
  const css: React.CSSProperties = { backgroundColor: base };
  if ((style === 'ruled' || style === 'narrow') && swatch) {
    // A small sample of the pattern (paper picker): lines and the margin, without the blank band a
    // page keeps at its top (taller than the sample, which then looked blank).
    const gap = style === 'narrow' ? 6 : 9;
    css.backgroundImage = [
      `linear-gradient(to right, transparent 9px, ${margin} 9px, ${margin} 10px, transparent 10px)`,
      `linear-gradient(to bottom, transparent ${gap - 1}px, ${line} ${gap - 1}px, ${line} ${gap}px)`,
    ].join(',');
    css.backgroundSize = `100% 100%, 100% ${gap}px`;
    css.backgroundRepeat = 'no-repeat, repeat';
  } else if (style === 'ruled' || style === 'narrow') {
    const gap = style === 'narrow' ? 24 : 32;
    css.backgroundImage = [
      `linear-gradient(to right, transparent 79px, ${margin} 79px, ${margin} ${79 + lw}px, transparent ${79 + lw}px)`,
      `linear-gradient(${base}, ${base})`,
      `linear-gradient(to bottom, transparent ${gap - lw}px, ${line} ${gap - lw}px, ${line} ${gap}px)`,
    ].join(',');
    css.backgroundSize = `100% 100%, 100% 79px, 100% ${gap}px`;
    css.backgroundPosition = `0 0, 0 0, 0 ${80 - gap}px`;
    css.backgroundRepeat = 'no-repeat, no-repeat, repeat';
  } else if (style === 'grid') {
    css.backgroundImage = `linear-gradient(to right, ${grid} ${lw}px, transparent ${lw}px), linear-gradient(to bottom, ${grid} ${lw}px, transparent ${lw}px)`;
    css.backgroundSize = '24px 24px';
    css.backgroundPosition = `${-origin.x}px ${-origin.y}px`;
  } else if (style === 'graph') {
    // Millimetre-style graph paper: fine lines every 12 px, stronger ones every 60 px (only those
    // when shrunk: the fine ones would fill the thumbnail).
    const major = dark ? `rgba(255,255,255,${boost(0.16)})` : `rgba(0,0,0,${boost(0.13)})`;
    const minor = dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)';
    const layers = [
      `linear-gradient(to right, ${major} ${lw}px, transparent ${lw}px)`,
      `linear-gradient(to bottom, ${major} ${lw}px, transparent ${lw}px)`,
    ];
    if (!small) layers.push(`linear-gradient(to right, ${minor} 1px, transparent 1px)`, `linear-gradient(to bottom, ${minor} 1px, transparent 1px)`);
    css.backgroundImage = layers.join(',');
    css.backgroundSize = small ? '60px 60px, 60px 60px' : '60px 60px, 60px 60px, 12px 12px, 12px 12px';
    css.backgroundPosition = `${-origin.x}px ${-origin.y}px`;
  } else if (style === 'dots') {
    const r = small ? Math.min(6, 1.3 / Math.max(scale, 0.25)) : 1.3;
    css.backgroundImage = `radial-gradient(circle, ${dark ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.22)'} ${r}px, transparent ${r + 0.4}px)`;
    css.backgroundSize = '24px 24px';
    css.backgroundPosition = `${12 - origin.x}px ${12 - origin.y}px`;
  }
  return css;
}

/** Lattice spacing of grid and dot paper (see paperBackground), or null for other papers. */
export function paperGrid(style: PaperStyle): number | null {
  return style === 'grid' || style === 'dots' ? 24 : style === 'graph' ? 12 : null;
}

/**
 * Largest canvas backing store (px). Just under WebKit's limit for a GPU-backed canvas (5120x2880):
 * a larger one is drawn without the GPU, and a 4 GB iPad runs short of GPU memory sooner.
 */
const MAX_CANVAS_PIXELS = 14_500_000;
/**
 * The page canvases' zoom is the zoom that fits the page's width on this screen (100% with an
 * iPad upright, about 150% sideways; at most this), whatever the user zooms to; above it committed
 * ink is drawn by SharpInk (screen resolution at any zoom) over them. The page canvases are
 * page-sized: following the zoom cost tens of MB per page and per ink layer, reallocated (and
 * briefly doubled while repainting) at every zoom; a quick pinch on a 4 GB iPad, after a LaTeX
 * conversion added a second ink layer, ran the GPU out of memory: a black screen. Here zooming
 * in costs memory for the screen, not for the zoom, and never repaints the
 * pages; the usual reading view (and scrolling it) stays on the page canvases.
 */
const PAGE_CANVAS_MAX_ZOOM = 1.5;
/**
 * From this zoom page canvases draw handwriting as the smooth line (strokeRenderer.smoothGeometry):
 * the engine's line is straight between Pencil samples, which shows as faint corners when zoomed in.
 * Below it the ink is the engine's line, exactly as drawn live.
 */
const SMOOTH_ZOOM = 1.5;
/** Whether ink at `zoom` is drawn as the smooth line. */
function smoothAt(zoom: number): boolean {
  // Zoomed in only: at ordinary zoom the finished stroke must be exactly the line drawn live, or
  // it visibly shifted when the pen lifted (a retrace). v2.0.10 smoothed by screen density, so on
  // Android every stroke shifted a little at lift.
  return zoom >= SMOOTH_ZOOM;
}
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
const strokeAreas = new WeakMap<Stroke, DirtyRect>();

/**
 * Where a stroke may paint, from its points with a margin for its width and an arrowhead: cheap,
 * unlike strokePaintBounds, which builds the stroke (runs the ink engine) to know.
 */
function strokeArea(s: Stroke): DirtyRect {
  let r = strokeAreas.get(s);
  if (!r) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of s.points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const pad = (s.tool === 'highlighter' ? s.width * 3 : Math.max(9, s.width * 4.6)) + 12;
    r = { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
    strokeAreas.set(s, r);
  }
  return r;
}

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
 * is up to 14.5 Mpx and WebKit has a tight total canvas budget), and each one is the cached bitmap of
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
 * Paints `job` on ctx a few ms per frame (not at all while two fingers zoom), in the order
 * drawStrokes uses (highlighters, then fills, then ink), then calls done. Returns a cancel.
 */
function paintSliced(ctx: CanvasRenderingContext2D, job: Stroke[], opts: { smooth: boolean }, done: () => void): () => void {
  const passes: ((s: Stroke) => boolean)[] = [
    (s) => s.tool === 'highlighter',
    (s) => s.tool !== 'highlighter' && !!s.fill && s.fill !== 'none',
    (s) => s.tool !== 'highlighter',
  ];
  let pass = 0, i = 0;
  let frame: number | null = null;
  const step = () => {
    frame = null;
    if (tileWork.paused) {
      frame = requestAnimationFrame(step);
      return;
    }
    const until = performance.now() + TILE_SLICE_MS;
    while (pass < passes.length) {
      for (; i < job.length; i++) {
        if (performance.now() > until) {
          frame = requestAnimationFrame(step);
          return;
        }
        const s = job[i];
        if (!passes[pass](s) || !s.points.length) continue;
        if (pass === 0) drawStrokes(ctx, [s], opts);
        else if (pass === 1) paintStrokeFill(ctx, s, opts);
        else paintStrokeInk(ctx, s, opts);
      }
      pass++;
      i = 0;
    }
    done();
  };
  step();
  return () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  };
}

/** Side of a sharp tile in backing pixels (a tile is 1 MB: always GPU backed, cheap to keep). */
const SHARP_TILE = 512;
/** Most sharp tiles kept per ink layer (the view and its margin; farthest dropped first). */
const SHARP_MAX_TILES = 48;
/** Share of the view added on each side, painted ahead for scrolling. */
const SHARP_MARGIN = 0.25;
/** The view has rested this long (ms) after scrolling: the tiles it needs are painted. */
const SHARP_IDLE_MS = 120;
/** Painting tiles takes at most this long (ms) per frame; the rest follow on the next frames. */
const SHARP_FRAME_MS = 8;
/**
 * The same for the tiles in view after a zoom: they are painted hidden, the previous zoom's tiles
 * staying on screen, and shown all at once when done (no softer picture first). All in one frame
 * froze a slower tablet for hundreds of ms at the end of every pinch.
 */
const SHARP_VISIBLE_FRAME_MS = 16;
/** The margin's tiles (only needed for the next scroll) wait until the view has rested this long (ms). */
const SHARP_MARGIN_DELAY_MS = 300;

/** A part of the surface (surface px). */
type SurfRect = { x0: number; y0: number; x1: number; y1: number };
type SharpTile = { i: number; j: number; canvas: HTMLCanvasElement; painted: Stroke[] | null };

/**
 * Committed ink of one layer where the page is zoomed in past what the page canvases hold sharp
 * (their pixel budget; from about 2x on an iPad), drawn at exactly the screen's resolution.
 *
 * It is a grid of small tiles (SHARP_TILE backing px each, at zoom x
 * devicePixelRatio): only the tiles over the view and a margin exist, each holding the strokes
 * that reach into it. Tiles are painted nearest first a few per frame, so the view sharpens
 * progressively and never allocates one large canvas (WebKit gives a canvas a GPU backing only up
 * to 5120x2880 px, and a 4 GB iPad runs short of GPU memory sooner); scrolling paints only the
 * tiles coming into view, and an edit repaints only the tiles it touches.
 *
 * The tiles are INSIDE the scaled content like the page canvases, so they move and scale with the
 * paper by construction; while two fingers zoom they are scaled as they are, and once the view
 * rests they are painted again for the new scale. The page canvases stay under them, hidden while
 * the painted tiles cover the view (their softer ink would show around the edges) and shown again
 * when a scroll reaches unpainted tiles or a pinch starts, so the ink is never missing.
 *
 * SVG used to do this, but WebKit rasterises a composited SVG inside a CSS-scaled element at its
 * unscaled size and stretches it: on the iPad, ink at 500% was a 1x bitmap magnified five times.
 * A canvas's resolution is the one it is given.
 */
const SharpInk = React.memo(function SharpInk(props: { strokes: Stroke[]; sheets: SheetBox[]; layerKey: string; width: number; height: number; zoom: number; scrollRoot: HTMLElement | null }) {
  const { strokes, layerKey, width: W, height: H, zoom, scrollRoot } = props;
  const holderRef = useRef<HTMLDivElement>(null);
  const tiles = useRef(new Map<string, SharpTile>());
  /** Backing px per surface px of the tiles there are. */
  const scale = useRef(0);
  /**
   * Where the tile grid starts (surface px, within half a backing px of the page's corner): on a
   * whole screen pixel, so every tile is composited at whole pixels (at a fraction its edges
   * were blended with the transparent outside: a faint seam every SHARP_TILE px).
   */
  const origin = useRef({ x: 0, y: 0 });
  const frame = useRef<number | null>(null);
  const marginTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const opts = { smooth: smoothAt(zoom) };

  /** The page's content element (the holder's parent), kept for the cleanup at unmount. */
  const containerRef = useRef<HTMLElement | null>(null);
  /** Hides or shows this layer's page canvases (every page's, also ones added since). */
  const tilesHidden = useRef(false);
  const hidePages = (hide: boolean) => {
    const container = containerRef.current;
    if (!container || tilesHidden.current === hide) return;
    tilesHidden.current = hide;
    for (const sh of latest.current.sheets) {
      const el = container.querySelector<HTMLElement>(`[data-ink-key="${layerKey}:${sh.id}"]`);
      if (el) el.style.visibility = hide ? 'hidden' : '';
    }
  };

  /** The visible part of the surface, the scale for it and the page's corner on screen (device px); null when off the page. */
  const viewNow = (): { visible: SurfRect; r: number; corner: { x: number; y: number } } | null => {
    const container = containerRef.current;
    if (!container) return null;
    const { width: w, height: h, scrollRoot: root } = latest.current;
    const c = container.getBoundingClientRect();
    const rr = root?.getBoundingClientRect() ?? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    const s = c.width / w;
    if (!(s > 0)) return null;
    const visible = { x0: Math.max(0, (rr.left - c.left) / s), x1: Math.min(w, (rr.right - c.left) / s), y0: Math.max(0, (rr.top - c.top) / s), y1: Math.min(h, (rr.bottom - c.top) / s) };
    if (visible.x1 <= visible.x0 || visible.y1 <= visible.y0) return null;
    // Scale and corner as the tiles' own holder (exactly the surface's width) is drawn: the
    // content element's box and the zoom value both differ from it a little, enough to put every
    // tile off whole pixels.
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const o = holderRef.current?.getBoundingClientRect();
    const hs = o && o.width > 0 ? o.width / w : s;
    return { visible, r: hs * dpr, corner: { x: (o ?? c).left * dpr, y: (o ?? c).top * dpr } };
  };

  /** Tile index ranges over `v` at scale r. */
  const tileRange = (v: SurfRect, r: number) => {
    const t = SHARP_TILE / r, o = origin.current;
    const { width: w, height: h } = latest.current;
    return {
      i0: Math.max(Math.floor(-o.x / t), Math.floor((v.x0 - o.x) / t)),
      i1: Math.min(Math.ceil((w - o.x) / t) - 1, Math.floor((v.x1 - o.x - 1e-6) / t)),
      j0: Math.max(Math.floor(-o.y / t), Math.floor((v.y0 - o.y) / t)),
      j1: Math.min(Math.ceil((h - o.y) / t) - 1, Math.floor((v.y1 - o.y - 1e-6) / t)),
    };
  };
  const tileRect = (i: number, j: number, r: number): SurfRect => {
    const t = SHARP_TILE / r, o = origin.current;
    return { x0: o.x + i * t, y0: o.y + j * t, x1: o.x + (i + 1) * t, y1: o.y + (j + 1) * t };
  };

  const inRect = (list: Stroke[], v: SurfRect) =>
    list.filter((st) => {
      const b = strokeArea(st);
      return b.maxX >= v.x0 && b.minX <= v.x1 && b.maxY >= v.y0 && b.minY <= v.y1;
    });

  /** Whether any stroke reaches into tile (i, j): a tile without ink gets no canvas at all. */
  const inkCache = useRef<{ list: Stroke[] | null; r: number; has: Map<string, boolean> }>({ list: null, r: 0, has: new Map() });
  const hasInk = (i: number, j: number) => {
    const list = latest.current.strokes, r = scale.current, c = inkCache.current;
    if (c.list !== list || c.r !== r) inkCache.current = { list, r, has: new Map() };
    const key = `${i},${j}`;
    let v = inkCache.current.has.get(key);
    if (v === undefined) {
      const rect = tileRect(i, j, r);
      v = list.some((st) => {
        const b = strokeArea(st);
        return b.maxX >= rect.x0 && b.minX <= rect.x1 && b.maxY >= rect.y0 && b.minY <= rect.y1;
      });
      inkCache.current.has.set(key, v);
    }
    return v;
  };

  /** The previous zoom's tiles, kept on screen (scaled) until the new zoom's visible tiles are painted. */
  const retiring = useRef<Map<string, SharpTile> | null>(null);
  const dropTiles = (map: Map<string, SharpTile>) => {
    for (const t of map.values()) {
      t.canvas.width = t.canvas.height = 0;
      t.canvas.remove();
    }
    map.clear();
  };
  const dropAll = () => {
    dropTiles(tiles.current);
    if (retiring.current) dropTiles(retiring.current);
    retiring.current = null;
  };

  const paintTile = (t: SharpTile, list: Stroke[]) => {
    const r = scale.current;
    const rect = tileRect(t.i, t.j, r);
    const ctx = t.canvas.getContext('2d');
    if (!ctx) return;
    if (t.canvas.width !== SHARP_TILE) {
      t.canvas.width = t.canvas.height = SHARP_TILE;
    } else {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, SHARP_TILE, SHARP_TILE);
    }
    ctx.setTransform(r, 0, 0, r, -rect.x0 * r, -rect.y0 * r);
    drawStrokes(ctx, inRect(list, rect), opts);
    t.painted = list;
    // While the previous zoom's tiles are still shown, new ones wait to be shown together.
    if (!retiring.current) t.canvas.style.visibility = '';
  };

  /** Whether every tile over the visible part is painted with the current strokes. */
  const covered = (visible: SurfRect) => {
    const r = scale.current;
    const g = tileRange(visible, r);
    for (let j = g.j0; j <= g.j1; j++)
      for (let i = g.i0; i <= g.i1; i++) {
        const t = tiles.current.get(`${i},${j}`);
        if (t ? t.painted !== latest.current.strokes : hasInk(i, j)) return false;
      }
    return true;
  };

  /** Paints the tiles the view needs, visible ones first and nearest first, SHARP_FRAME_MS per frame. */
  const paintNeeded = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    if (marginTimer.current !== null) clearTimeout(marginTimer.current);
    frame.current = marginTimer.current = null;
    if (tileWork.paused) {
      tileWork.resume.add(paintNeeded);
      return;
    }
    if (holderRef.current) holderRef.current.style.visibility = '';
    const now = viewNow();
    if (!now) return;
    if (Math.abs(scale.current - now.r) > 1e-3 * now.r) {
      // A new zoom: the old tiles stay on screen, scaled, until this zoom's visible tiles are all
      // painted (in this frame, below), then they go; the page canvases show what they miss.
      hidePages(false);
      if (retiring.current) dropTiles(retiring.current);
      // Only the old tiles on screen are kept (the transition costs little memory).
      const old = new Map<string, SharpTile>();
      for (const [key, tile] of tiles.current) {
        const b = tileRect(tile.i, tile.j, scale.current), vis = now.visible;
        if (b.x1 > vis.x0 && b.x0 < vis.x1 && b.y1 > vis.y0 && b.y0 < vis.y1) {
          old.set(key, tile);
          tiles.current.delete(key);
        }
      }
      dropTiles(tiles.current);
      retiring.current = old;
      tiles.current = new Map();
      scale.current = now.r;
      origin.current = { x: (Math.round(now.corner.x) - now.corner.x) / now.r, y: (Math.round(now.corner.y) - now.corner.y) / now.r };
    }
    const r = scale.current, v = now.visible;
    const mx = (v.x1 - v.x0) * SHARP_MARGIN, my = (v.y1 - v.y0) * SHARP_MARGIN;
    const want = tileRange({ x0: v.x0 - mx, y0: v.y0 - my, x1: v.x1 + mx, y1: v.y1 + my }, r);
    const cx = (v.x0 + v.x1) / 2, cy = (v.y0 + v.y1) / 2, t = SHARP_TILE / r;
    const dist = (i: number, j: number) => Math.hypot((i + 0.5) * t - cx, (j + 0.5) * t - cy);
    // Tiles away from the view go, then the farthest while there are too many (memory stays
    // bounded however far the view travels).
    const drop = (key: string, tile: SharpTile) => {
      tile.canvas.width = tile.canvas.height = 0;
      tile.canvas.remove();
      tiles.current.delete(key);
    };
    for (const [key, tile] of [...tiles.current]) if (tile.i < want.i0 || tile.i > want.i1 || tile.j < want.j0 || tile.j > want.j1) drop(key, tile);
    const byDistance = [...tiles.current].sort((a, b) => dist(b[1].i, b[1].j) - dist(a[1].i, a[1].j));
    while (tiles.current.size > SHARP_MAX_TILES) drop(...byDistance.shift()!);
    const list = latest.current.strokes;
    const seen = tileRange(v, r);
    const todo: { i: number; j: number; d: number; margin: boolean }[] = [];
    for (let j = want.j0; j <= want.j1; j++)
      for (let i = want.i0; i <= want.i1; i++)
        if (tiles.current.get(`${i},${j}`)?.painted !== list && hasInk(i, j)) todo.push({ i, j, d: dist(i, j), margin: i < seen.i0 || i > seen.i1 || j < seen.j0 || j > seen.j1 });
    todo.sort((a, b) => Number(a.margin) - Number(b.margin) || a.d - b.d).splice(SHARP_MAX_TILES);
    const holder = holderRef.current;
    let rested = false;
    const step = () => {
      frame.current = null;
      if (!holder || latest.current.strokes !== list || Math.abs(scale.current - r) > 1e-9) return;
      if (retiring.current && (!todo.length || todo[0].margin)) {
        // This zoom's visible tiles are all painted: shown, and the old ones gone, in one frame.
        dropTiles(retiring.current);
        retiring.current = null;
        for (const t of tiles.current.values()) if (t.painted) t.canvas.style.visibility = '';
      }
      if (!rested && todo[0]?.margin) {
        rested = true;
        marginTimer.current = setTimeout(() => {
          marginTimer.current = null;
          frame.current = requestAnimationFrame(step);
        }, SHARP_MARGIN_DELAY_MS);
        return;
      }
      // The visible tiles first (SHARP_VISIBLE_FRAME_MS a frame), the margin's after a rest.
      const until = performance.now() + (todo[0]?.margin ? SHARP_FRAME_MS : SHARP_VISIBLE_FRAME_MS);
      while (todo.length && (rested || !todo[0].margin) && performance.now() < until) {
        const { i, j } = todo.shift()!;
        const key = `${i},${j}`;
        let tile = tiles.current.get(key);
        if (!tile) {
          const canvas = document.createElement('canvas');
          const rect = tileRect(i, j, r);
          // Placed by a transform, not left / width: layout rounds those to 1/64 px before the zoom
          // scales them, which put the tiles off whole screen pixels again (a seam at each edge).
          Object.assign(canvas.style, {
            position: 'absolute', left: '0', top: '0', width: `${SHARP_TILE}px`, height: `${SHARP_TILE}px`,
            transformOrigin: '0 0', transform: `matrix(${1 / r}, 0, 0, ${1 / r}, ${rect.x0}, ${rect.y0})`, visibility: 'hidden',
          });
          holder.appendChild(canvas);
          tile = { i, j, canvas, painted: null };
          tiles.current.set(key, tile);
        }
        paintTile(tile, list);
      }
      if (retiring.current && (!todo.length || todo[0].margin)) {
        // This zoom's visible tiles are all painted: shown, and the old ones gone, in one frame.
        dropTiles(retiring.current);
        retiring.current = null;
        for (const t of tiles.current.values()) if (t.painted) t.canvas.style.visibility = '';
      }
      const cur = viewNow();
      if (cur && Math.abs(cur.r - r) <= 1e-3 * r) hidePages(!tileWork.paused && covered(cur.visible));
      if (todo.length) frame.current = requestAnimationFrame(step);
    };
    step();
  };

  // Declared before the effects that use containerRef, so it is set when they run.
  useLayoutEffect(() => {
    containerRef.current = holderRef.current?.parentElement ?? null;
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      if (marginTimer.current !== null) clearTimeout(marginTimer.current);
      tileWork.resume.delete(paintNeeded);
      tilesHidden.current = true;
      hidePages(false);
      // WebKit's canvas memory is tight: give the pixels back now.
      dropAll();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The view: after a zoom (and its pinch), and once scrolling rests. A new zoom shows the page
  // canvases at once and is painted on the next frame, once the viewport has put the scroll
  // position right for it.
  useLayoutEffect(() => {
    hidePages(false);
    let first: number | null = requestAnimationFrame(() => {
      first = null;
      paintNeeded();
    });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const later = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(paintNeeded, SHARP_IDLE_MS);
    };
    // Scrolling onto tiles not painted yet: the page canvases show the ink there at once (painting
    // tiles while it scrolls cost frames: they are painted once it rests).
    const scrolled = () => {
      if (tilesHidden.current) {
        const now = viewNow();
        if (!now || Math.abs(now.r - scale.current) > 1e-3 * now.r || !covered(now.visible)) hidePages(false);
      }
      later();
    };
    // While two fingers zoom, only the tiles are on screen as long as they cover the view (the
    // page canvases under them as well were twice the layers to composite on every frame of the
    // pinch); once zooming out or moving shows more than the painted tiles, the page canvases
    // come back under them.
    const pinching = () => {
      if (!tilesHidden.current) return;
      const now = viewNow();
      if (!now || !covered(now.visible)) hidePages(false);
    };
    const target: HTMLElement | Window = scrollRoot ?? window;
    target.addEventListener('scroll', scrolled, { passive: true });
    window.addEventListener('resize', later);
    tileWork.pause.add(pinching);
    tileWork.moved.add(pinching);
    return () => {
      if (first !== null) cancelAnimationFrame(first);
      if (timer) clearTimeout(timer);
      tileWork.resume.delete(paintNeeded);
      tileWork.pause.delete(pinching);
      tileWork.moved.delete(pinching);
      target.removeEventListener('scroll', scrolled);
      window.removeEventListener('resize', later);
    };
  }, [zoom, W, H, scrollRoot]); // eslint-disable-line react-hooks/exhaustive-deps

  // The strokes: like the page canvases, appended strokes are painted on top of the tiles they
  // reach and any other change repaints the tiles of what changed, in the same frame as the edit.
  const prevStrokes = useRef(strokes);
  useLayoutEffect(() => {
    const before = prevStrokes.current;
    prevStrokes.current = strokes;
    if (before === strokes || !tiles.current.size) return;
    const r = scale.current;
    const n = before.length;
    const appended = strokes.length > n && before.every((st, i) => strokes[i] === st) && strokes.slice(n).every((st) => st.tool !== 'highlighter' && (!st.fill || st.fill === 'none'));
    let area: DirtyRect | null = null;
    if (!appended) {
      const was = new Set(before), now = new Set(strokes);
      for (const st of before) if (!now.has(st)) area = unionRect(area, strokePaintBounds(st));
      for (const st of strokes) if (!was.has(st)) area = unionRect(area, strokePaintBounds(st));
    }
    const added = appended ? strokes.slice(n) : [];
    for (const tile of tiles.current.values()) {
      if (tile.painted !== before) continue;
      const rect = tileRect(tile.i, tile.j, r);
      if (appended) {
        const mine = inRect(added, rect);
        if (mine.length) {
          const ctx = tile.canvas.getContext('2d');
          if (ctx) for (const st of mine) drawStroke(ctx, st, opts);
        }
        tile.painted = strokes;
      } else if (!area || (area.maxX >= rect.x0 && area.minX <= rect.x1 && area.maxY >= rect.y0 && area.minY <= rect.y1)) {
        paintTile(tile, strokes);
      } else {
        tile.painted = strokes;
      }
    }
    // Tiles still being painted for the old strokes, or ink where there was none (no tile yet):
    // the tiles the view still needs.
    if (frame.current !== null || marginTimer.current !== null || added.length || area) paintNeeded();
  }, [strokes]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={holderRef} className="absolute left-0 top-0 pointer-events-none" style={{ width: W, height: 0 }} />;
});

/** What a tile's canvas shows: its strokes, at what resolution, and whether as the smooth line. */
type TileShown = { strokes: Stroke[]; ratio: number; smooth: boolean };

const InkTile = React.memo(function InkTile(props: { eager: boolean; top: number; width: number; height: number; strokes: Stroke[]; ratio: number; smooth: boolean; scrollRoot: HTMLElement | null; inkKey: string }) {
  const { eager, top, width: W, height: H, strokes, ratio, smooth, scrollRoot, inkKey } = props;
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
    // A page coming near while two fingers zoom (zooming out) is made once they lift: painting it
    // in the middle of the pinch (a whole page at once) stalled the gesture on slower tablets.
    const wake = () => setAlive(true);
    const near = new IntersectionObserver((en) => {
      if (!en.some((e) => e.isIntersecting)) return;
      if (tileWork.paused) tileWork.resume.add(wake);
      else wake();
    }, { root: scrollRoot, rootMargin: '100% 0px' });
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
      tileWork.resume.delete(wake);
      near.disconnect();
      far.disconnect();
      view.disconnect();
      show.disconnect();
    };
  }, [scrollRoot]);
  /** What the canvas shows now (complete); null when it shows nothing usable. */
  const painted = useRef<TileShown | null>(null);
  const cancelSlices = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelSlices.current?.(), []);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    cancelSlices.current?.();
    cancelSlices.current = null;
    if (!canvas || !alive) {
      painted.current = null;
      return;
    }
    applyShown();
    const w = Math.round(W * ratio), h = Math.round(H * ratio);
    const prev = painted.current;

    // A new resolution or line (the zoom changed): the canvas keeps showing its picture, stretched
    // in place, while the new one is painted off screen a few ms per frame; then it is copied in
    // at once. Repainting the canvas itself left it blank or half painted, or froze the page while
    // every tile on screen was painted in one go.
    if (prev && (prev.ratio !== ratio || prev.smooth !== smooth) && canvas.width > 0) {
      const off = document.createElement('canvas');
      off.width = w;
      off.height = h;
      const octx = off.getContext('2d');
      if (!octx) return;
      octx.setTransform(ratio, 0, 0, ratio, 0, -top * ratio);
      const job = mine;
      cancelSlices.current = paintSliced(octx, job, { smooth }, () => {
        cancelSlices.current = null;
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(off, 0, 0);
        ctx.setTransform(ratio, 0, 0, ratio, 0, -top * ratio);
        painted.current = { strokes: job, ratio, smooth };
        off.width = off.height = 0;
      });
      return;
    }

    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      painted.current = null;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, -top * ratio);
    const opts = { smooth };
    const same = painted.current;
    painted.current = { strokes: mine, ratio, smooth };
    if (same && same.strokes === mine) return;
    // Every edit gives every tile a new list; a tile whose strokes are the same ones in the same
    // order has nothing to paint. (It used to fall through to "same strokes in another order" and
    // repaint completely: each finished stroke repainted every page kept around the view.)
    if (same && same.strokes.length === mine.length && same.strokes.every((s, i) => mine[i] === s)) return;

    if (same) {
      // Appended pen strokes: painted on top.
      const n = same.strokes.length;
      if (mine.length > n && same.strokes.every((s, i) => mine[i] === s) && mine.slice(n).every((s) => s.tool !== 'highlighter' && (!s.fill || s.fill === 'none'))) {
        for (const s of mine.slice(n)) drawStroke(ctx, s, opts);
        return;
      }
      // Anything else: repaint the area of what changed.
      const before = new Set(same.strokes), after = new Set(mine);
      let area: DirtyRect | null = null;
      for (const s of same.strokes) if (!after.has(s)) area = unionRect(area, strokePaintBounds(s));
      for (const s of mine) if (!before.has(s)) area = unionRect(area, strokePaintBounds(s));
      if (!area) {
        // Same strokes in another order: repaint all of them.
        area = { minX: 0, minY: top, maxX: W, maxY: top + H };
      }
      // Whole pixels of this canvas (its own origin is the page's top, not the surface's).
      const px = pixelAligned(ctx, area);
      const x0 = Math.max(0, px.minX), y0 = Math.max(top, px.minY);
      const x1 = Math.min(W, px.maxX), y1 = Math.min(top + H, px.maxY);
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
        drawStrokes(ctx, hit, opts);
        ctx.restore();
        return;
      }
    }

    ctx.clearRect(0, top, W, H);
    // A tile with nothing to show yet: on screen it is painted at once, off screen (scrolling
    // towards it) in slices, taken as painted only at the end.
    if (onScreen.current || mine.length < 40) {
      drawStrokes(ctx, mine, opts);
      return;
    }
    painted.current = null;
    const job = mine;
    cancelSlices.current = paintSliced(ctx, job, { smooth }, () => {
      cancelSlices.current = null;
      painted.current = { strokes: job, ratio, smooth };
    });
  }, [mine, ratio, smooth, alive, top, W, H]);
  return (
    <div ref={holderRef} data-ink-key={inkKey} className="absolute left-0 pointer-events-none" style={{ top, width: W, height: H }}>
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
  /** High zoom: the committed ink is drawn sharp over the view (SharpInk) where page canvases hit their budget. */
  // Above the page canvases' zoom, and also wherever a page canvas would be held below the screen's resolution
  // by its pixel budget (MAX_CANVAS_PIXELS; from about 2x on an iPad, 1.4x on a 3x Android screen):
  // those canvases were drawn soft and then stretched. Printing draws SVG.
  const tileArea = Math.max(1, ...layout.sheets.map((sh) => PAGE_W * sh.height));
  const fitZoom = () => Math.max(1, Math.min(PAGE_CANVAS_MAX_ZOOM, Math.round(((scrollRoot?.clientWidth || window.innerWidth) / PAGE_W) * 4) / 4));
  const [pageZoom, setPageZoom] = useState(fitZoom);
  useEffect(() => {
    const onResize = () => setPageZoom(fitZoom());
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [scrollRoot, PAGE_W]); // eslint-disable-line react-hooks/exhaustive-deps
  const sharp = !printMode && (zoom > pageZoom * 1.02 || canvasRatio(zoom, tileArea) + 1e-6 < (Math.min(window.devicePixelRatio || 1, 3) * Math.ceil(Math.max(1, Math.min(zoom, 5)) * 2)) / 2);
  // The page canvases' zoom: never above the fitting zoom (zooming further in never reallocates them).
  const inkZoom = Math.min(zoom, pageZoom);
  useEffect(() => {
    if (printMode) return;
    crashLog.set('zoom', Math.round(zoom * 100) / 100);
    crashLog.event('zoom', { zoom: Math.round(zoom * 100) / 100, sharp });
  }, [zoom]); // eslint-disable-line react-hooks/exhaustive-deps
  // Their line (smoothAt) as it was before the sharp ink took over: a pinch crossing SMOOTH_ZOOM
  // repainted every page canvas under the sharp ink for nothing.
  const pageSmooth = useRef(smoothAt(inkZoom));
  if (!sharp) pageSmooth.current = smoothAt(inkZoom);
  /** Paper under a stroke ("hole" fills in SVG). */
  const svgPaperOf = (st: Stroke) => PAPER_COLORS[sheetAt(strokeYRange(st).minY + 12).paperColor] ?? '#FFFFFF';
  /** SVG of each ink layer, made again only when the layer's strokes (or the pages) change. */
  const layerSvgs = useMemo(() => new WeakMap<Stroke[], string>(), [layout, printMode]);
  const layerSvg = (strokes: Stroke[]) => {
    let svg = layerSvgs.get(strokes);
    if (svg === undefined) layerSvgs.set(strokes, (svg = strokesSvg(strokes, svgPaperOf)));
    return svg;
  };

  // ------------------------------------------------------------------ live layer
  const dirty = useRef<DirtyRect | null>(null);
  /** Part of the surface the live canvas covers (surface px) and its backing scale. */
  const live = useRef<{ left: number; top: number; width: number; height: number; ratio: number } | null>(null);

  /**
   * The live canvas covers the visible part of the surface plus a margin (not whole page bands,
   * nor the whole width when zoomed in), so it stays small, and it is placed ahead of time, when
   * scrolling stops (see below): a stroke starting after a scroll used to allocate and clear a
   * canvas of up to 16 Mpx on pen-down. When the view moved but the size did not, the canvas is
   * only moved and cleared. Ink drawn on it uses surface coordinates.
   */
  const claimLive = useCallback((): CanvasRenderingContext2D | null => {
    const canvas = activeCanvasRef.current, cont = containerRef.current;
    if (!canvas || !cont) return null;
    const { w: W, h: H } = sizeRef.current;
    const c = cont.getBoundingClientRect();
    const root = scrollRoot?.getBoundingClientRect() ?? { left: 0, right: window.innerWidth, top: 0, bottom: window.innerHeight };
    const scale = c.height / H || 1;
    const v0 = Math.max(0, (root.top - c.top) / scale), v1 = Math.min(H, (root.bottom - c.top) / scale);
    const u0 = Math.max(0, (root.left - c.left) / scale), u1 = Math.min(W, (root.right - c.left) / scale);
    const height = Math.min(H, Math.ceil(Math.max(1, (root.bottom - root.top) / scale) * 1.5));
    const width = Math.min(W, Math.ceil(Math.max(1, (root.right - root.left) / scale) * 1.5));
    // Exactly the screen's resolution (rounding the zoom up, as the page canvases do, cost up to
    // twice the memory for nothing).
    const r = Math.max(1, Math.min(zoomRef.current * Math.min(window.devicePixelRatio || 1, 3), Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, width * height))));
    const cur = live.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    if (
      cur && canvas.width > 0 && cur.top <= v0 && cur.top + cur.height >= v1 && cur.left <= u0 && cur.left + cur.width >= u1 &&
      cur.height === height && cur.width === width && Math.abs(cur.ratio - r) < 1e-6 && canvas.width === Math.round(width * r)
    ) return ctx;
    const top = Math.max(0, Math.min(H - height, (v0 + v1) / 2 - height / 2));
    const left = Math.max(0, Math.min(W - width, (u0 + u1) / 2 - width / 2));
    const w = Math.round(width * r), h = Math.round(height * r);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    canvas.style.top = `${top}px`;
    canvas.style.left = `${left}px`;
    ctx.setTransform(r, 0, 0, r, -left * r, -top * r);
    ctx.clearRect(left, top, width, height);
    live.current = { left, top, width, height, ratio: r };
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
      // In the apps pen strokes are drawn by the shell: no live canvas is held for them.
      if (!drawing.current && !handleDrag.current && !NativeInk.available) claimLive();
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
      while (i < order.length && performance.now() < until) prepareStroke(order[i++]);
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
    model: SmoothLiveStroke | null;
    /** Pen tool: fills wide gaps between samples (fast strokes, slow digitisers) before the engine. */
    dense: SampleDensifier | null;
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
    if (prev) {
      const c = pixelAligned(ctx, { minX: prev.minX - 3, minY: prev.minY - 3, maxX: prev.maxX + 3, maxY: prev.maxY + 3 });
      ctx.clearRect(c.minX, c.minY, c.maxX - c.minX, c.maxY - c.minY);
    }
    let next: DirtyRect | null = null;
    const d = drawing.current;
    const k = 1 / Math.max(0.3, zoomRef.current);
    const edit = handleDrag.current;
    if (edit) {
      next = unionRect(next, drawLiveStroke(ctx, edit.last.points, styleOf(edit.last)));
      if (edit.snapDot) next = unionRect(next, drawSnapDot(ctx, edit.snapDot, false, k));
    }
    // In the apps the shell's native layer draws the stroke or shape being made (d.ink, above the
    // web view, as vectors at the screen's resolution): it is not drawn here as well. Two copies of
    // the same line from two rasterisers, a fraction of a pixel and a frame apart, made the ink
    // look blurry while the pen was down (and cost the page a canvas repaint every frame).
    if (d && d.smart) {
      next = d.ink ? null : paintSmart(ctx, d, k);
      const m = smartPenMeasure(d.smart);
      if (m) next = unionRect(next, drawMeasure(ctx, m.text, m.at, k, sizeRef.current.w));
    } else if (d && d.model && !d.snapped) {
      if (d.rec) d.recFrames.push(Math.round((performance.now() - d.start) * 10) / 10);
      const style = liveStyle('pen');
      if (!d.ink) d.model.paint(ctx, { color: style.color, width: strokeWidth({ ...style, isShape: false }), variable: isVariableWidth(style) && d.realPressure });
    } else if (d && (d.tool === 'pen' || d.tool === 'highlighter')) {
      if (d.snapped) {
        next = d.ink ? null : paintSnapped(ctx, d);
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
    // In the apps the shell draws pen strokes (NativeInk): the live canvas is not needed for them
    // (the Draw tool still shows its measurements there).
    if (!(tool === 'pen' && NativeInk.available)) claimLive();
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
      model: tool === 'pen' ? new SmoothLiveStroke() : null,
      dense: tool === 'pen' ? new SampleDensifier() : null,
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
    drawing.current.dense?.push(pt);
    syncInk(drawing.current);
    gestures.inking = true;
    gestures.inkingWith = e.pointerType;
    // The shells send every stylus sample (iOS: the Pencil's 240 Hz; Android: each touch event's
    // history, OpenNoteInkPlugin.forwardStylus); the page's own events are the fallback.
    const nativeSamples = nativePencil.available || window.OpenNoteNative?.platform === 'ios' || !!(window as { OpenNoteInk?: unknown }).OpenNoteInk;
    if (e.pointerType === 'pen' && nativeSamples) {
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
      events.splice(0, events.length, ...webAfterNative(d));
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
      // Pen: the densifier decides about samples where the pen rests (some must reach the engine,
      // src/ink/densify.ts); other tools skip them.
      const dense = d.model && d.dense && !d.snapped ? d.dense : null;
      const last = d.points[d.points.length - 1];
      if (!dense && Math.abs(pt.x - last.x) < 0.2 && Math.abs(pt.y - last.y) < 0.2) continue;
      // A pen sample without force is the Pencil leaving the glass: it must not read as 0.5.
      const lifting = ce.pointerType === 'pen' && !(ce.pressure > 0);
      // Light smoothing of the Pencil's force signal: raw values jitter and made the fountain-pen
      // outline wobble.
      // pen: the raw force (the engine smooths it with no lag; 0 = lifting, force unknown);
      // highlighter / shapes: light smoothing, raw values jitter.
      if (d.model) pt.pressure = lifting ? 0 : pt.pressure;
      else {
        if (!lifting) d.pressure = d.pressure * 0.55 + pt.pressure * 0.45;
        pt.pressure = d.pressure;
      }
      if (ce.pointerType === 'pen' && ce.pressure > 0 && ce.pressure !== 0.5) d.realPressure = true;
      // Pen: wide gaps between samples are filled with points on a smooth curve (src/ink/densify.ts);
      // the stroke keeps them, so the finished stroke is the line drawn live.
      for (const q of dense ? dense.push(pt) : [pt]) {
        d.force.push(lifting ? 0 : q.pressure);
        d.points.push(q);
        if (d.model && !d.snapped) d.model.add(q.x, q.y, q.t ?? 0, q.pressure);
      }
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
    d.ink.update(
      d.model,
      { color: style.color, width: strokeWidth({ ...style, isShape: false }), variable: isVariableWidth(style) && d.realPressure },
      d.inkTf
    );
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
      d.model = new SmoothLiveStroke();
      d.model.add(pt.x, pt.y, pt.t ?? 0, pt.pressure);
      d.dense = new SampleDensifier();
      d.dense.push(pt);
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

  /**
   * The web events held back that come after the stroke's last (native) sample. Matched by
   * position: the shell's sample times and the web events' are different clocks, and by time alone
   * events the shell had already delivered were added again, so the line went back over itself.
   * Without a web event near the last sample (the pen moved on far), by time.
   */
  function webAfterNative(d: NonNullable<typeof drawing.current>): PointerEvent[] {
    const buf = d.webBuffer;
    d.webBuffer = [];
    const last = d.points[d.points.length - 1];
    let near = -1, best = 4;
    buf.forEach((w, i) => {
      const at = toPoint(w, d.start);
      const dist = Math.hypot(at.x - last.x, at.y - last.y);
      if (dist <= best) {
        best = dist;
        near = i;
      }
    });
    if (near >= 0) return buf.slice(near + 1);
    const lastT = last.t ?? 0;
    return buf.filter((w) => eventTime(w) - d.start > lastT);
  }

  /** The shell's samples stopped: the web events held back since its last delivery continue the stroke. */
  function ingestWebAfterNative(d: NonNullable<typeof drawing.current>) {
    if (d.native) nativePencil.detach(d.native);
    d.native = null;
    const rest = webAfterNative(d);
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
    // In the apps the live canvas served only this gesture (lasso, highlighter, eraser): its
    // memory goes back once the frame showing the result is drawn.
    if (NativeInk.available) requestAnimationFrame(() => requestAnimationFrame(() => {
      const c = activeCanvasRef.current;
      if (c && !drawing.current && !handleDrag.current) {
        c.width = c.height = 0;
        live.current = null;
        dirty.current = null;
      }
    }));
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
  const glowCanvasRef = useRef<HTMLCanvasElement>(null);
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
    crashLog.event('drag-start', { mode, strokes: selection.strokeIds.length, latex: selection.latexIds.length, zoom });
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
    crashLog.event('drag-end', { mode: t.mode, f: Math.round(t.f * 100) / 100, cancelled });
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

  // Selection layers (Notability style blue glow). Idle: only the glow, on a canvas under the
  // page ink, so the selected strokes themselves are always the page's sharp ink (a glow looks the
  // same at any resolution; ink drawn again on top at this canvas's capped resolution was blurry
  // after enlarging a selection or zooming in). While dragging, a canvas over the page carries the
  // ink (hidden on the page canvas) and moves as a CSS transform, so picking a selection up costs
  // nothing extra; on release the page draws the moved ink again at full resolution.
  const FLOAT_PAD = 24;
  const layerSel = drag?.sel ?? null;
  const glowSel = !drag && selection && !printMode && !hiddenIds && selection.strokeIds.length ? selection : null;
  /**
   * glowOnly: the idle glow (any resolution will do). Otherwise the dragged ink, at the screen's
   * resolution for this zoom and `k`, the scale the drag has reached (the canvas is CSS-scaled by
   * it): a bitmap at the page canvases' resolution, stretched while resizing, looked blurry until
   * the drag ended.
   */
  const paintSelection = (c: HTMLCanvasElement | null, sel: Selection, glowOnly: boolean, k = 1) => {
    if (!c) return;
    const b = sel.bounds;
    const w = b.width + FLOAT_PAD * 2, h = b.height + FLOAT_PAD * 2;
    const screen = zoom * Math.min(window.devicePixelRatio || 1, 3) * k;
    const r = Math.min(glowOnly ? ratio : screen, Math.sqrt(MAX_CANVAS_PIXELS / (glowOnly ? 4 : 2) / Math.max(1, w * h)));
    c.width = Math.max(1, Math.round(w * r));
    c.height = Math.max(1, Math.round(h * r));
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(r, 0, 0, r, -(b.x - FLOAT_PAD) * r, -(b.y - FLOAT_PAD) * r);
    const ids = new Set(sel.strokeIds);
    // Idle: highlighters stay on the page only (drawing them twice would darken them).
    const strokes = pageRef.current.strokes.filter((s) => ids.has(s.id) && (!glowOnly || s.tool !== 'highlighter'));
    ctx.save();
    ctx.shadowColor = 'rgba(37, 99, 235, 0.9)';
    ctx.shadowBlur = 7 * r;
    // Glow only: the strokes themselves in the glow's colour (the page's ink covers them, and
    // where this lower-resolution copy shows at their edge it is just more glow).
    drawStrokes(ctx, strokes, glowOnly ? { color: 'rgba(37, 99, 235, 0.9)' } : {});
    ctx.restore();
    if (!glowOnly) drawStrokes(ctx, strokes);
  };
  // Resizing: drawn again from the vectors each time the scale has moved by 8%, so it stays sharp.
  const dragScale = drag && drag.f !== 1 ? Math.pow(1.08, Math.round(Math.log(drag.f) / Math.log(1.08))) : 1;
  useLayoutEffect(() => {
    if (layerSel) paintSelection(floatCanvasRef.current, layerSel, false, dragScale);
  }, [layerSel, ratio, zoom, dragScale, page.strokes]);

  // Blocks of the selection follow the drag without touching the document.
  const blockPage = useMemo(
    () => (drag && drag.sel.latexIds.length + drag.sel.textIds.length + drag.sel.imageIds.length ? transformSelection({ ...page, strokes: [] }, drag.sel, drag.dx, drag.dy, drag.f, drag.rot) : page),
    [drag, page]
  );
  /** The content in stacking order (editor/zorder.ts); unchanged ink layers keep their arrays. */
  const layersRef = useRef<ZLayer[] | undefined>(undefined);
  const layers = useMemo(() => (layersRef.current = zLayers({ ...blockPage, strokes: shownStrokes }, layersRef.current)), [blockPage, shownStrokes]);
  /** The ink layer the idle selection glow goes under: the lowest one with selected strokes. */
  const glowLayerKey = useMemo(() => {
    if (!glowSel) return null;
    const ids = new Set(glowSel.strokeIds);
    return layers.find((l) => l.kind === 'ink' && l.strokes.some((st) => ids.has(st.id)))?.key ?? null;
  }, [glowSel, layers]);
  useLayoutEffect(() => {
    if (glowSel && glowLayerKey) paintSelection(glowCanvasRef.current, glowSel, true);
  }, [glowSel, glowLayerKey, ratio, page.strokes]);

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
          if (!printMode) {
            // Canvases always (at the last zoom below sharp ink, kept while zoomed further in), with
            // the sharp ink over the view past it.
            return (
              <React.Fragment key={l.key}>
                {glowSel && l.key === glowLayerKey && (
                  <canvas
                    ref={glowCanvasRef}
                    className="absolute pointer-events-none"
                    style={{ left: glowSel.bounds.x - FLOAT_PAD, top: glowSel.bounds.y - FLOAT_PAD, width: glowSel.bounds.width + FLOAT_PAD * 2, height: glowSel.bounds.height + FLOAT_PAD * 2 }}
                  />
                )}
                {layout.sheets.map((sh) => (
                  <InkTile
                    key={sh.id}
                    inkKey={`${l.key}:${sh.id}`}
                    eager={sh.index < 2}
                    top={sh.top}
                    width={PAGE_W}
                    height={sh.height}
                    strokes={l.strokes}
                    ratio={canvasRatio(inkZoom, PAGE_W * sh.height)}
                    smooth={pageSmooth.current}
                    scrollRoot={scrollRoot}
                  />
                ))}
                {sharp && <SharpInk key={`s${l.key}`} layerKey={l.key} strokes={l.strokes} sheets={layout.sheets} width={PAGE_W} height={PAGE_H} zoom={zoom} scrollRoot={scrollRoot} />}
              </React.Fragment>
            );
          }
          return printMode ? (
            <svg
              key={l.key}
              className="absolute inset-0 pointer-events-none"
              width={PAGE_W}
              height={PAGE_H}
              viewBox={`0 0 ${PAGE_W} ${PAGE_H}`}
              dangerouslySetInnerHTML={{ __html: layerSvg(l.strokes) }}
            />
          ) : null;
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
              // Not while it is being dragged: what is shown then is a moved / scaled copy, and
              // writing its measured size into the block made the next copy scale it again (an
              // endless update loop that took the editor down: a black screen while resizing).
              measure={!printMode && !drag?.sel.latexIds.includes(b.id)}
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
            onResize={(patch, phase) => {
              if (phase === 'start') editor.beginGesture();
              else if (phase === 'end') editor.endGesture();
              else editor.previewPage(page.id, (p) => ({ ...p, textBlocks: (p.textBlocks ?? []).map((x) => (x.id === t.id ? { ...x, ...patch } : x)) }));
            }}
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
      {!printMode && <canvas ref={activeCanvasRef} className="absolute z-10 pointer-events-none" style={{ left: 0, top: 0, width: PAGE_W, height: 0 }} />}
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
