export type ToolType = 'pen' | 'shape' | 'highlighter' | 'eraser' | 'lasso' | 'text' | 'hand';

/** What the smart pen (PDEDraw's drawing engine) produces. */
export type ShapeMode = 'curve' | 'line' | 'rectangle' | 'ellipse' | 'point';

/** Fill of closed shapes, as in PDEDraw (TikZ: fill / patterns / white hole). */
export type FillType = 'none' | 'solid' | 'northEast' | 'northWest' | 'crosshatch' | 'hole';

export type PenStyle = 'fountain' | 'ballpoint';

export type EraserMode = 'stroke' | 'partial';

export type PaperStyle = 'blank' | 'ruled' | 'grid' | 'dots';

export type PaperColor = 'white' | 'cream' | 'dark' | 'yellow';

/**
 * One ink sample. Mirrors what Notability's InkObjectEncoder stores per point
 * (position, force, altitude angle, azimuth) plus a timestamp.
 */
export interface Point {
  x: number;
  y: number;
  /** Normalised force 0..1 (0.5 when the input device reports none). */
  pressure: number;
  /** Milliseconds since the stroke started. */
  t?: number;
  /** Stylus altitude in radians (PI/2 = perpendicular to the screen). */
  alt?: number;
  /** Stylus azimuth in radians. */
  az?: number;
}

export type LineStyle = 'solid' | 'dashed' | 'dotted';

export interface Stroke {
  id: string;
  tool: 'pen' | 'highlighter';
  color: string;
  width: number;
  opacity: number;
  points: Point[];
  lineStyle?: LineStyle;
  /** fountain = pressure sensitive, ballpoint = uniform width. Missing on v1.0 notes (treated as fountain). */
  penStyle?: PenStyle;
  /** True when the points were produced by shape snapping (render with straight joins, no smoothing). */
  isShape?: boolean;
  /** Closed shapes (rectangle, ellipse, polygon) are rendered as closed paths. */
  closed?: boolean;
  shapeKind?: ShapeKind;
  /** Fill of a closed stroke (even-odd rule). */
  fill?: FillType;
  /** Arrowhead at the end of an open stroke. */
  arrow?: boolean;
  /**
   * Handwriting whose points are already the ink engine's modelled centre line (pressure = the
   * modelled pressure), drawn as they are: the pieces left by the precision eraser. 'variable':
   * fountain-pen width from the pressure; 'uniform': constant width. Missing: raw pen samples.
   */
  modeled?: 'variable' | 'uniform';
  /** Degrees this item has been rotated from how it was made (0 = original orientation). */
  rotation?: number;
}

/**
 * 'curve': points are the control points of a centripetal Catmull-Rom spline (PDEDraw smooth curve),
 * open or closed. 'point': a single filled dot.
 */
export type ShapeKind = 'line' | 'arrow' | 'polyline' | 'triangle' | 'rectangle' | 'polygon' | 'ellipse' | 'circle' | 'curve' | 'point';

export interface LatexBlock {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scale?: number;
  latexCode: string;
  /** Deprecated (v1.0): rendering is always derived from latexCode. */
  renderedHtml?: string;
  isTikz?: boolean;
  /** Cached SVG produced by the TikZ engine for exactly this latexCode. */
  tikzSvg?: string;
  tikzSvgSource?: string;
  color?: string;
  /** Degrees, clockwise about the block's centre (see Stroke.rotation). */
  rotation?: number;
  createdAt: number;
}

export interface TextBlock {
  id: string;
  x: number;
  y: number;
  width: number;
  text: string;
  fontSize: number;
  color: string;
  /** Degrees, clockwise about the block's centre. */
  rotation?: number;
  createdAt: number;
}

export interface ImageBlock {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  dataUrl: string;
  /** Degrees, clockwise about the block's centre. */
  rotation?: number;
  createdAt: number;
}

export interface NotePage {
  id: string;
  pageNumber: number;
  strokes: Stroke[];
  latexBlocks: LatexBlock[];
  textBlocks?: TextBlock[];
  imageBlocks?: ImageBlock[];
}

export interface AudioRecording {
  id: string;
  noteId: string;
  createdAt: number;
  durationMs: number;
  mimeType: string;
}

export interface NoteDocument {
  id: string;
  title: string;
  subjectId?: string;
  createdAt: number;
  updatedAt: number;
  paperStyle: PaperStyle;
  paperColor: PaperColor;
  pages: NotePage[];
  schemaVersion?: number;
}

export interface Subject {
  id: string;
  name: string;
  color: string;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const PAGE_WIDTH = 816;
export const PAGE_HEIGHT = 1056;
/** 3: a note is one continuous surface (a single NotePage); older notes are merged on load. */
export const SCHEMA_VERSION = 3;

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
