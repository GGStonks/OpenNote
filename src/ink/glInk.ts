import { Stroke } from '../types';
import { XY } from './spline';
import { strokeGlGeometry } from './strokeRenderer';

/**
 * The ink drawn by the GPU, from its vectors, on every frame of a pinch (usePinchInk.ts): sharp at
 * every zoom while the fingers move, where the page's canvases and tiles were bitmaps stretched
 * until the fingers lifted. The geometry is prepared once (a buffer of round-ended pieces, see
 * strokeGlGeometry) and every frame only changes one transform.
 *
 * A piece (two circles and the lines tangent to both) is a quad whose fragments measure their
 * distance to its outline: the edge is antialiased at the screen's resolution, whatever the zoom.
 * Ink is drawn as coverage into a texture first, keeping the most of its pieces at each pixel, then
 * laid on in its colour: blended one over another, the soft edges of a stroke's many overlapping
 * pieces darkened each other and the line looked bolder than the canvas's. Opaque strokes of one
 * colour in a row go together (a note in one ink is one pass); a see-through stroke (highlighter,
 * opacity) goes alone, as the canvas draws it (overlapping strokes darken, a stroke does not). Fills
 * (even-odd) go through the stencil: solid, hatched, or holes that clear what is under them.
 * Order as the page draws its layers (editor/zorder.ts): layer by layer, bottom first, and in each
 * as drawStrokes: highlighters, fills, ink (merged into one drawStrokes order, a fill made after
 * ink of an earlier layer went under it while zooming, and over it again after).
 */

export interface GlTransform {
  /** Canvas px per surface px. */
  scale: number;
  /** Canvas px of the surface's origin. */
  ox: number;
  oy: number;
  /**
   * The linear part instead of `scale` (a, b, c, d as a canvas transform: x' = a x + c y + ox,
   * y' = b x + d y + oy): a selection being moved, stretched or turned. `scale` is then the mean
   * scale (edges are antialiased at it).
   */
  m?: [number, number, number, number];
}

/** The transform's linear part. */
const linear = (tf: GlTransform): [number, number, number, number] => tf.m ?? [tf.scale, 0, 0, tf.scale];

export type RGBA = [number, number, number, number];
interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
type Op =
  | { k: 'see'; first: number; count: number; rgba: RGBA; box: Box }
  | { k: 'fill'; first: number; count: number; mode: 'solid' | 'hole' | 'hatch'; rgba: RGBA; box: Box; hatchFirst: number; hatchCount: number }
  | { k: 'tri'; first: number; count: number; rgba: RGBA };

/** Floats per piece: ax, ay, ra, bx, by, rb, r, g, b, a. */
const CAP = 10;
const HATCH_SPACING = 8;

const VS_CAPS = `#version 300 es
layout(location = 0) in vec2 corner;
layout(location = 1) in vec3 a;
layout(location = 2) in vec3 b;
layout(location = 3) in vec4 col;
uniform mat2 u_m;
uniform vec2 u_t;
uniform float u_px;
uniform float u_glowPad;
uniform vec2 u_size;
out vec2 v_p;
flat out vec3 v_a;
flat out vec3 v_b;
flat out vec4 v_col;
void main() {
  // A quad along the piece, just around it (an axis-aligned box drew up to twice the pixels).
  float R = max(a.z, b.z) + (1.5 + u_glowPad) / u_px;
  vec2 ab = b.xy - a.xy;
  float L = length(ab);
  vec2 u = L > 1e-6 ? ab / L : vec2(1.0, 0.0);
  v_p = a.xy + u * mix(-R, L + R, corner.x) + vec2(-u.y, u.x) * mix(-R, R, corner.y);
  v_a = a;
  v_b = b;
  v_col = col;
  vec2 d = u_m * v_p + u_t;
  gl_Position = vec4(d.x / u_size.x * 2.0 - 1.0, 1.0 - d.y / u_size.y * 2.0, 0.0, 1.0);
}`;

