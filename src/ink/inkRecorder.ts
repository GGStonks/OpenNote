/**
 * Records a live drawing (the Draw tool's shape, a snapped pen shape, the snap dot) as a list of
 * drawing commands for the app shell's native ink layer (src/ink/nativeInk.ts), so the shell
 * shows exactly what the page's canvas shows, without waiting for the web view's rendering.
 *
 * `record(tf, draw)` runs `draw` on a stand-in 2D context while the stroke renderer makes its
 * paths as stand-ins too (withPathFactory), and returns the commands in the shell's view units.
 * Only what the live drawing uses is supported: paths (moveTo, lineTo, quadratic / bezier curves,
 * arc, rect, closePath, addPath), fill and clip (nonzero / evenodd), stroke, save / restore, colours,
 * globalAlpha, line width, caps, joins and dashes. Text is left to the page.
 *
 * Commands (comma-separated tokens):
 *   S save   R restore   F r g b a fill colour   K r g b a stroke colour   A alpha   W width
 *   P cap join (0 butt/miter, 1 round, 2 square/bevel)   D n v1..vn offset dash
 *   N new path   M x y   L x y   Q cx cy x y   C x1 y1 x2 y2 x y   E cx cy r a0 a1 ccw   Z
 *   X x y w h (rect)   f rule   s   x rule (clip; rule 0 nonzero, 1 evenodd)
 */
import { withPathFactory } from './strokeRenderer';
import type { InkTransform } from './nativeInk';

type Op = (string | number)[];

class RecPath {
  ops: Op[] = [];
  moveTo(x: number, y: number) {
    this.ops.push(['M', x, y]);
  }
  lineTo(x: number, y: number) {
    this.ops.push(['L', x, y]);
  }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number) {
    this.ops.push(['Q', cx, cy, x, y]);
  }
  bezierCurveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number) {
    this.ops.push(['C', x1, y1, x2, y2, x, y]);
  }
  arc(cx: number, cy: number, r: number, a0: number, a1: number, ccw = false) {
    this.ops.push(['E', cx, cy, r, a0, a1, ccw ? 1 : 0]);
  }
  rect(x: number, y: number, w: number, h: number) {
    this.ops.push(['X', x, y, w, h]);
  }
  roundRect(x: number, y: number, w: number, h: number) {
    this.rect(x, y, w, h);
  }
  closePath() {
    this.ops.push(['Z']);
  }
  addPath(p: RecPath) {
    this.ops.push(...p.ops);
  }
}

const CAPS: Record<string, number> = { butt: 0, round: 1, square: 2 };
const JOINS: Record<string, number> = { miter: 0, round: 1, bevel: 2 };

class RecCtx {
  out: Op[] = [];
  private path = new RecPath();
  private colorCtx = document.createElement('canvas').getContext('2d')!;
  private state = { fill: '#000', stroke: '#000', alpha: 1, width: 1, cap: 'butt', join: 'miter' };
  private stack: (typeof this.state)[] = [];

