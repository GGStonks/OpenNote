import { SampleDensifier } from '../../src/ink/densify';
import { inkGeometry, strokeHitTest, strokeWidth } from '../../src/ink/strokeRenderer';
import { adjustSnappedShape, SnapAdjust } from '../../src/editor/shapeEdit';
import { detectShape } from '../../src/services/shapeRecognition';
import { selectInLasso } from '../../src/editor/selection';
import type { NotePage, Point, Stroke } from '../../src/types';
import { listRecordingFiles, loadRecording, n, pt4, xy } from './common';
import { synthShapes } from './synthShapes';

export const PEN_HOLD_MS = 1000;
export const SHAPE_HOLD_MS = 450;
export const STANDSTILL_DIST = 3.0;

export interface SmartPenOptions {
  tool?: string;
  width?: number;
  color?: string;
  penStyle?: 'fountain' | 'ballpoint';
  lineStyle?: 'solid' | 'dashed' | 'longdash' | 'dotted' | 'dashdot';
  eraserSize?: number;
  holdThresholdMs?: number;
  page?: NotePage;
}

export function calcSnapWidth(points: Point[], width = 2, penStyle: 'fountain' | 'ballpoint' = 'fountain'): number {
  const style: any = { tool: 'pen', width, penStyle, lineStyle: 'solid' };
  const g = inkGeometry(points, style);
  const ws = g.widths ? [...g.widths].sort((a, b) => a - b) : [];
  const drawn = ws.length ? ws[ws.length >> 1] : g.width;
  return (drawn / strokeWidth({ ...style, isShape: true })) * style.width;
}

export function eraseAlongSnapped(points: { x: number; y: number }[], closed: boolean, eraserSize: number): { x: number; y: number }[] {
  const pts = closed ? [...points, points[0]] : points;
  const step = Math.max(1, eraserSize * 0.5);
  const at = [{ x: pts[0].x, y: pts[0].y }];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const m = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let k = 1; k <= m; k++) at.push({ x: a.x + ((b.x - a.x) * k) / m, y: a.y + ((b.y - a.y) * k) / m });
  }
  return at;
}

export class SmartPenStateMachine {
  tool: string;
  width: number;
  color: string;
  penStyle: 'fountain' | 'ballpoint';
  lineStyle: 'solid' | 'dashed' | 'longdash' | 'dotted' | 'dashdot';
  eraserSize: number;
  holdThresholdMs: number;
  page?: NotePage;

  points: Point[] = [];
  samples: { x: number; y: number; t: number; pressure: number }[] = [];
  drawnSamples: { x: number; y: number }[] = [];
  densifier = new SampleDensifier();

  lastMove: { x: number; y: number } | null = null;
  lastMoveT: number = 0;

  snapped = false;
  snappedSample: number | null = null;
  snappedStroke: any = null;
  adjust: SnapAdjust | null = null;

  erased: string[] = [];
  putBack: string[] = [];
  selectedIds: string[] = [];

  constructor(opts: SmartPenOptions = {}) {
    this.tool = opts.tool ?? 'pen';
    this.width = opts.width ?? 2;
    this.color = opts.color ?? '#000';
    this.penStyle = opts.penStyle ?? 'fountain';
    this.lineStyle = opts.lineStyle ?? 'solid';
    this.eraserSize = opts.eraserSize ?? 16;
    this.holdThresholdMs = opts.holdThresholdMs ?? (this.tool === 'shape' || this.tool === 'curve' ? SHAPE_HOLD_MS : PEN_HOLD_MS);
    this.page = opts.page;
  }

