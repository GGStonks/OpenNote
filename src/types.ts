export type ToolType = 'pen' | 'highlighter' | 'eraser' | 'lasso' | 'text' | 'hand';

export type PaperStyle = 'blank' | 'ruled' | 'grid' | 'dots';

export type PaperColor = 'white' | 'cream' | 'dark' | 'yellow';

export interface Point {
  x: number;
  y: number;
  pressure: number;
}

export interface Stroke {
  id: string;
  tool: 'pen' | 'highlighter';
  color: string;
  width: number;
  opacity: number;
  points: Point[];
  lineStyle?: 'solid' | 'dashed' | 'dotted';
}

export interface LatexBlock {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scale?: number;
  latexCode: string;
  renderedHtml?: string;
  isTikz?: boolean;
  createdAt: number;
}

export interface NotePage {
  id: string;
  pageNumber: number;
  strokes: Stroke[];
  latexBlocks: LatexBlock[];
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
}

export interface Subject {
  id: string;
  name: string;
  color: string;
}