const FS_CAPS = `#version 300 es
precision highp float;
in vec2 v_p;
flat in vec3 v_a;
flat in vec3 v_b;
flat in vec4 v_col;
uniform float u_px;
uniform int u_cov;
uniform float u_glow;
out vec4 o;
float cro(vec2 x, vec2 y) { return x.x * y.y - x.y * y.x; }
// Distance to the outline of two circles and the lines tangent to both (negative inside).
float sdPiece(vec2 p, vec2 pa, vec2 pb, float ra, float rb) {
  vec2 ba = pb - pa;
  float h = dot(ba, ba);
  float dr = ra - rb;
  if (h <= dr * dr + 1e-9) return ra >= rb ? length(p - pa) - ra : length(p - pb) - rb;
  p -= pa;
  vec2 q = vec2(dot(p, vec2(ba.y, -ba.x)), dot(p, ba)) / h;
  q.x = abs(q.x);
  vec2 c = vec2(sqrt(h - dr * dr), dr);
  float k = cro(c, q);
  float m = dot(c, q);
  float n = dot(q, q);
  if (k < 0.0) return sqrt(h * n) - ra;
  if (k > c.x) return sqrt(h * (n + 1.0 - 2.0 * q.y)) - rb;
  return m - ra;
}
void main() {
  float d = sdPiece(v_p, v_a.xy, v_b.xy, v_a.z, v_b.z);
  // A glow (selection): the shadow a canvas casts with shadowBlur u_glow (a Gaussian of sigma
  // u_glow / 2) for a line of this piece's width: the blur of a strip 2r wide, the difference of
  // its two edges' (logistic approximation of the normal distribution). A thin line's is faint.
  float sg = u_glow * 0.5, rr = v_a.z + v_b.z;
  float cov = u_glow > 0.0 ? 1.0 / (1.0 + exp(1.702 * d / sg)) - 1.0 / (1.0 + exp(1.702 * (d + rr) / sg)) : clamp(0.5 - d * u_px, 0.0, 1.0);
  if (cov <= 0.004) discard;
  o = u_cov == 1 ? vec4(cov, 0.0, 0.0, cov) : vec4(v_col.rgb * v_col.a * cov, v_col.a * cov);
}`;

const VS_FLAT = `#version 300 es
layout(location = 0) in vec2 pos;
uniform mat2 u_m;
uniform vec2 u_t;
uniform vec2 u_size;
void main() {
  vec2 d = u_m * pos + u_t;
  gl_Position = vec4(d.x / u_size.x * 2.0 - 1.0, 1.0 - d.y / u_size.y * 2.0, 0.0, 1.0);
}`;

const FS_FLAT = `#version 300 es
precision highp float;
uniform vec4 u_col;
out vec4 o;
void main() { o = u_col; }`;

const VS_FULL = `#version 300 es
layout(location = 0) in vec2 pos;
void main() { gl_Position = vec4(pos, 0.0, 1.0); }`;

