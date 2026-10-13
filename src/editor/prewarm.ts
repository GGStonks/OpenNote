import { Point, ShapeMode, Stroke } from '../types';
import { LiveStroke } from '../ink/engine';
import { drawLiveStroke, drawStrokes, eraseStrokesPartial, strokeHitTest } from '../ink/strokeRenderer';
import { detectShape } from '../services/shapeRecognition';
import { SmartPenOptions, beginSmartPen, buildSnapCache, moveSmartPen, smartPenMeasure, smartPenShape, smartPenStroke } from './smartPen';

/**
 * Tool pre-warm. The first stroke after the app starts was slow with every tool: the JavaScript
 * engine runs new code in its interpreter until it has been called enough to be compiled, and
 * the canvas creates its paths, clip and fill machinery on first use. Shortly after a note opens,
 * in idle time, every tool's code path is run once on a hidden canvas with a made-up stroke: the
 * pen and highlighter (live painter and committed ink), every smart-pen mode with snapping,
 * hold-to-snap shape detection, both erasers and the hit test. Nothing touches the note.
 */

let done = false;

const idle = (fn: () => void) => {
  const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (ric) ric(fn, { timeout: 1500 });
  else setTimeout(fn, 60);
};

/** A made-up handwritten loop: 240 Hz samples with force, like a real Pencil stroke. */
function sampleStroke(n = 90, force = 0.3): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1), a = u * 4 * Math.PI;
    out.push({ x: 40 + 120 * u + 12 * Math.cos(a), y: 60 + 12 * Math.sin(a), pressure: i < 2 ? 0.08 : force * (1 + 0.2 * Math.sin(a)), t: (i * 1000) / 240 });
  }
  out.push({ ...out[out.length - 1], x: out[out.length - 1].x + 1, pressure: 0, t: out[out.length - 1].t! + 4 });
  return out;
}

function stroke(id: string, points: Point[], extra: Partial<Stroke> = {}): Stroke {
  return { id, tool: 'pen', color: '#111827', width: 2, opacity: 1, penStyle: 'fountain', lineStyle: 'solid', points, ...extra };
}

export function prewarmTools(): void {
  if (done) return;
  done = true;
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const pts = sampleStroke();

  const steps: (() => void)[] = [
    // Pen: the live painter (Nib model, chunked paths, clipped fill), fountain and ballpoint.
    () => {
      for (const variable of [true, false]) {
        const live = new LiveStroke();
        for (const p of pts) {
          live.add(p.x, p.y, p.t ?? 0, p.pressure);
          live.paint(ctx, { color: '#111827', width: 2.8, variable });
        }
      }
    },
    // Committed ink of every kind (path building and caching, fills, hatches, arrows, dashes).
    () => {
      const square = [{ x: 20, y: 20 }, { x: 80, y: 20 }, { x: 80, y: 80 }, { x: 20, y: 80 }].map((q) => ({ ...q, pressure: 0.5 }));
      drawStrokes(ctx, [
        stroke('w1', pts),
        stroke('w2', pts, { penStyle: 'ballpoint' }),
        stroke('w3', pts, { tool: 'highlighter', color: '#FDE047', width: 4, penStyle: 'ballpoint' }),
        stroke('w4', square, { isShape: true, closed: true, shapeKind: 'rectangle', fill: 'crosshatch', penStyle: 'ballpoint', lineStyle: 'dashed' }),
        stroke('w5', square, { isShape: true, closed: true, shapeKind: 'curve', fill: 'solid', penStyle: 'ballpoint' }),
        stroke('w6', square.slice(0, 2), { isShape: true, shapeKind: 'line', arrow: true, penStyle: 'ballpoint', lineStyle: 'dotted' }),
        stroke('w7', square.slice(0, 1), { isShape: true, shapeKind: 'point', penStyle: 'ballpoint' }),
      ]);
      drawLiveStroke(ctx, pts, { tool: 'highlighter', color: '#FDE047', width: 4, penStyle: 'ballpoint' });
    },
    // Hold-to-snap, erasers and the lasso's hit test.
    () => {
      detectShape(pts);
      const ink = [stroke('e1', pts), stroke('e2', pts, { penStyle: 'ballpoint' })];
      for (let i = 0; i < pts.length; i += 6) {
        eraseStrokesPartial(ink, pts[i].x, pts[i].y, 6, () => 'e');
        strokeHitTest(ink[0], pts[i].x, pts[i].y, 6);
      }
    },
    // Smart pen: every mode, with snapping to shapes and retracing.
    () => {
      const shapes = [
        stroke('s1', [{ x: 20, y: 20 }, { x: 120, y: 20 }, { x: 120, y: 90 }, { x: 20, y: 90 }].map((q) => ({ ...q, pressure: 0.5 })), {
          isShape: true, closed: true, shapeKind: 'rectangle', penStyle: 'ballpoint',
        }),
      ];
      buildSnapCache(shapes, 24);
      for (const mode of ['curve', 'line', 'rectangle', 'ellipse', 'point'] as ShapeMode[]) {
        const opts: SmartPenOptions = { mode, color: '#111827', width: 2, fill: 'none', arrow: false, lineStyle: 'solid', snap: true, grid: 24 };
        const st = beginSmartPen(pts[0], opts, shapes, 1);
        for (const p of pts) {
          moveSmartPen(st, p);
          smartPenShape(st, false);
          smartPenMeasure(st);
        }
        smartPenStroke(st, opts, 'w');
      }
    },
  ];
  // One step per idle period, so none of it delays the note opening or the first touch.
  const next = () => {
    const step = steps.shift();
    if (!step) return;
    try {
      step();
    } catch {
      /* best effort */
    }
    idle(next);
  };
  idle(next);
}