  addSample(x: number, y: number, t: number, pressure: number): boolean {
    const sampleIdx = this.samples.length;
    this.samples.push({ x, y, t, pressure });

    // 1. Densify points
    if (!this.snapped) {
      this.drawnSamples.push({ x, y });
      const qPts = this.densifier.push({ x, y, t, pressure: pressure > 0 ? pressure : 0 });
      for (const q of qPts) {
        this.points.push(q);
      }
    }

    // 2. First sample setup
    if (this.lastMove === null) {
      this.lastMove = { x, y };
      this.lastMoveT = t;
      return false;
    }

    // 3. Movement check
    const dist = Math.hypot(x - this.lastMove.x, y - this.lastMove.y);
    if (dist > STANDSTILL_DIST) {
      this.lastMove = { x, y };
      this.lastMoveT = t;
      if (this.snapped && this.adjust) {
        this.snappedStroke.points = adjustSnappedShape(this.adjust, { x, y }).map(xy);
      }
      return false;
    }

    // 4. Standstill check (hold to snap)
    if (!this.snapped) {
      if (t - this.lastMoveT >= this.holdThresholdMs) {
        if (this.points.length >= 6) {
          const shape = detectShape(this.points);
          if (shape) {
            this.snapped = true;
            this.snappedSample = sampleIdx;
            const strokeW = this.tool === 'pen' ? calcSnapWidth(this.points, this.width, this.penStyle) : this.width;
            this.snappedStroke = {
              kind: shape.kind,
              closed: shape.closed,
              width: n(strokeW),
              points: shape.points.map(xy),
              regular: shape.regular,
            };
            this.adjust = {
              kind: shape.kind,
              base: shape.points,
              closed: shape.closed,
              pen0: { x, y },
              regular: shape.regular,
            };

            if (this.tool === 'eraser' && this.page) {
              const putBackSet = new Set<string>();
              for (const s of this.page.strokes) {
                for (const smp of this.drawnSamples) {
                  if (strokeHitTest(s, smp.x, smp.y, this.eraserSize)) {
                    putBackSet.add(s.id);
                    break;
                  }
                }
              }
              this.putBack = Array.from(putBackSet).sort();

              const snapPts = eraseAlongSnapped(shape.points, shape.closed, this.eraserSize);
              const erasedSet = new Set<string>();
              for (const s of this.page.strokes) {
                for (const q of snapPts) {
                  if (strokeHitTest(s, q.x, q.y, this.eraserSize)) {
                    erasedSet.add(s.id);
                    break;
                  }
                }
              }
              this.erased = Array.from(erasedSet).sort();
            }

            if (this.tool === 'lasso' && this.page) {
              const sel = selectInLasso(this.page, shape.points);
              this.selectedIds = sel && sel.strokeIds ? [...sel.strokeIds].sort() : [];
            }

            return true;
          }
        }
      }
    }

    return false;
  }

  feedRest(durationMs: number, stepMs = 20) {
    if (this.samples.length === 0) return;
    const last = this.samples[this.samples.length - 1];
    const nSteps = Math.floor(durationMs / stepMs);
    for (let i = 1; i <= nSteps; i++) {
      this.addSample(last.x, last.y, last.t + i * stepMs, last.pressure);
    }
  }
}

export interface SmartPenRunOpts {
  per?: number;
  all?: boolean;
  files?: string[];
  [key: string]: unknown;
}

