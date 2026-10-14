export type ToolType = 'pen' | 'shape' | 'highlighter' | 'eraser' | 'lasso' | 'text' | 'hand';

/** What the smart pen (PDEDraw's drawing engine) produces. */
export type ShapeMode = 'curve' | 'line' | 'rectangle' | 'ellipse' | 'point';

/** Fill of closed shapes, as in PDEDraw (TikZ: fill / patterns / white hole). */
export type FillType = 'none' | 'solid' | 'northEast' | 'northWest' | 'crosshatch' | 'hole';

export type PenStyle = 'fountain' | 'ballpoint';

export type EraserMode = 'stroke' | 'partial';

export type PaperStyle = 'blank' | 'ruled' | 'narrow' | 'grid' | 'graph' | 'dots';

export type PaperColor = 'white' | 'cream' | 'yellow' | 'ochre' | 'blue' | 'green' | 'pink' | 'gray' | 'dark';

/** Sheet formats (see editor/pageSetup.ts for their sizes). */
export type PageSize = 'letter' | 'legal' | 'a3' | 'a4' | 'a5' | 'b5';

export type PageOrientation = 'portrait' | 'landscape';

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

/**
 * One page of a note: a piece of the note's continuous surface, with its own paper. Missing
 * fields: the note's default (NoteDocument), so changing the note's paper changes every page
 * that was not customised.
 */
export interface PageSheet {
  id: string;
  paperStyle?: PaperStyle;
  paperColor?: PaperColor;
  size?: PageSize;
  orientation?: PageOrientation;
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
  /** Default paper of the pages (the template of new pages); pages may override it. */
  paperStyle: PaperStyle;
  paperColor: PaperColor;
  /** Default sheet format and orientation (missing: US Letter, portrait). */
  pageSize?: PageSize;
  orientation?: PageOrientation;
  /** The note's content: one continuous surface (pages[0]), in surface px. */
  pages: NotePage[];
  /** The pages the surface is cut into, top to bottom (see editor/sheets.ts). */
  sheets: PageSheet[];
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

/** US Letter at 96 px per inch: the default page (and the page of notes made before v1.12). */
export const PAGE_WIDTH = 816;
export const PAGE_HEIGHT = 1056;
/**
 * 5: one continuous surface (pages[0]) cut into pages of any size and paper (sheets).
 * 4 (v1.12 development): separate pages, each with its own paper. 3 (v1.6-v1.11): one surface
 * cut into US Letter pages. Older notes: separate US Letter pages.
 */
export const SCHEMA_VERSION = 5;

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
