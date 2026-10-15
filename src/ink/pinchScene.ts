/**
 * Strokes as data for the pinch overlay's worker (pinchWorker.ts), which draws the ink sharp while
 * two fingers zoom without holding up the page.
 *
 * Each committed stroke is encoded once (cached per stroke object):
 *  - handwriting: the ink engine's modelled centre line (strokeGeometry), as x, y, radius per point
 *    for the fountain pen (the worker builds the same union of capsules as the page) or x, y per
 *    point and one width for a uniform line (ballpoint, highlighter);
 *  - anything else (shapes, fills, dashes, arrows): the page's own drawing commands, recorded
 *    (inkRecorder.recordOps).
 * "Hole" fills, which punch through the canvas, are left out of the overlay.
 */
import type { Stroke } from '../types';
import { paintStrokeFresh, strokeGeometry, strokePaintBounds, strokeWidth, styleOf } from './strokeRenderer';
import { recordOps } from './inkRecorder';

export type InkPart =
  | { kind: 'caps'; pts: Float32Array; color: string; alpha: number }
  | { kind: 'line'; pts: Float32Array; width: number; color: string; alpha: number }
  | { kind: 'ops'; ops: Float32Array };

export interface SceneItem {
  /** Highlighter: its ink is drawn under every other stroke's. */
  hl: boolean;
  fill: Float32Array | null;
  ink: InkPart | null;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

const cache = new WeakMap<Stroke, SceneItem>();

export function sceneItem(s: Stroke): SceneItem {
  let item = cache.get(s);
  if (item) return item;
  const style = styleOf(s);
  const hl = s.tool === 'highlighter';
  const hasFill = !hl && !!s.fill && s.fill !== 'none' && s.fill !== 'hole';
  const fill = hasFill ? recordOps((ctx) => paintStrokeFresh(ctx, s, 'fill')) : null;
  let ink: InkPart | null = null;
  const solid = (style.lineStyle ?? 'solid') === 'solid';
  if (s.fillOnly) ink = null;
  else if (!s.isShape && solid && s.points.length) {
    const g = strokeGeometry(s);
    if (g.widths && !hl) {
      const pts = new Float32Array(g.pts.length * 3);
      g.pts.forEach((q, i) => {
        pts[i * 3] = q.x;
        pts[i * 3 + 1] = q.y;
        pts[i * 3 + 2] = g.widths![i] / 2;
      });
      ink = { kind: 'caps', pts, color: s.color, alpha: s.opacity ?? 1 };
    } else {
      const pts = new Float32Array(g.pts.length * 2);
      g.pts.forEach((q, i) => {
        pts[i * 2] = q.x;
        pts[i * 2 + 1] = q.y;
      });
      ink = hl
        ? { kind: 'line', pts, width: s.width * 5.5, color: s.color, alpha: 0.35 }
        : { kind: 'line', pts, width: strokeWidth(style), color: s.color, alpha: s.opacity ?? 1 };
    }
  } else if (s.points.length) {
    ink = { kind: 'ops', ops: recordOps((ctx) => paintStrokeFresh(ctx, s, 'ink')) };
  }
  item = { hl, fill, ink, bounds: strokePaintBounds(s) };
  cache.set(s, item);
  return item;
}
