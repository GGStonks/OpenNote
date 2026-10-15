/// <reference lib="webworker" />
/**
 * The pinch overlay's drawing, off the page's thread (useViewport.ts, PinchInk). The page sends the
 * strokes once (pinchScene.ts; kept here by id across pinches) and then only where the view is; this
 * worker draws the visible ink on its OffscreenCanvas for the latest view as fast as it can and says
 * which view it drew, so the page can move the canvas with a CSS transform until the next drawing.
 *
 * Messages in:
 *   init  { canvas: OffscreenCanvas, dpr }          a new overlay canvas (one per pinch)
 *   items { list: { id, item: SceneItem }[] }       strokes not sent before
 *   order { ids }                                    the strokes to draw, in the page's order
 *   view  { seq, ax, ay, S, w, h }                   canvas px = dpr * (a + S * page px); size in CSS px
 *   detach                                           the overlay is gone
 * Message out:
 *   drawn { seq }                                    the canvas now shows view `seq`
 */
import { capsulePath } from './engine';
import { OP } from './inkRecorder.ops';
import type { InkPart, SceneItem } from './pinchScene';

type Cmd =
  | { t: 'S' | 'R' }
  | { t: 'F' | 'K'; c: string }
  | { t: 'A' | 'W'; v: number }
  | { t: 'P'; cap: CanvasLineCap; join: CanvasLineJoin }
  | { t: 'D'; dash: number[]; off: number }
  | { t: 'f' | 'x'; p: Path2D; even: boolean }
  | { t: 's'; p: Path2D };

interface Built {
  hl: boolean;
  fill: Cmd[] | null;
  ink: { draw: (ctx: OffscreenCanvasRenderingContext2D) => void } | null;
  bounds: SceneItem['bounds'];
}

const CAPS: CanvasLineCap[] = ['butt', 'round', 'square'];
const JOINS: CanvasLineJoin[] = ['miter', 'round', 'bevel'];
const rgba = (o: Float32Array, i: number) => `rgba(${o[i]},${o[i + 1]},${o[i + 2]},${o[i + 3]})`;

/** Recorded commands (inkRecorder.recordOps) as canvas calls with their paths built once. */
function parse(o: Float32Array): Cmd[] {
  const out: Cmd[] = [];
  let p = new Path2D();
  let empty = true;
  for (let i = 0; i < o.length; ) {
    const op = o[i++];
    switch (op) {
      case OP.S: out.push({ t: 'S' }); break;
      case OP.R: out.push({ t: 'R' }); break;
      case OP.F: out.push({ t: 'F', c: rgba(o, i) }); i += 4; break;
      case OP.K: out.push({ t: 'K', c: rgba(o, i) }); i += 4; break;
      case OP.A: out.push({ t: 'A', v: o[i++] }); break;
      case OP.W: out.push({ t: 'W', v: o[i++] }); break;
      case OP.P: out.push({ t: 'P', cap: CAPS[o[i]] ?? 'butt', join: JOINS[o[i + 1]] ?? 'miter' }); i += 2; break;
      case OP.D: {
        const n = o[i++];
        out.push({ t: 'D', dash: Array.from(o.subarray(i, i + n)), off: o[i + n] });
        i += n + 1;
        break;
      }
      case OP.N: p = new Path2D(); empty = true; break;
      case OP.M: p.moveTo(o[i], o[i + 1]); empty = false; i += 2; break;
      case OP.L: (empty ? p.moveTo(o[i], o[i + 1]) : p.lineTo(o[i], o[i + 1])); empty = false; i += 2; break;
      case OP.Q: p.quadraticCurveTo(o[i], o[i + 1], o[i + 2], o[i + 3]); i += 4; break;
      case OP.C: p.bezierCurveTo(o[i], o[i + 1], o[i + 2], o[i + 3], o[i + 4], o[i + 5]); i += 6; break;
      case OP.E: p.arc(o[i], o[i + 1], o[i + 2], o[i + 3], o[i + 4], o[i + 5] !== 0); empty = false; i += 6; break;
      case OP.X: p.rect(o[i], o[i + 1], o[i + 2], o[i + 3]); empty = false; i += 4; break;
      case OP.Z: p.closePath(); break;
      case OP.f: out.push({ t: 'f', p, even: o[i++] === 1 }); break;
      case OP.s: out.push({ t: 's', p }); break;
      case OP.x: out.push({ t: 'x', p, even: o[i++] === 1 }); break;
      default: return out; // unknown: stop rather than misread the rest
    }
  }
  return out;
}