  private rgba(c: string): number[] {
    this.colorCtx.fillStyle = '#000';
    this.colorCtx.fillStyle = c;
    const v = String(this.colorCtx.fillStyle);
    if (v.startsWith('#')) return [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16), 1];
    const m = v.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 1];
    return [m[0] ?? 0, m[1] ?? 0, m[2] ?? 0, m[3] ?? 1];
  }

  set fillStyle(c: string) {
    this.state.fill = c;
    this.out.push(['F', ...this.rgba(c)]);
  }
  get fillStyle() {
    return this.state.fill;
  }
  set strokeStyle(c: string) {
    this.state.stroke = c;
    this.out.push(['K', ...this.rgba(c)]);
  }
  get strokeStyle() {
    return this.state.stroke;
  }
  set globalAlpha(a: number) {
    this.state.alpha = a;
    this.out.push(['A', a]);
  }
  get globalAlpha() {
    return this.state.alpha;
  }
  set lineWidth(w: number) {
    this.state.width = w;
    this.out.push(['W', w]);
  }
  get lineWidth() {
    return this.state.width;
  }
  set lineCap(c: string) {
    this.state.cap = c;
    this.out.push(['P', CAPS[c] ?? 0, JOINS[this.state.join] ?? 0]);
  }
  set lineJoin(j: string) {
    this.state.join = j;
    this.out.push(['P', CAPS[this.state.cap] ?? 0, JOINS[j] ?? 0]);
  }
  private dash: number[] = [];
  private dashOffset = 0;
  setLineDash(d: number[]) {
    this.dash = d;
    this.out.push(['D', d.length, ...d, this.dashOffset]);
  }
  set lineDashOffset(o: number) {
    this.dashOffset = o;
    this.out.push(['D', this.dash.length, ...this.dash, o]);
  }
  /** "hole" fills are painted solid live (CanvasPage); other modes are not used by live drawings. */
  globalCompositeOperation = 'source-over';
  font = '';
  textBaseline = 'alphabetic';

  save() {
    this.stack.push({ ...this.state });
    this.out.push(['S']);
  }
  restore() {
    this.state = this.stack.pop() ?? this.state;
    this.out.push(['R']);
  }
  beginPath() {
    this.path = new RecPath();
  }
  moveTo(x: number, y: number) {
    this.path.moveTo(x, y);
  }
  lineTo(x: number, y: number) {
    this.path.lineTo(x, y);
  }
  arc(cx: number, cy: number, r: number, a0: number, a1: number, ccw = false) {
    this.path.arc(cx, cy, r, a0, a1, ccw);
  }
  rect(x: number, y: number, w: number, h: number) {
    this.path.rect(x, y, w, h);
  }
  roundRect(x: number, y: number, w: number, h: number) {
    this.path.rect(x, y, w, h);
  }
  closePath() {
    this.path.closePath();
  }
  private use(a: unknown, b: unknown, op: string) {
    const path = a instanceof RecPath ? a : this.path;
    const rule = (a instanceof RecPath ? b : a) === 'evenodd' ? 1 : 0;
    this.out.push(['N'], ...path.ops, op === 's' ? ['s'] : [op, rule]);
  }
  fill(a?: unknown, b?: unknown) {
    this.use(a, b, 'f');
  }
  stroke(a?: unknown) {
    this.use(a, undefined, 's');
  }
  clip(a?: unknown, b?: unknown) {
    this.use(a, b, 'x');
  }
  clearRect() {}
  fillText() {}
  measureText() {
    return { width: 0 };
  }
}

/** Coordinates and lengths of each command, in page px (the rest are angles, flags, colours). */
const SPEC: Record<string, string> = { M: 'xy', L: 'xy', Q: 'xyxy', C: 'xyxyxy', E: 'xyl--', X: 'xyll', W: 'l' };

const n2 = (v: number) => String(Math.round(v * 100) / 100);
/** Angles, alpha, colours: 4 decimals (a full circle must still close). */
const n4 = (v: number) => String(Math.round(v * 10000) / 10000);

/** Runs `draw` on a recording context; returns its commands in the shell's view units. */
export function record(tf: InkTransform, draw: (ctx: CanvasRenderingContext2D) => void): string {
  const ctx = new RecCtx();
  withPathFactory(() => new RecPath() as unknown as Path2D, () => draw(ctx as unknown as CanvasRenderingContext2D));
  const tokens: string[] = [];
  for (const op of ctx.out) {
    const [name, ...args] = op as [string, ...number[]];
    tokens.push(name);
    if (name === 'D') {
      const n = args[0];
      tokens.push(String(n), ...args.slice(1, 1 + n).map((v) => n2(v * tf.k)), n2(args[1 + n] * tf.k));
      continue;
    }
    const spec = SPEC[name] ?? '';
    args.forEach((v, i) => {
      const c = spec[i];
      tokens.push(c === 'x' ? n2(tf.ox + v * tf.k) : c === 'y' ? n2(tf.oy + v * tf.k) : c === 'l' ? n2(v * tf.k) : n4(v));
    });
  }
  return tokens.join(',');
}