export function run(opts?: SmartPenRunOpts): unknown {
  const files = listRecordingFiles(opts?.files);
  const strokes: unknown[] = [];

  // Build all page strokes from all recordings
  const allPageStrokes: Stroke[] = [];

  for (const file of files) {
    const rec = loadRecording(file);
    const fileName = file.split('/').pop()!;
    rec.strokes.forEach((s, i) => {
      if (s.tool !== 'pen' || s.samples.length < 3) return;
      const dens = new SampleDensifier();
      const rawPoints: Point[] = [];
      const real = s.samples.some((q) => q[3] > 0 && q[3] !== 0.5);
      s.samples.forEach(([x, y, t, force]) => {
        for (const q of dens.push({ x, y, t, pressure: force > 0 ? force : 0 })) {
          rawPoints.push(q);
        }
      });
      if (rawPoints.length < 3) return;
      const lead = real ? [...s.samples].reverse().find((q) => q[3] > 0.02) : undefined;
      const unquantized = lead
        ? [...rawPoints, { x: lead[0], y: lead[1], t: lead[2], pressure: lead[3] }]
        : rawPoints;
      const points = unquantized.map((p) => {
        const [x, y, t, pressure] = pt4(p);
        return { x, y, t, pressure };
      });
      allPageStrokes.push({
        id: `${fileName}#${i}`,
        createdAt: 0,
        tool: 'pen',
        color: '#000000',
        width: n(s.width || 2),
        opacity: 1,
        penStyle: 'fountain',
        lineStyle: 'solid',
        points,
        ...(lead ? { penEnd: true } : {}),
      });
    });
  }

  for (const file of files) {
    const rec = loadRecording(file);
    const fileName = file.split('/').pop()!;
    const otherStrokes = allPageStrokes.filter((s) => !s.id.startsWith(fileName + '#'));
    const page: NotePage = {
      id: `page_${fileName}`,
      pageNumber: 1,
      strokes: otherStrokes,
      latexBlocks: [],
      textBlocks: [],
      imageBlocks: [],
    };

    const pens = rec.strokes
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => s.tool === 'pen' && s.samples.length > 2);

    const selection =
      opts?.per && opts.per !== 6 && !opts?.all
        ? pens.filter((_, k) => k % Math.max(1, Math.floor(pens.length / opts.per!)) === 0).slice(0, opts.per)
        : pens;

    for (const { s, i } of selection) {
      const rawSamples = s.samples.map(([x, y, t, force]) => [n(x), n(y), n(t), n(force > 0 ? force : 0)]);
      if (rawSamples.length < 3) continue;

      // Replay with 0.3s rest (300 ms) - must NOT snap
      const pen30 = new SmartPenStateMachine({ tool: 'pen', width: s.width });
      for (const [x, y, t, force] of rawSamples) {
        pen30.addSample(x, y, t, force);
      }
      pen30.feedRest(300, 20);
      if (pen30.snapped) continue; // Skip strokes that paused mid-writing

      const baseId = `${fileName}#${i}`;

      // 1. Tool: pen (original)
      const pen11 = new SmartPenStateMachine({ tool: 'pen', width: s.width });
      for (const [x, y, t, force] of rawSamples) {
        pen11.addSample(x, y, t, force);
      }
      pen11.feedRest(1100, 20);

      strokes.push({
        id: baseId,
        tool: 'pen',
        width: n(s.width),
        samples: rawSamples,
        rest1100: {
          snapped: pen11.snapped,
          sample: pen11.snappedSample,
          stroke: pen11.snappedStroke,
        },
        rest300: {
          snapped: pen30.snapped,
          sample: pen30.snappedSample,
          stroke: pen30.snappedStroke,
        },
      });

      // 2. Tool: highlighter
      const hl11 = new SmartPenStateMachine({ tool: 'highlighter', width: s.width });
      for (const [x, y, t, force] of rawSamples) {
        hl11.addSample(x, y, t, force);
      }
      hl11.feedRest(1100, 20);

      const hl30 = new SmartPenStateMachine({ tool: 'highlighter', width: s.width });
      for (const [x, y, t, force] of rawSamples) {
        hl30.addSample(x, y, t, force);
      }
      hl30.feedRest(300, 20);

      strokes.push({
        id: `${baseId}-highlighter`,
        tool: 'highlighter',
        width: n(s.width),
        samples: rawSamples,
        rest1100: {
          snapped: hl11.snapped,
          sample: hl11.snappedSample,
          stroke: hl11.snappedStroke,
        },
        rest300: {
          snapped: hl30.snapped,
          sample: hl30.snappedSample,
          stroke: hl30.snappedStroke,
        },
      });

      // 3. Tool: eraser
      const eraser11 = new SmartPenStateMachine({ tool: 'eraser', width: s.width, page });
      for (const [x, y, t, force] of rawSamples) {
        eraser11.addSample(x, y, t, force);
      }
      eraser11.feedRest(1100, 20);

      const eraser30 = new SmartPenStateMachine({ tool: 'eraser', width: s.width, page });
      for (const [x, y, t, force] of rawSamples) {
        eraser30.addSample(x, y, t, force);
      }
      eraser30.feedRest(300, 20);

      strokes.push({
        id: `${baseId}-eraser`,
        tool: 'eraser',
        width: n(s.width),
        samples: rawSamples,
        rest1100: {
          snapped: eraser11.snapped,
          sample: eraser11.snappedSample,
          stroke: eraser11.snappedStroke,
          erased: eraser11.erased,
          putBack: eraser11.putBack,
        },
        rest300: {
          snapped: eraser30.snapped,
          sample: eraser30.snappedSample,
          stroke: eraser30.snappedStroke,
          erased: [],
          putBack: [],
        },
      });

      // 4. Tool: lasso
      const lasso11 = new SmartPenStateMachine({ tool: 'lasso', width: s.width, page });
      for (const [x, y, t, force] of rawSamples) {
        lasso11.addSample(x, y, t, force);
      }
      lasso11.feedRest(1100, 20);

      const lasso30 = new SmartPenStateMachine({ tool: 'lasso', width: s.width, page });
      for (const [x, y, t, force] of rawSamples) {
        lasso30.addSample(x, y, t, force);
      }
      lasso30.feedRest(300, 20);

      strokes.push({
        id: `${baseId}-lasso`,
        tool: 'lasso',
        width: n(s.width),
        samples: rawSamples,
        rest1100: {
          snapped: lasso11.snapped,
          sample: lasso11.snappedSample,
          stroke: lasso11.snappedStroke,
          selectedIds: lasso11.selectedIds,
        },
        rest300: {
          snapped: lasso30.snapped,
          sample: lasso30.snappedSample,
          stroke: lasso30.snappedStroke,
          selectedIds: [],
        },
      });

      // 5. Tool: curve (Draw tool free curve with SHAPE_HOLD_MS = 450 ms)
      const curve50 = new SmartPenStateMachine({ tool: 'curve', width: s.width });
      for (const [x, y, t, force] of rawSamples) {
        curve50.addSample(x, y, t, force);
      }
      curve50.feedRest(500, 20);

      const curve30 = new SmartPenStateMachine({ tool: 'curve', width: s.width });
      for (const [x, y, t, force] of rawSamples) {
        curve30.addSample(x, y, t, force);
      }
      curve30.feedRest(300, 20);

      if (!curve30.snapped) {
        strokes.push({
          id: `${baseId}-curve`,
          tool: 'curve',
          width: n(s.width),
          samples: rawSamples,
          rest500: {
            snapped: curve50.snapped,
            sample: curve50.snappedSample,
            stroke: curve50.snappedStroke,
          },
          rest300: {
            snapped: curve30.snapped,
            sample: curve30.snappedSample,
            stroke: curve30.snappedStroke,
          },
        });
      }
    }
  }

  // Also include synthetic shapes
  const pageSynths: NotePage = {
    id: 'page_synths',
    pageNumber: 1,
    strokes: allPageStrokes,
    latexBlocks: [],
    textBlocks: [],
    imageBlocks: [],
  };

  const synths = synthShapes(1);
  for (const s of synths) {
    const rawSamples = s.points.map((p) => [n(p.x), n(p.y), n(p.t), n(p.pressure)]);

    // 1. Tool: pen (original)
    const pen11 = new SmartPenStateMachine({ tool: 'pen', width: 2 });
    for (const [x, y, t, force] of rawSamples) {
      pen11.addSample(x, y, t, force);
    }
    pen11.feedRest(1100, 20);

    const pen30 = new SmartPenStateMachine({ tool: 'pen', width: 2 });
    for (const [x, y, t, force] of rawSamples) {
      pen30.addSample(x, y, t, force);
    }
    pen30.feedRest(300, 20);

    strokes.push({
      id: s.id,
      tool: 'pen',
      width: 2,
      samples: rawSamples,
      rest1100: {
        snapped: pen11.snapped,
        sample: pen11.snappedSample,
        stroke: pen11.snappedStroke,
      },
      rest300: {
        snapped: pen30.snapped,
        sample: pen30.snappedSample,
        stroke: pen30.snappedStroke,
      },
    });

    // 2. Tool: highlighter
    const hl11 = new SmartPenStateMachine({ tool: 'highlighter', width: 2 });
    for (const [x, y, t, force] of rawSamples) {
      hl11.addSample(x, y, t, force);
    }
    hl11.feedRest(1100, 20);

    const hl30 = new SmartPenStateMachine({ tool: 'highlighter', width: 2 });
    for (const [x, y, t, force] of rawSamples) {
      hl30.addSample(x, y, t, force);
    }
    hl30.feedRest(300, 20);

    strokes.push({
      id: `${s.id}-highlighter`,
      tool: 'highlighter',
      width: 2,
      samples: rawSamples,
      rest1100: {
        snapped: hl11.snapped,
        sample: hl11.snappedSample,
        stroke: hl11.snappedStroke,
      },
      rest300: {
        snapped: hl30.snapped,
        sample: hl30.snappedSample,
        stroke: hl30.snappedStroke,
      },
    });

    // 3. Tool: eraser
    const eraser11 = new SmartPenStateMachine({ tool: 'eraser', width: 2, page: pageSynths });
    for (const [x, y, t, force] of rawSamples) {
      eraser11.addSample(x, y, t, force);
    }
    eraser11.feedRest(1100, 20);

    const eraser30 = new SmartPenStateMachine({ tool: 'eraser', width: 2, page: pageSynths });
    for (const [x, y, t, force] of rawSamples) {
      eraser30.addSample(x, y, t, force);
    }
    eraser30.feedRest(300, 20);

    strokes.push({
      id: `${s.id}-eraser`,
      tool: 'eraser',
      width: 2,
      samples: rawSamples,
      rest1100: {
        snapped: eraser11.snapped,
        sample: eraser11.snappedSample,
        stroke: eraser11.snappedStroke,
        erased: eraser11.erased,
        putBack: eraser11.putBack,
      },
      rest300: {
        snapped: eraser30.snapped,
        sample: eraser30.snappedSample,
        stroke: eraser30.snappedStroke,
        erased: [],
        putBack: [],
      },
    });

    // 4. Tool: lasso
    const lasso11 = new SmartPenStateMachine({ tool: 'lasso', width: 2, page: pageSynths });
    for (const [x, y, t, force] of rawSamples) {
      lasso11.addSample(x, y, t, force);
    }
    lasso11.feedRest(1100, 20);

    const lasso30 = new SmartPenStateMachine({ tool: 'lasso', width: 2, page: pageSynths });
    for (const [x, y, t, force] of rawSamples) {
      lasso30.addSample(x, y, t, force);
    }
    lasso30.feedRest(300, 20);

    strokes.push({
      id: `${s.id}-lasso`,
      tool: 'lasso',
      width: 2,
      samples: rawSamples,
      rest1100: {
        snapped: lasso11.snapped,
        sample: lasso11.snappedSample,
        stroke: lasso11.snappedStroke,
        selectedIds: lasso11.selectedIds,
      },
      rest300: {
        snapped: lasso30.snapped,
        sample: lasso30.snappedSample,
        stroke: lasso30.snappedStroke,
        selectedIds: [],
      },
    });

    // 5. Tool: curve
    const curve50 = new SmartPenStateMachine({ tool: 'curve', width: 2 });
    for (const [x, y, t, force] of rawSamples) {
      curve50.addSample(x, y, t, force);
    }
    curve50.feedRest(500, 20);

    const curve30 = new SmartPenStateMachine({ tool: 'curve', width: 2 });
    for (const [x, y, t, force] of rawSamples) {
      curve30.addSample(x, y, t, force);
    }
    curve30.feedRest(300, 20);

    strokes.push({
      id: `${s.id}-curve`,
      tool: 'curve',
      width: 2,
      samples: rawSamples,
      rest500: {
        snapped: curve50.snapped,
        sample: curve50.snappedSample,
        stroke: curve50.snappedStroke,
      },
      rest300: {
        snapped: curve30.snapped,
        sample: curve30.snappedSample,
        stroke: curve30.snappedStroke,
      },
    });
  }

  return { pageStrokes: allPageStrokes, strokes };
}