function run(ctx: OffscreenCanvasRenderingContext2D, cmds: Cmd[]) {
  ctx.save();
  for (const c of cmds) {
    switch (c.t) {
      case 'S': ctx.save(); break;
      case 'R': ctx.restore(); break;
      case 'F': ctx.fillStyle = c.c; break;
      case 'K': ctx.strokeStyle = c.c; break;
      case 'A': ctx.globalAlpha = c.v; break;
      case 'W': ctx.lineWidth = c.v; break;
      case 'P': ctx.lineCap = c.cap; ctx.lineJoin = c.join; break;
      case 'D': ctx.setLineDash(c.dash); ctx.lineDashOffset = c.off; break;
      case 'f': ctx.fill(c.p, c.even ? 'evenodd' : 'nonzero'); break;
      case 's': ctx.stroke(c.p); break;
      case 'x': ctx.clip(c.p, c.even ? 'evenodd' : 'nonzero'); break;
    }
  }
  ctx.restore();
}

function buildInk(part: InkPart): Built['ink'] {
  if (part.kind === 'ops') {
    const cmds = parse(part.ops);
    return { draw: (ctx) => run(ctx, cmds) };
  }
  if (part.kind === 'caps') {
    const n = part.pts.length / 3;
    const pts: { x: number; y: number }[] = [], widths: number[] = [];
    for (let i = 0; i < n; i++) {
      pts.push({ x: part.pts[i * 3], y: part.pts[i * 3 + 1] });
      widths.push(part.pts[i * 3 + 2] * 2);
    }
    // The page's own geometry: the engine's union of capsules.
    const path = capsulePath(pts, widths, 0, new Path2D());
    return {
      draw: (ctx) => {
        ctx.globalAlpha = part.alpha;
        ctx.fillStyle = part.color;
        ctx.fill(path);
        ctx.globalAlpha = 1;
      },
    };
  }
  const path = new Path2D();
  const n = part.pts.length / 2;
  if (n) path.moveTo(part.pts[0], part.pts[1]);
  if (n === 1) path.lineTo(part.pts[0] + 0.01, part.pts[1]);
  for (let i = 1; i < n; i++) path.lineTo(part.pts[i * 2], part.pts[i * 2 + 1]);
  return {
    draw: (ctx) => {
      ctx.globalAlpha = part.alpha;
      ctx.strokeStyle = part.color;
      ctx.lineWidth = part.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke(path);
      ctx.globalAlpha = 1;
    },
  };
}

const items = new Map<number, Built>();
let order: number[] = [];
let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let dpr = 1;
let view: { seq: number; ax: number; ay: number; S: number; w: number; h: number } | null = null;
let drawnSeq = -1;
let scheduled = false;

const nextFrame = (fn: () => void) =>
  typeof (self as unknown as { requestAnimationFrame?: unknown }).requestAnimationFrame === 'function'
    ? (self as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame(fn)
    : setTimeout(fn, 0);

function schedule() {
  if (scheduled) return;
  scheduled = true;
  nextFrame(render);
}

function render() {
  scheduled = false;
  const v = view;
  if (!canvas || !ctx || !v || v.seq === drawnSeq) return;
  const W = Math.round(v.w * dpr), H = Math.round(v.h * dpr);
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.setTransform(dpr * v.S, 0, 0, dpr * v.S, dpr * v.ax, dpr * v.ay);
  const x0 = -v.ax / v.S, x1 = (v.w - v.ax) / v.S, y0 = -v.ay / v.S, y1 = (v.h - v.ay) / v.S;
  const shown: Built[] = [];
  for (const id of order) {
    const b = items.get(id);
    if (b && b.bounds.maxX >= x0 && b.bounds.minX <= x1 && b.bounds.maxY >= y0 && b.bounds.minY <= y1) shown.push(b);
  }
  // As drawStrokes: highlighters, then fills, then ink.
  for (const b of shown) if (b.hl) b.ink?.draw(ctx);
  for (const b of shown) if (b.fill) run(ctx, b.fill as Cmd[]);
  for (const b of shown) if (!b.hl) b.ink?.draw(ctx);
  drawnSeq = v.seq;
  self.postMessage({ type: 'drawn', seq: v.seq });
  // A newer view arrived while drawing: draw again on the next frame.
  if (view && view.seq !== drawnSeq) schedule();
}

self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  switch (m.type) {
    case 'init':
      canvas = m.canvas as OffscreenCanvas;
      ctx = canvas.getContext('2d');
      dpr = m.dpr;
      drawnSeq = -1;
      break;
    case 'items':
      for (const { id, item } of m.list as { id: number; item: SceneItem }[]) {
        items.set(id, { hl: item.hl, fill: item.fill ? parse(item.fill) : null, ink: item.ink ? buildInk(item.ink) : null, bounds: item.bounds });
      }
      break;
    case 'order':
      order = m.ids;
      break;
    case 'view':
      view = m;
      schedule();
      break;
    case 'detach':
      canvas = null;
      ctx = null;
      view = null;
      break;
  }
};
