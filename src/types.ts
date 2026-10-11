export type ToolType = 'pen' | 'highlighter' | 'eraser' | 'lasso' | 'text' | 'hand';

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
}

export type ShapeKind = 'line' | 'arrow' | 'polyline' | 'triangle' | 'rectangle' | 'polygon' | 'ellipse' | 'circle';

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
  createdAt: number;
}

export interface ImageBlock {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  dataUrl: string;
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
export const SCHEMA_VERSION = 2;

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
