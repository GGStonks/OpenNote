/**
 * The stroke being written, drawn live as the line the finished stroke will be
 * (strokeRenderer.strokeGeometry): the ink engine's line, smoothed except its last SMOOTH_SETTLE.
 *
 * The engine's own painter (engine/liveStroke.ts, frozen) draws its line as modelled, which is
 * nearly straight between two pen samples: fast strokes looked segmented (on Android especially,
 * with fewer samples), and smoothing only the finished stroke made the ink shift when the pen
 * lifted. Here the part of the line later samples can no longer change (settledIndex) is smoothed
 * once and kept in path chunks; the rest (the last SMOOTH_SETTLE and the engine's provisional tail)
 * is drawn as modelled and redrawn every frame. Like the engine's painter, each frame clears the
 * region that changed and fills it again with ONE path, so overlapping fills never paint antialiased
 * edges twice. The native live ink (nativeInk.ts) draws the same line from line().
 */
import { NibModeler, capsulePath, pressureWidth } from './engine';
import type { LiveStyle, ModeledPoint, Rect } from './engine';
import { SMOOTH_SETTLE, settledIndex, smoothLine } from './strokeRenderer';

const CHUNK = 64;
/** Line before the new points that their smoothing can depend on (page px, with a margin). */
const WINDOW = SMOOTH_SETTLE + 3;

/**
 * `r` grown to whole device pixels of `ctx`'s canvas. Clearing and clipping a rectangle that ends
 * inside a pixel cleared that pixel only partly, and the antialiased refill over what was left
 * showed as a faint line through the ink along the rectangle's edge (plain to see zoomed in).
 */
export function pixelAligned(ctx: CanvasRenderingContext2D, r: Rect): Rect {
  const { a, d, e, f } = ctx.getTransform();
  if (!(a > 0) || !(d > 0)) return r;
  return {
    minX: (Math.floor(r.minX * a + e) - e) / a,
    maxX: (Math.ceil(r.maxX * a + e) - e) / a,
    minY: (Math.floor(r.minY * d + f) - f) / d,
    maxY: (Math.ceil(r.maxY * d + f) - f) / d,
  };
}

const union = (a: Rect | null, b: Rect | null): Rect | null =>
  !a ? b : !b ? a : { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) };
const intersects = (a: Rect, b: Rect) => a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;

export class SmoothLiveStroke {
  readonly model = new NibModeler();
  /** The smoothed, final part of the line and its widths (it only grows). */
  private finalPts: ModeledPoint[] = [];
  private finalW: number[] = [];
  private lineFor: string | null = null;
  private chunks: { path: Path2D; rect: Rect | null; n: number }[] = [];
  /** Final points already in the chunks. */
  private drawn = 0;
  private settledRect: Rect | null = null;
  private tailRect: Rect | null = null;
  private builtFor: string | null = null;

  add(x: number, y: number, t: number, pressure: number): void {
    this.model.add(x, y, t, pressure);
  }

  /** Everything this stroke has painted so far (to clear when it ends). */
  get bounds(): Rect | null {
    return union(this.settledRect, this.tailRect);
  }

  /**
   * The line as it is drawn now: `final` smoothed points (they never change again) followed by
   * the rest as modelled (`rest`, with the engine's tail), each with its width.
   */
  line(style: LiveStyle): { final: ModeledPoint[]; finalW: number[]; rest: ModeledPoint[]; restW: number[] } {
    const key = `${style.variable}|${style.width}`;
    if (key !== this.lineFor) {
      this.lineFor = key;
      this.finalPts = [];
      this.finalW = [];
    }
    const widthOf = (q: ModeledPoint) => (style.variable ? pressureWidth(style.width, q.p) : style.width);
    const raw = this.model.points;
    const done = this.finalPts.length;
    const upTo = Math.max(done, settledIndex(raw));
    if (upTo > done) {
      // Only the end of the line can reach the new points (their smoothing window and the corner
      // test look SMOOTH_SETTLE back at most): smoothing it all every frame cost time growing with
      // the stroke (2 ms a frame after 3 s of fast writing on a desktop, many times that on a
      // slow tablet).
      let from = done, back = 0;
      while (from > 0 && back < WINDOW) {
        back += Math.hypot(raw[from].x - raw[from - 1].x, raw[from].y - raw[from - 1].y);
        from--;
      }
      const seg = raw.slice(from);
      const g = smoothLine({ pts: seg, widths: seg.map(widthOf), width: style.width }, upTo - from, done - from);
      for (let i = done; i < upTo; i++) {
        this.finalPts.push(g.pts[i - from]);
        this.finalW.push(g.widths ? g.widths[i - from] : widthOf(g.pts[i - from]));
      }
    }
    const rest = raw.slice(this.finalPts.length).concat(this.model.tail());
    return { final: this.finalPts, finalW: this.finalW, rest, restW: rest.map(widthOf) };
  }

