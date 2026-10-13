import { ModeledPoint, capsulePath, pressureWidth } from './geometry';
import { NibModeler } from './nib';

/**
 * The stroke being written, drawn live: the Nib model plus its painter.
 *
 * Settled ink never changes, so it is appended to path chunks (with their bounds) as it settles;
 * the ink still settling near the pen is recomputed every frame. Each frame the region that
 * changed is cleared and filled again with ONE path — the settled chunks that reach into it and
 * the settling end together — so overlapping fills never paint antialiased edges twice, and the
 * live ink looks exactly like the finished stroke drawn later from the same samples.
 */

export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface LiveStyle {
  color: string;
  /** Nominal line width (px). */
  width: number;
  /** Fountain pen: the width follows the pressure, drawn as capsules; otherwise a round-capped line. */
  variable: boolean;
}

/** Settled ink is kept in path chunks of this many points, so a frame only repaints near the pen. */
const CHUNK = 64;

const union = (a: Rect | null, b: Rect | null): Rect | null =>
  !a ? b : !b ? a : { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) };
const intersects = (a: Rect, b: Rect) => a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;

export class LiveStroke {
  readonly model = new NibModeler();
  private chunks: { path: Path2D; rect: Rect | null; n: number }[] = [];
  /** Settled points already in the chunks. */
  private drawn = 0;
  private settledRect: Rect | null = null;
  private tailRect: Rect | null = null;
  private builtFor: string | null = null;

  /** Adds a pen sample: page px, ms, force 0..1 (0 = unknown / lifting). */
  add(x: number, y: number, t: number, pressure: number): void {
    this.model.add(x, y, t, pressure);
  }

  /** Everything this stroke has painted so far (to clear when it ends). */
  get bounds(): Rect | null {
    return union(this.settledRect, this.tailRect);
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
    const widthOf = (q: ModeledPoint) => (style.variable ? pressureWidth(style.width, q.p) : style.width);
    /** Appends seq to a path; from = 1: its first point is already on the path. */
    const append = (path: Path2D, seq: ModeledPoint[], from: number) => {
      if (!seq.length) return;
      if (style.variable) capsulePath(seq, seq.map(widthOf), from, path);
      else {
        if (from === 0) path.moveTo(seq[0].x, seq[0].y);
        if (seq.length === 1) path.lineTo(seq[0].x + 0.01, seq[0].y);
        for (let i = 1; i < seq.length; i++) path.lineTo(seq[i].x, seq[i].y);
      }
    };

    const pts = this.model.points;
    if (this.drawn < pts.length) {
      const seg = pts.slice(Math.max(0, this.drawn - 1));
      let chunk = this.chunks[this.chunks.length - 1];
      const fresh = !chunk || chunk.n >= CHUNK;
      if (fresh) this.chunks.push((chunk = { path: new Path2D(), rect: null, n: 0 }));
      // A new chunk starts at the last drawn point, so the line continues across chunks.
      append(chunk.path, seg, this.drawn === 0 || fresh ? 0 : 1);
      chunk.rect = grow(chunk.rect, seg);
      chunk.n += seg.length;
      this.settledRect = grow(this.settledRect, seg);
      changed = grow(changed, seg);
      this.drawn = pts.length;
    }
    const tailPts = this.model.tail();
    const tail = pts.length ? [pts[pts.length - 1], ...tailPts] : tailPts;
    const tailPath = new Path2D();
    append(tailPath, tail, pts.length ? 1 : 0);
    this.tailRect = tail.length ? grow(null, tail) : null;
    changed = union(changed, this.tailRect);
    if (!changed) return;

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