const FS_COMPOSE = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform vec4 u_col;
out vec4 o;
void main() { o = u_col * texelFetch(u_tex, ivec2(gl_FragCoord.xy), 0).r; }`;

let rgbaCtx: CanvasRenderingContext2D | null = null;
const parsed = new Map<string, RGBA>();
/** Any CSS colour as r, g, b, a (0-1), times `alpha`. */
function rgba(color: string, alpha: number): RGBA {
  let c = parsed.get(color);
  if (!c) {
    rgbaCtx ??= document.createElement('canvas').getContext('2d');
    if (!rgbaCtx) return [0, 0, 0, alpha];
    rgbaCtx.fillStyle = '#000';
    rgbaCtx.fillStyle = color;
    const v = String(rgbaCtx.fillStyle);
    const m = v.startsWith('#') ? [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16), 1] : (v.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 1]);
    parsed.set(color, (c = [(m[0] ?? 0) / 255, (m[1] ?? 0) / 255, (m[2] ?? 0) / 255, m[3] ?? 1]));
  }
  return [c[0], c[1], c[2], c[3] * alpha];
}

function boxOfCaps(caps: number[], from: number, to: number): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = from; i < to; i += 6) {
    const r = Math.max(caps[i + 2], caps[i + 5]);
    x0 = Math.min(x0, caps[i] - r, caps[i + 3] - r);
    y0 = Math.min(y0, caps[i + 1] - r, caps[i + 4] - r);
    x1 = Math.max(x1, caps[i] + r, caps[i + 3] + r);
    y1 = Math.max(y1, caps[i + 1] + r, caps[i + 4] + r);
  }
  return { x0, y0, x1, y1 };
}

function boxOfPoints(pts: XY[]): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x0, y0, x1, y1 };
}

type Geo = ReturnType<typeof strokeGlGeometry>;
/** Each stroke's GPU geometry (strokes are immutable; the engine's line and the smooth one are the same). */
const geoCache = new WeakMap<Stroke, Geo>();

function geometry(s: Stroke): Geo {
  let g = geoCache.get(s);
  if (!g) geoCache.set(s, (g = strokeGlGeometry(s)));
  return g;
}

/**
 * Prepares the geometry of `strokes` for at most `budgetMs` (ahead of a pinch, a slice at a time);
 * true once all of it is ready.
 */
export function prepareGlGeometry(strokes: Stroke[], budgetMs: number): boolean {
  const until = performance.now() + budgetMs;
  for (const s of strokes) {
    if (!s.points.length || geoCache.has(s)) continue;
    if (budgetMs <= 0 || performance.now() > until) return false;
    geoCache.set(s, strokeGlGeometry(s));
  }
  return true;
}

/** Vertices at the start of the flat buffer: the box a fill's cover pass draws (set per fill). */
const BOX_VERTICES = 4;

/**
 * The strokes as GPU work: the buffers' contents (growing arrays) and the draw order. Strokes
 * added at the end of the note (what writing does) are added to it, not built again from the
 * start (`ink`); anything else builds it anew.
 */
class Builder {
  caps = new Float32Array(CAP * 4096);
  pieces = 0;
  flat = new Float32Array(2 * 256);
  verts = BOX_VERTICES;
  ops: Op[] = [];
  /** Each stroke's pieces, for its own glow (a selection's: drawn stroke by stroke, as a canvas casts shadows). */
  strokes: { first: number; count: number; box: Box }[] = [];
  /** The ink run still open (the last op): opaque strokes of its colour that follow join it. */
  private run: Extract<Op, { k: 'see' }> | null = null;

  private room(nPieces: number, nVerts: number) {
    if ((this.pieces + nPieces) * CAP > this.caps.length) {
      const grown = new Float32Array(Math.max((this.pieces + nPieces) * CAP, Math.ceil(this.caps.length * 1.5)));
      grown.set(this.caps.subarray(0, this.pieces * CAP));
      this.caps = grown;
    }
    if ((this.verts + nVerts) * 2 > this.flat.length) {
      const grown = new Float32Array(Math.max((this.verts + nVerts) * 2, Math.ceil(this.flat.length * 1.5)));
      grown.set(this.flat.subarray(0, this.verts * 2));
      this.flat = grown;
    }
  }

  private pushCaps(c: number[], col: RGBA) {
    this.room(c.length / 6, 0);
    const first = this.pieces, caps = this.caps;
    for (let i = 0; i < c.length; i += 6) {
      const o = this.pieces++ * CAP;
      caps[o] = c[i];
      caps[o + 1] = c[i + 1];
      caps[o + 2] = c[i + 2];
      caps[o + 3] = c[i + 3];
      caps[o + 4] = c[i + 4];
      caps[o + 5] = c[i + 5];
      caps[o + 6] = col[0];
      caps[o + 7] = col[1];
      caps[o + 8] = col[2];
      caps[o + 9] = col[3];
    }
    return { first, count: this.pieces - first };
  }

  private pushFlat(pts: XY[]) {
    this.room(0, pts.length);
    const first = this.verts;
    for (const p of pts) {
      this.flat[this.verts * 2] = p.x;
      this.flat[this.verts * 2 + 1] = p.y;
      this.verts++;
    }
    return first;
  }

  /** A highlighter, laid on as one see-through shape. */
  highlighter(s: Stroke) {
    const { caps: c } = geometry(s);
    if (!c.length) return;
    const { first, count } = this.pushCaps(c, [0, 0, 0, 1]);
    const box = boxOfCaps(c, 0, c.length);
    this.ops.push({ k: 'see', first, count, rgba: rgba(s.color, s.highlightAlpha ?? 0.35), box });
    this.strokes.push({ first, count, box });
    this.run = null;
  }

  /** A stroke's fill (even-odd, through the stencil). */
  fill(s: Stroke) {
    const { area } = geometry(s);
    if (!area || area.length < 3) return;
    const first = this.pushFlat(area);
    const box = boxOfPoints(area);
    const mode = s.fill === 'solid' ? 'solid' : s.fill === 'hole' ? 'hole' : 'hatch';
    let hatchFirst = 0, hatchCount = 0;
    if (mode === 'hatch') {
      const h = box.y1 - box.y0, lines: number[] = [];
      for (let x = box.x0 - h; x < box.x1 + h; x += HATCH_SPACING) {
        if (s.fill === 'northEast' || s.fill === 'crosshatch') lines.push(x, box.y1, 0.55, x + h, box.y0, 0.55);
        if (s.fill === 'northWest' || s.fill === 'crosshatch') lines.push(x, box.y0, 0.55, x + h, box.y1, 0.55);
      }
      ({ first: hatchFirst, count: hatchCount } = this.pushCaps(lines, rgba(s.color, 0.5)));
    }
    this.ops.push({ k: 'fill', first, count: area.length, mode, rgba: mode === 'solid' ? rgba(s.color, 0.22) : rgba(s.color, 1), box, hatchFirst, hatchCount });
    this.run = null;
  }

  /** A stroke's ink: opaque strokes of one colour in a row together, a see-through one alone. */
  ink(s: Stroke) {
    const { caps: c, arrow } = geometry(s);
    const col = rgba(s.color, s.opacity ?? 1);
    if (c.length) {
      const opaque = col[3] >= 0.999;
      const r = this.run;
      const join = opaque && r && this.ops[this.ops.length - 1] === r && r.rgba[0] === col[0] && r.rgba[1] === col[1] && r.rgba[2] === col[2] && r.rgba[3] === col[3];
      const at = this.pushCaps(c, [0, 0, 0, 1]);
      const box = boxOfCaps(c, 0, c.length);
      this.strokes.push({ first: at.first, count: at.count, box });
      if (join && r) {
        r.count += at.count;
        r.box = { x0: Math.min(r.box.x0, box.x0), y0: Math.min(r.box.y0, box.y0), x1: Math.max(r.box.x1, box.x1), y1: Math.max(r.box.y1, box.y1) };
      } else {
        const op: Extract<Op, { k: 'see' }> = { k: 'see', first: at.first, count: at.count, rgba: col, box };
        this.ops.push(op);
        this.run = opaque ? op : null;
      }
    }
    if (arrow) {
      this.ops.push({ k: 'tri', first: this.pushFlat(arrow), count: 3, rgba: col });
      this.run = null;
    }
  }

  /** The ink layers bottom first, each in drawStrokes' order: highlighters, fills, ink. */
  static of(layers: readonly Stroke[][]): Builder {
    const b = new Builder();
    for (const strokes of layers) {
      for (const s of strokes) if (s.tool === 'highlighter' && s.points.length) b.highlighter(s);
      for (const s of strokes) if (s.tool !== 'highlighter' && s.fill && s.fill !== 'none' && s.points.length) b.fill(s);
      for (const s of strokes) if (s.tool !== 'highlighter' && s.points.length) b.ink(s);
    }
    return b;
  }
}

/**
 * Whether `next` is `prev` with strokes added at the end of its top layer that only add ink (no
 * highlighter, no fill): appended to what is built.
 */
function appendsInk(prev: readonly Stroke[][], next: readonly Stroke[][]): boolean {
  if (!prev.length || prev.length !== next.length) return false;
  for (let i = 0; i < prev.length - 1; i++) if (prev[i] !== next[i]) return false;
  return appendsTo(prev[prev.length - 1], next[next.length - 1]);
}

function appendsTo(prev: Stroke[], next: Stroke[]): boolean {
  if (next.length <= prev.length) return false;
  for (let i = 0; i < prev.length; i++) if (prev[i] !== next[i]) return false;
  for (let i = prev.length; i < next.length; i++) {
    const s = next[i];
    if (s.tool === 'highlighter' || (s.fill && s.fill !== 'none')) return false;
  }
  return true;
}

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram | null {
  const prog = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
    const sh = gl.createShader(type);
    if (!sh || !prog) return null;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.warn('glInk shader:', gl.getShaderInfoLog(sh));
      return null;
    }
    gl.attachShader(prog, sh);
  }
  gl.linkProgram(prog!);
  return gl.getProgramParameter(prog!, gl.LINK_STATUS) ? prog : null;
}

export class GlInk {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private caps: WebGLProgram;
  private flatProg: WebGLProgram;
  private compose: WebGLProgram;
  private capVao: WebGLVertexArrayObject;
  private capBuf: WebGLBuffer;
  private flatVao: WebGLVertexArrayObject;
  private flatBuf: WebGLBuffer;
  private fullVao: WebGLVertexArrayObject;
  private quadBuf: WebGLBuffer;
  private builder: Builder | null = null;
  /** What of the builder's arrays the GPU buffers hold, and how much they can hold. */
  private sent = { pieces: 0, verts: 0, capsRoom: 0, flatRoom: 0 };
  private ops: Op[] = [];
  private fbo: WebGLFramebuffer | null = null;
  private tex: WebGLTexture | null = null;
  private texSize = { w: 0, h: 0 };
  /** The ink layers built (bottom first). */
  private built: Stroke[][] | null = null;
  /** The browser took the GPU context away (the app in the background, GPU memory): make a new one. */
  lost = false;

  /** The drawing buffer's size (px): smaller than the canvas where the browser could not allocate it. */
  get bufferSize(): { w: number; h: number } {
    return { w: this.gl.drawingBufferWidth, h: this.gl.drawingBufferHeight };
  }

  /** null where WebGL 2 is not available. */
  static create(): GlInk | null {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, stencil: true, depth: false, preserveDrawingBuffer: false });
    if (!gl) return null;
    const caps = compile(gl, VS_CAPS, FS_CAPS), flat = compile(gl, VS_FLAT, FS_FLAT), compose = compile(gl, VS_FULL, FS_COMPOSE);
    if (!caps || !flat || !compose) return null;
    return new GlInk(canvas, gl, caps, flat, compose);
  }

  private constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext, caps: WebGLProgram, flat: WebGLProgram, compose: WebGLProgram) {
    this.canvas = canvas;
    this.gl = gl;
    canvas.addEventListener('webglcontextlost', () => (this.lost = true));
    this.caps = caps;
    this.flatProg = flat;
    this.compose = compose;
    // The quad's corners, shared by the pieces (per instance) and the full-canvas pass.
    this.quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    this.capVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.capVao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.capBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.capBuf);
    for (const loc of [1, 2, 3]) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribDivisor(loc, 1);
    }
    this.flatVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.flatVao);
    this.flatBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.flatBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.fullVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.fullVao);
    const full = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, full);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  /** Pieces in the buffer (for the benchmark). */
  pieces = 0;

  /**
   * Prepares `strokes` for drawing. Strokes added at the end (writing) are added to what is there,
   * sending the GPU only the new part; any other change builds it all again.
   */
  setStrokes(layers: readonly Stroke[][]) {
    const built = this.built;
    if (built && built.length === layers.length && built.every((l, i) => l === layers[i])) return;
    let b = this.builder;
    if (b && built && appendsInk(built, layers)) {
      const prev = built[built.length - 1], top = layers[layers.length - 1];
      for (let i = prev.length; i < top.length; i++) if (top[i].points.length) b.ink(top[i]);
    } else {
      b = this.builder = Builder.of(layers);
      this.sent = { pieces: 0, verts: 0, capsRoom: 0, flatRoom: 0 };
    }
    this.built = layers.slice();
    const gl = this.gl, sent = this.sent;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.capBuf);
    if (b.caps.length > sent.capsRoom) {
      gl.bufferData(gl.ARRAY_BUFFER, b.caps, gl.DYNAMIC_DRAW);
      sent.capsRoom = b.caps.length;
    } else if (b.pieces > sent.pieces) {
      gl.bufferSubData(gl.ARRAY_BUFFER, sent.pieces * CAP * 4, b.caps, sent.pieces * CAP, (b.pieces - sent.pieces) * CAP);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.flatBuf);
    if (b.flat.length > sent.flatRoom) {
      gl.bufferData(gl.ARRAY_BUFFER, b.flat, gl.DYNAMIC_DRAW);
      sent.flatRoom = b.flat.length;
    } else if (b.verts > sent.verts) {
      gl.bufferSubData(gl.ARRAY_BUFFER, sent.verts * 8, b.flat, sent.verts * 2, (b.verts - sent.verts) * 2);
    }
    sent.pieces = b.pieces;
    sent.verts = b.verts;
    this.ops = b.ops;
    this.pieces = b.pieces;
  }

  /** The canvas's size in its pixels (0 x 0 frees its memory between pinches). */
  resize(w: number, h: number) {
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    if (w === 1 && h === 1) this.dropCoverage();
  }

  private dropCoverage() {
    const gl = this.gl;
    if (this.fbo) gl.deleteFramebuffer(this.fbo);
    if (this.tex) gl.deleteTexture(this.tex);
    this.fbo = this.tex = null;
    this.texSize = { w: 0, h: 0 };
  }

  private coverage(): boolean {
    const gl = this.gl, w = this.canvas.width, h = this.canvas.height;
    if (this.fbo && this.texSize.w === w && this.texSize.h === h) return true;
    this.dropCoverage();
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!ok) this.dropCoverage();
    this.texSize = { w, h };
    return ok;
  }

  private pointCaps(first: number) {
    const gl = this.gl, stride = CAP * 4, base = first * stride;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.capBuf);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, base);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, stride, base + 12);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, base + 24);
  }

  /** The box in canvas px (y up, for the scissor), clipped to the canvas; null when off it. */
  private scissor(b: Box, tf: GlTransform, pad = 0): [number, number, number, number] | null {
    const w = this.canvas.width, h = this.canvas.height;
    const [a, bb, c, d] = linear(tf);
    const xs: number[] = [], ys: number[] = [];
    for (const [x, y] of [[b.x0 - pad, b.y0 - pad], [b.x1 + pad, b.y0 - pad], [b.x0 - pad, b.y1 + pad], [b.x1 + pad, b.y1 + pad]]) {
      xs.push(a * x + c * y + tf.ox);
      ys.push(bb * x + d * y + tf.oy);
    }
    const x0 = Math.max(0, Math.floor(Math.min(...xs)) - 2), x1 = Math.min(w, Math.ceil(Math.max(...xs)) + 2);
    const y0 = Math.max(0, Math.floor(Math.min(...ys)) - 2), y1 = Math.min(h, Math.ceil(Math.max(...ys)) + 2);
    if (x1 <= x0 || y1 <= y0) return null;
    return [x0, h - y1, x1 - x0, y1 - y0];
  }

  private uniforms(prog: WebGLProgram, tf: GlTransform, glow = 0) {
    const gl = this.gl;
    gl.useProgram(prog);
    gl.uniformMatrix2fv(gl.getUniformLocation(prog, 'u_m'), false, linear(tf));
    gl.uniform2f(gl.getUniformLocation(prog, 'u_t'), tf.ox, tf.oy);
    gl.uniform1f(gl.getUniformLocation(prog, 'u_px'), tf.scale);
    gl.uniform1f(gl.getUniformLocation(prog, 'u_glow'), glow);
    gl.uniform1f(gl.getUniformLocation(prog, 'u_glowPad'), glow * 2 * tf.scale);
    gl.uniform2f(gl.getUniformLocation(prog, 'u_size'), this.canvas.width, this.canvas.height);
  }

  /**
   * Every kind of draw once, on a 1 x 1 canvas: the GPU driver compiles each pipeline (blending,
   * stencil) the first time it is used, which held up the first frame of the first pinch.
   */
  warm() {
    const ops = this.ops;
    if (!this.builder) return;
    const piece = { first: 0, count: Math.min(1, this.pieces) };
    const box = { x0: -1, y0: -1, x1: 2, y1: 2 };
    this.ops = [
      { k: 'see', ...piece, rgba: [0, 0, 0, 1], box },
      { k: 'fill', first: 0, count: 3, mode: 'solid', rgba: [0, 0, 0, 1], box, hatchFirst: 0, hatchCount: piece.count },
      { k: 'fill', first: 0, count: 3, mode: 'hole', rgba: [0, 0, 0, 1], box, hatchFirst: 0, hatchCount: 0 },
      { k: 'fill', first: 0, count: 3, mode: 'hatch', rgba: [0, 0, 0, 1], box, hatchFirst: 0, hatchCount: piece.count },
      { k: 'tri', first: 0, count: 3, rgba: [0, 0, 0, 1] },
    ];
    this.resize(1, 1);
    this.draw({ scale: 1, ox: 0, oy: 0 });
    this.gl.finish();
    this.ops = ops;
  }

  /**
   * Pieces [first, first + count) as one shape: their coverage (the most at each pixel) into the
   * coverage texture, then laid on in `rgba` (over `box`, or the whole canvas). `glow` (page px): a
   * soft falloff around them instead of an antialiased edge.
   */
  private layOn(first: number, count: number, rgba: RGBA, box: Box | null, tf: GlTransform, glow = 0) {
    const gl = this.gl;
    const sc = box ? this.scissor(box, tf, glow * 2) : [0, 0, this.canvas.width, this.canvas.height] as [number, number, number, number];
    if (!sc || !count || !this.coverage()) return;
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(...sc);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.blendEquation(gl.MAX);
    this.uniforms(this.caps, tf, glow);
    gl.uniform1i(gl.getUniformLocation(this.caps, 'u_cov'), 1);
    gl.bindVertexArray(this.capVao);
    this.pointCaps(first);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.blendEquation(gl.FUNC_ADD);
    gl.useProgram(this.compose);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(gl.getUniformLocation(this.compose, 'u_tex'), 0);
    const [r, g, b, a] = rgba;
    gl.uniform4f(gl.getUniformLocation(this.compose, 'u_col'), r * a, g * a, b * a, a);
    gl.bindVertexArray(this.fullVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disable(gl.SCISSOR_TEST);
  }

  /** Draws the strokes; `glow`: a selection's glow (page px, colour) under them. */
  draw(tf: GlTransform, glow?: { radius: number; rgba: RGBA }) {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.colorMask(true, true, true, true);
    gl.clearColor(0, 0, 0, 0);
    gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    // A selection's glow, stroke by stroke laid over one another (the strongest of all pieces at
    // each pixel left a lighter crease between strokes close together).
    if (glow) for (const st of this.builder?.strokes ?? []) this.layOn(st.first, st.count, glow.rgba, st.box, tf, glow.radius);
    for (const op of this.ops) {
      if (op.k === 'see') {
        this.layOn(op.first, op.count, op.rgba, op.box, tf);
      } else if (op.k === 'fill') {
        const sc = this.scissor(op.box, tf);
        if (!sc) continue;
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(...sc);
        gl.enable(gl.STENCIL_TEST);
        // Even-odd: each triangle of a fan from the first corner flips the stencil.
        this.uniforms(this.flatProg, tf);
        gl.bindVertexArray(this.flatVao);
        gl.colorMask(false, false, false, false);
        gl.stencilFunc(gl.ALWAYS, 0, 0xff);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
        gl.drawArrays(gl.TRIANGLE_FAN, op.first, op.count);
        gl.colorMask(true, true, true, true);
        gl.stencilFunc(gl.NOTEQUAL, 0, 0xff);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
        if (op.mode === 'hatch') {
          this.uniforms(this.caps, tf);
          gl.uniform1i(gl.getUniformLocation(this.caps, 'u_cov'), 0);
          gl.bindVertexArray(this.capVao);
          this.pointCaps(op.hatchFirst);
          gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, op.hatchCount);
        } else {
          const b = op.box;
          gl.bindBuffer(gl.ARRAY_BUFFER, this.flatBuf);
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array([b.x0, b.y0, b.x1, b.y0, b.x0, b.y1, b.x1, b.y1]));
          const [r, g, bl, a] = op.rgba;
          if (op.mode === 'hole') {
            gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
            gl.uniform4f(gl.getUniformLocation(this.flatProg, 'u_col'), 0, 0, 0, 1);
          } else gl.uniform4f(gl.getUniformLocation(this.flatProg, 'u_col'), r * a, g * a, bl * a, a);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, BOX_VERTICES);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        }
        gl.clear(gl.STENCIL_BUFFER_BIT);
        gl.disable(gl.STENCIL_TEST);
        gl.disable(gl.SCISSOR_TEST);
      } else {
        this.uniforms(this.flatProg, tf);
        const [r, g, b, a] = op.rgba;
        gl.uniform4f(gl.getUniformLocation(this.flatProg, 'u_col'), r * a, g * a, b * a, a);
        gl.bindVertexArray(this.flatVao);
        gl.drawArrays(gl.TRIANGLES, op.first, op.count);
      }
    }
    gl.bindVertexArray(null);
  }
}