  /** Paints what changed since the last call. */
  paint(ctx: CanvasRenderingContext2D, style: LiveStyle): void {
    const key = `${style.variable}|${style.width}|${style.color}`;
    let changed = this.tailRect;
    if (key !== this.builtFor) {
      // First paint, or the style changed (e.g. real pressure turned up): rebuild from scratch.
      changed = union(changed, this.settledRect);
      this.chunks = [];
      this.drawn = 0;
      this.settledRect = null;
      this.builtFor = key;
    }
    const pad = style.width * 1.7 + 2;
    const grow = (r: Rect | null, seq: ModeledPoint[]) => {
      for (const q of seq) r = union(r, { minX: q.x - pad, minY: q.y - pad, maxX: q.x + pad, maxY: q.y + pad });
      return r;
    };
    /** Appends seq to a path; from = 1: its first point is already on the path. */
    const append = (path: Path2D, seq: ModeledPoint[], widths: number[], from: number) => {
      if (!seq.length) return;
      if (style.variable) capsulePath(seq, widths, from, path);
      else {
        if (from === 0) path.moveTo(seq[0].x, seq[0].y);
        if (seq.length === 1) path.lineTo(seq[0].x + 0.01, seq[0].y);
        for (let i = 1; i < seq.length; i++) path.lineTo(seq[i].x, seq[i].y);
      }
    };

    const { final, finalW, rest, restW } = this.line(style);
    if (this.drawn < final.length) {
      const start = Math.max(0, this.drawn - 1);
      const seg = final.slice(start), segW = finalW.slice(start);
      let chunk = this.chunks[this.chunks.length - 1];
      const fresh = !chunk || chunk.n >= CHUNK;
      if (fresh) this.chunks.push((chunk = { path: new Path2D(), rect: null, n: 0 }));
      // A new chunk starts at the last drawn point, so the line continues across chunks.
      append(chunk.path, seg, segW, this.drawn === 0 || fresh ? 0 : 1);
      chunk.rect = grow(chunk.rect, seg);
      chunk.n += seg.length;
      this.settledRect = grow(this.settledRect, seg);
      changed = grow(changed, seg);
      this.drawn = final.length;
    }
    // The rest continues from the last final point.
    const tail = final.length ? [final[final.length - 1], ...rest] : rest;
    const tailW = final.length ? [finalW[finalW.length - 1], ...restW] : restW;
    const tailPath = new Path2D();
    append(tailPath, tail, tailW, final.length ? 1 : 0);
    this.tailRect = tail.length ? grow(null, tail) : null;
    changed = union(changed, this.tailRect);
    if (!changed) return;
    changed = pixelAligned(ctx, changed);

    const all = new Path2D();
    for (const c of this.chunks) if (c.rect && intersects(c.rect, changed)) all.addPath(c.path);
    all.addPath(tailPath);
    const w = changed.maxX - changed.minX, h = changed.maxY - changed.minY;
    ctx.save();
    ctx.beginPath();
    ctx.rect(changed.minX, changed.minY, w, h);
    ctx.clip();
    ctx.clearRect(changed.minX, changed.minY, w, h);
    if (style.variable) {
      ctx.fillStyle = style.color;
      ctx.fill(all);
    } else {
      ctx.strokeStyle = style.color;
      ctx.lineWidth = style.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke(all);
    }
    ctx.restore();
  }
}
