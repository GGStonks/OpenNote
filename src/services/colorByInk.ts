import katex from 'katex';
import { Stroke } from '../types';
import { normalizeHex } from '../components/ColorPicker';
import { InkColorInfo, groupEnd, inkColors } from './inkColors';
import { cleanModelOutput, katexCompat, looksLikeBareMath } from './latexRender';

/**
 * Colours of a transcribed formula taken from the ink, not from the model. The model was asked to
 * write each symbol in the colour it is drawn in, but it reads colours from the image unreliably
 * (white ink is grey there, very dark green on dark paper near black): symbols came back in the
 * wrong colour, differently each time. Here the model's colours are dropped and each symbol takes
 * the colour of the ink it was read from:
 *
 *  1. the formula is parsed into symbols (atoms), keeping its structure (fractions, roots,
 *     \left..\right, environments: containers whose own ink is the bar, the radical, the brackets);
 *  2. it is laid out by KaTeX with each symbol tagged, and the symbols' boxes measured;
 *  3. the layout is mapped onto the ink's bounding box, and symbols and strokes are put in reading
 *     order (columns left to right, top to bottom within a column) and aligned by dynamic time
 *     warping: handwriting is spaced differently from type, the order is the same;
 *  4. a symbol takes the colour of the nearest stroke aligned with it; a container the colour of
 *     the longest stroke inside it that no symbol took (the fraction bar, the radical).
 *
 * Only for a formula (math, or notes that are one formula); null otherwise or if anything fails,
 * and the model's colours are used (enforceColors).
 */

type Script = { mark: '^' | '_'; arg: Node };
type Node =
  | { k: 'raw'; src: string }
  | { k: 'atom'; id: number; src: string; scripts: Script[] }
  | { k: 'grp'; kids: Node[]; scripts: Script[] }
  /** Containers: `head` + args, each braced (\frac{..}{..}, \sqrt[..]{..}), or \left..\right / environments (open, kids, close). */
  | { k: 'cmd'; id: number; head: string; opt: Node[] | null; args: Node[][]; scripts: Script[] }
  | { k: 'wrap'; id: number; open: string; kids: Node[]; close: string; scripts: Script[] };

/** One argument, the whole symbol (fonts, accents, text). */
const WHOLE_1 = new Set(
  'text textrm textbf textit textsf texttt textnormal mathrm mathbf mathit mathsf mathtt mathcal mathbb mathfrak mathscr mathnormal boldsymbol pmb operatorname vec hat bar tilde dot ddot dddot check breve acute grave widehat widetilde overline underline overrightarrow overleftarrow overleftrightarrow mathring mathop mathbin mathrel mathord mathopen mathclose mathpunct mathinner'.split(' ')
);
const TWO_ARGS = new Set('frac dfrac tfrac cfrac binom dbinom tbinom overset underset stackrel'.split(' '));
const ONE_ARG_BOX = new Set('underbrace overbrace boxed cancel bcancel xcancel'.split(' '));
/** No ink of their own (spacing, style). */
const NO_INK = new Set('quad qquad enspace thinspace medspace thickspace negthinspace negmedspace negthickspace displaystyle textstyle scriptstyle scriptscriptstyle limits nolimits nonumber notag middle'.split(' '));
const NO_INK_ARG = new Set('hspace vspace hspace* phantom hphantom vphantom label tag'.split(' '));
const ENV_ARG = new Set('array alignat alignat* subarray tabular'.split(' '));

class Parser {
  i = 0;
  next = 0;
  constructor(private s: string) {}

  private ws(): string {
    const m = /^\s+/.exec(this.s.slice(this.i));
    if (!m) return '';
    this.i += m[0].length;
    return m[0];
  }

  /** A command's name at i (just past the backslash is i + 1). */
  private name(): string {
    const m = /^\\([A-Za-z]+\*?|.)/.exec(this.s.slice(this.i));
    return m ? m[1] : '';
  }

  /** The source of one argument token (a group or a single token), consumed. */
  private argSrc(): string {
    this.ws();
    const c = this.s[this.i];
    if (c === '{') {
      const end = groupEnd(this.s, this.i);
      const e = end > 0 ? end : this.s.length;
      const src = this.s.slice(this.i, e);
      this.i = e;
      return src;
    }
    if (c === '\\') {
      const n = this.name();
      this.i += 1 + n.length;
      return '\\' + n;
    }
    this.i++;
    return c ?? '';
  }

  /** One argument parsed into nodes (the inside of a group, or one token). */
  private argNodes(): Node[] {
    this.ws();
    if (this.s[this.i] === '{') {
      this.i++;
      const kids = this.seq();
      if (this.s[this.i] === '}') this.i++;
      return kids;
    }
    const n = this.token();
    return n ? [n] : [];
  }

  private scripts(): Script[] {
    const out: Script[] = [];
    for (;;) {
      const save = this.i;
      this.ws();
      const c = this.s[this.i];
      if (c !== '^' && c !== '_') {
        this.i = save;
        return out;
      }
      this.i++;
      this.ws();
      let arg: Node;
      if (this.s[this.i] === '{') {
        this.i++;
        const kids = this.seq();
        if (this.s[this.i] === '}') this.i++;
        arg = { k: 'grp', kids, scripts: [] };
      } else arg = this.token() ?? { k: 'raw', src: '' };
      out.push({ mark: c, arg });
    }
  }

  /** Nodes until a closing brace, \right, \end or the end. */
  seq(): Node[] {
    const out: Node[] = [];
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (c === '}') break;
      if (c === '\\') {
        const n = this.name();
        if (n === 'right' || n === 'end') break;
      }
      const w = this.ws();
      if (w) {
        out.push({ k: 'raw', src: w });
        continue;
      }
      const t = this.token();
      if (t) out.push(t);
    }
    return out;
  }

  /** One token with its scripts. */
  token(): Node | null {
    const s = this.s;
    const c = s[this.i];
    if (c === undefined) return null;
    if (c === '{') {
      this.i++;
      const kids = this.seq();
      if (s[this.i] === '}') this.i++;
      return { k: 'grp', kids, scripts: this.scripts() };
    }
    if (c === '&' || c === '^' || c === '_' || c === '~') {
      this.i++;
      return { k: 'raw', src: c };
    }
    if (c !== '\\') {
      this.i++;
      return { k: 'atom', id: this.next++, src: c, scripts: this.scripts() };
    }
    const n = this.name();
    const start = this.i;
    this.i += 1 + n.length;
    if (n === '\\') {
      // A new row, with an optional [length].
      const m = /^\s*\[[^\]]*\]/.exec(s.slice(this.i));
      if (m) this.i += m[0].length;
      return { k: 'raw', src: s.slice(start, this.i) };
    }
    if (n === ',' || n === ';' || n === ':' || n === '!' || n === ' ' || NO_INK.has(n)) return { k: 'raw', src: '\\' + n + (/[A-Za-z]$/.test(n) ? ' ' : '') };
    if (NO_INK_ARG.has(n)) return { k: 'raw', src: '\\' + n + this.argSrc() };
    if (n === 'left') {
      const open = '\\left' + this.argSrc();
      const kids = this.seq();
      let close = '';
      if (this.name() === 'right') {
        this.i += 6;
        close = '\\right' + this.argSrc();
      }
      return { k: 'wrap', id: this.next++, open, kids, close, scripts: this.scripts() };
    }
    if (n === 'begin') {
      const env = this.argSrc();
      let open = '\\begin' + env;
      if (ENV_ARG.has(env.replace(/[{}]/g, ''))) open += this.argSrc();
      const kids = this.seq();
      let close = '';
      if (this.name() === 'end') {
        this.i += 4;
        close = '\\end' + this.argSrc();
      }
      return { k: 'wrap', id: this.next++, open, kids, close, scripts: this.scripts() };
    }
    if (n === 'not') {
      const rest = this.argSrc();
      return { k: 'atom', id: this.next++, src: '\\not' + (/^\\[A-Za-z]/.test(rest) ? ' ' : '') + rest, scripts: this.scripts() };
    }
    if (WHOLE_1.has(n)) return { k: 'atom', id: this.next++, src: '\\' + n + this.argSrc(), scripts: this.scripts() };
    if (TWO_ARGS.has(n) || ONE_ARG_BOX.has(n) || n === 'sqrt') {
      const id = this.next++;
      let opt: Node[] | null = null;
      if (n === 'sqrt') {
        const m = /^\s*\[/.exec(s.slice(this.i));
        if (m) {
          this.i += m[0].length;
          const sub = new Parser(s.slice(this.i, s.indexOf(']', this.i) < 0 ? s.length : s.indexOf(']', this.i)));
          sub.next = this.next;
          opt = sub.seq();
          this.next = sub.next;
          this.i += sub.i;
          if (s[this.i] === ']') this.i++;
        }
      }
      const args = Array.from({ length: TWO_ARGS.has(n) ? 2 : 1 }, () => this.argNodes());
      return { k: 'cmd', id, head: '\\' + n, opt, args, scripts: this.scripts() };
    }
    // A symbol (\alpha, \int, \log, \{ ...).
    return { k: 'atom', id: this.next++, src: '\\' + n, scripts: this.scripts() };
  }
}

/** The model's colour markup removed (\textcolor{c}{x} -> x, braced where a script or argument needs it; \color{c} dropped). */
export function stripColors(latex: string): string {
  let out = '';
  let i = 0;
  while (i < latex.length) {
    const rest = latex.slice(i, i + 64);
    const tc = /^\\textcolor\s*(?:\[[A-Za-z]+\])?\s*\{[^{}]*\}\s*\{/.exec(rest);
    if (tc) {
      const open = i + tc[0].length - 1;
      const end = groupEnd(latex, open);
      if (end > 0) {
        const inner = stripColors(latex.slice(open + 1, end - 1));
        const before = out.replace(/\s+$/, '');
        const needsBraces = /[\^_]$|\\[A-Za-z]+$/.test(before) || /^[\^_]/.test(latex.slice(end).trimStart());
        out += needsBraces ? `{${inner}}` : inner;
        i = end;
        continue;
      }
    }
    const sw = /^\\color\s*(?:\[[A-Za-z]+\])?\s*\{[^{}]*\}/.exec(rest);
    if (sw) {
      i += sw[0].length;
      continue;
    }
    if (latex[i] === '\\') {
      out += latex.slice(i, i + 2);
      i += 2;
      continue;
    }
    out += latex[i++];
  }
  return out;
}

// ------------------------------------------------------------------------------ emitting

type Emit = (n: Node, inherited: string) => string;

function emitScripts(sc: Script[], inherited: string, emit: Emit): string {
  return sc.map((s) => `${s.mark}{${emit(s.arg, inherited)}}`).join('');
}

/** The formula with a tag on every symbol and container, for measuring. */
function measured(nodes: Node[]): string {
  const emit: Emit = (n) => {
    switch (n.k) {
      case 'raw':
        return n.src;
      case 'atom':
        return `\\htmlClass{oca oca-a oca-${n.id}}{${n.src}}${emitScripts(n.scripts, '', emit)}`;
      case 'grp':
        return `{${n.kids.map((k) => emit(k, '')).join('')}}${emitScripts(n.scripts, '', emit)}`;
      case 'cmd':
        return `\\htmlClass{oca oca-${n.id}}{${n.head}${n.opt ? `[${n.opt.map((k) => emit(k, '')).join('')}]` : ''}${n.args.map((a) => `{${a.map((k) => emit(k, '')).join('')}}`).join('')}}${emitScripts(n.scripts, '', emit)}`;
      case 'wrap':
        return `\\htmlClass{oca oca-${n.id}}{${n.open}${n.kids.map((k) => emit(k, '')).join('')}${n.close}}${emitScripts(n.scripts, '', emit)}`;
    }
  };
  return nodes.map((n) => emit(n, '')).join('');
}

/** The formula with the colours found (`colorOf` by id; null: the colour around it). */
function colored(nodes: Node[], colorOf: Map<number, string | null>, base: string): string {
  const tint = (c: string, inner: string) => `\\textcolor{${c}}{${inner}}`;
  const seq = (list: Node[], inherited: string): string => {
    let out = '';
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      if (n.k === 'atom') {
        const c = colorOf.get(n.id) ?? inherited;
        if (c === inherited) {
          out += n.src + emitScripts(n.scripts, c, emit);
          continue;
        }
        // A run of symbols of this colour, in one group (spaces between them included).
        let run = n.src + emitScripts(n.scripts, c, emit);
        let j = i + 1;
        let pending = '';
        while (j < list.length) {
          const m = list[j];
          if (m.k === 'raw' && !m.src.trim()) {
            pending += m.src;
            j++;
            continue;
          }
          if (m.k !== 'atom' || (colorOf.get(m.id) ?? inherited) !== c) break;
          run += pending + m.src + emitScripts(m.scripts, c, emit);
          pending = '';
          i = j;
          j++;
        }
        out += tint(c, run);
        continue;
      }
      out += emit(n, inherited);
    }
    return out;
  };
  const emit: Emit = (n, inherited) => {
    switch (n.k) {
      case 'raw':
        return n.src;
      case 'atom':
        return seq([n], inherited);
      case 'grp':
        return `{${seq(n.kids, inherited)}}${emitScripts(n.scripts, inherited, emit)}`;
      case 'cmd': {
        const c = colorOf.get(n.id) ?? inherited;
        const body = `${n.head}${n.opt ? `[${seq(n.opt, c)}]` : ''}${n.args.map((a) => `{${seq(a, c)}}`).join('')}`;
        return (c === inherited ? body : tint(c, body)) + emitScripts(n.scripts, inherited, emit);
      }
      case 'wrap': {
        const c = colorOf.get(n.id) ?? inherited;
        const body = `${n.open}${seq(n.kids, c)}${n.close}`;
        return (c === inherited ? body : tint(c, body)) + emitScripts(n.scripts, inherited, emit);
      }
    }
  };
  return seq(nodes, base);
}

// ------------------------------------------------------------------------------ geometry

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
const cx = (b: Box) => (b.x0 + b.x1) / 2;
const cy = (b: Box) => (b.y0 + b.y1) / 2;

/**
 * Reading order: columns of overlapping x extents left to right (`joins` decides whether an item
 * goes into the column before it), top to bottom within each.
 */
function columns<T extends { box: Box }>(items: T[], joins: (it: T, col: T[]) => boolean = () => true): T[][] {
  const byX = [...items].sort((a, b) => a.box.x0 - b.box.x0);
  const cols: { x0: number; x1: number; items: T[] }[] = [];
  for (const it of byX) {
    const col = cols[cols.length - 1];
    const w = it.box.x1 - it.box.x0;
    if (col) {
      const overlap = Math.min(col.x1, it.box.x1) - Math.max(col.x0, it.box.x0);
      if (overlap > 0.5 * Math.min(w, col.x1 - col.x0) && joins(it, col.items)) {
        col.items.push(it);
        col.x0 = Math.min(col.x0, it.box.x0);
        col.x1 = Math.max(col.x1, it.box.x1);
        continue;
      }
    }
    cols.push({ x0: it.box.x0, x1: it.box.x1, items: [it] });
  }
  return cols.map((c) => c.items.sort((a, b) => cy(a.box) - cy(b.box)));
}

/** Dynamic time warping of two sequences; for each `a`, the indexes of the `b` aligned with it. */
function align(n: number, m: number, cost: (i: number, j: number) => number): number[][] {
  const D = new Float64Array((n + 1) * (m + 1)).fill(Infinity);
  const at = (i: number, j: number) => i * (m + 1) + j;
  D[0] = 0;
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++) D[at(i, j)] = cost(i - 1, j - 1) + Math.min(D[at(i - 1, j)], D[at(i, j - 1)], D[at(i - 1, j - 1)]);
  const out: number[][] = Array.from({ length: n }, () => []);
  let i = n, j = m;
  while (i > 0 && j > 0) {
    out[i - 1].push(j - 1);
    const diag = D[at(i - 1, j - 1)], up = D[at(i - 1, j)], left = D[at(i, j - 1)];
    if (diag <= up && diag <= left) {
      i--;
      j--;
    } else if (up <= left) i--;
    else j--;
  }
  return out;
}

interface InkPiece {
  box: Box;
  hex: string;
  len: number;
}

function inkPieces(strokes: Stroke[]): InkPiece[] {
  return strokes
    .filter((s) => s.points.length)
    .map((s) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, len = 0;
      s.points.forEach((p, i) => {
        x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
        if (i) len += Math.hypot(p.x - s.points[i - 1].x, p.y - s.points[i - 1].y);
      });
      return { box: { x0, y0, x1, y1 }, hex: normalizeHex(s.color) ?? '#000000', len: Math.max(len, 1) };
    });
}

let host: HTMLDivElement | null = null;

/** A glyph of the laid-out formula: a character of a symbol, or a bracket drawn by a container. */
interface Unit {
  owner: number;
  box: Box;
}

/**
 * The formula as laid out by KaTeX: each character of each tagged symbol (\log is three letters,
 * as it is three strokes or more), the brackets of \left..\right and environments (their own
 * glyphs), and each container's box (by id).
 */
function measure(src: string): { units: Unit[]; boxes: Map<number, Box> } | null {
  host ??= Object.assign(document.createElement('div'), { ariaHidden: 'true' });
  Object.assign(host.style, { position: 'fixed', left: '-20000px', top: '0', fontSize: '40px', whiteSpace: 'nowrap', visibility: 'hidden', pointerEvents: 'none' });
  if (!host.isConnected) document.body.appendChild(host);
  try {
    katex.render(katexCompat(src), host, {
      displayMode: true,
      throwOnError: true,
      strict: 'ignore',
      output: 'html',
      trust: (ctx) => ctx.command === '\\htmlClass',
    });
  } catch {
    host.textContent = '';
    return null;
  }
  const idOf = (el: Element) => Number([...el.classList].find((c) => /^oca-\d+$/.test(c))?.slice(4));
  const rect = (r: DOMRect): Box | null => (r.width > 0 && r.height > 0 ? { x0: r.left, y0: r.top, x1: r.right, y1: r.bottom } : null);
  const boxes = new Map<number, Box>();
  host.querySelectorAll('.oca').forEach((el) => {
    const b = rect(el.getBoundingClientRect());
    if (b) boxes.set(idOf(el), b);
  });
  const units: Unit[] = [];
  const range = document.createRange();
  const tw = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  const owned = new Set<number>();
  while (tw.nextNode()) {
    const t = tw.currentNode as Text;
    const el = t.parentElement?.closest('.oca');
    if (!el) continue;
    const owner = idOf(el);
    for (let i = 0; i < t.length; i++) {
      if (!t.data[i].trim()) continue;
      range.setStart(t, i);
      range.setEnd(t, i + 1);
      const b = rect(range.getBoundingClientRect());
      if (b) {
        units.push({ owner, box: b });
        owned.add(owner);
      }
    }
  }
  // Symbols drawn without text (an accent's line alone, a box): the whole symbol as one glyph.
  host.querySelectorAll('.oca').forEach((el) => {
    const id = idOf(el), b = boxes.get(id);
    if (b && !owned.has(id) && el.classList.contains('oca-a')) units.push({ owner: id, box: b });
  });
  host.textContent = '';
  return { units, boxes };
}

function walk(nodes: Node[], f: (n: Node) => void) {
  for (const n of nodes) {
    f(n);
    if (n.k === 'grp' || n.k === 'wrap') walk(n.kids, f);
    if (n.k === 'cmd') {
      if (n.opt) walk(n.opt, f);
      n.args.forEach((a) => walk(a, f));
    }
    if (n.k !== 'raw') walk(n.scripts.map((s) => s.arg), f);
  }
}

/** The formula of a reply and how to put it back (the same delimiters), or null for notes with text. */
function formulaOf(reply: string): { tex: string; wrap: (t: string) => string } | null {
  const s = cleanModelOutput(reply).trim();
  const m = /^\$\$([\s\S]+)\$\$$/.exec(s) ?? /^\\\[([\s\S]+)\\\]$/.exec(s) ?? /^\$([^$]+)\$$/.exec(s);
  if (m) {
    const open = s.startsWith('$$') ? '$$' : s.startsWith('\\[') ? '\\[' : '$';
    const close = open === '\\[' ? '\\]' : open;
    return /\$|\\\[/.test(m[1]) ? null : { tex: m[1], wrap: (t) => `${open}${t}${close}` };
  }
  return looksLikeBareMath(stripColors(s)) ? { tex: s, wrap: (t) => t } : null;
}

/** The reply with each symbol in the colour of its ink (see the top of this file), or null. */
export function colorByInk(reply: string, strokes: Stroke[], info: InkColorInfo): string | null {
  if (info.colors.length < 2) return null;
  const f = formulaOf(reply);
  if (!f) return null;
  const src = stripColors(f.tex).trim();
  const p = new Parser(src);
  const nodes = p.seq();
  // Unbalanced (a stray } or \right): not parsed whole.
  if (p.i < src.length) return null;
  const laid = measure(measured(nodes));
  const ink = inkPieces(strokes);
  if (!laid || !laid.units.length || !ink.length) return null;

  // The layout mapped onto the ink's box.
  const span = (bs: Box[]): Box => ({ x0: Math.min(...bs.map((b) => b.x0)), y0: Math.min(...bs.map((b) => b.y0)), x1: Math.max(...bs.map((b) => b.x1)), y1: Math.max(...bs.map((b) => b.y1)) });
  // (Containers included: a root's radical or a fraction's bar can be the formula's edge.)
  const R = span([...laid.units.map((u) => u.box), ...laid.boxes.values()]), I = span(ink.map((s) => s.box));
  const W = Math.max(1, I.x1 - I.x0), H = Math.max(1, I.y1 - I.y0);
  const kx = W / Math.max(1, R.x1 - R.x0), ky = H / Math.max(1, R.y1 - R.y0);
  const map = (b: Box): Box => ({ x0: I.x0 + (b.x0 - R.x0) * kx, y0: I.y0 + (b.y0 - R.y0) * ky, x1: I.x0 + (b.x1 - R.x0) * kx, y1: I.y0 + (b.y1 - R.y0) * ky });
  let U = columns(laid.units.map((u) => ({ ...u, box: map(u.box) }))).flat();
  const widthOf = (b: Box) => b.x1 - b.x0;
  // The containers' own ink first: a fraction's bar (flat, across most of it), a root's radical
  // (from its left edge across most of it). Given to a glyph, it gave the glyph its colour.
  const colorOf = new Map<number, string | null>();
  const taken = new Set<InkPiece>();
  walk(nodes, (n) => {
    if (n.k !== 'cmd') return;
    const box = laid.boxes.get(n.id);
    if (!box) return;
    const b = map(box), w = widthOf(b);
    const own = ink
      .filter((st) => !taken.has(st) && widthOf(st.box) >= 0.7 * w && st.box.x0 <= b.x0 + 0.2 * w && st.box.x1 >= b.x1 - 0.25 * w && cy(st.box) >= b.y0 && cy(st.box) <= b.y1)
      .filter((st) => (n.head === '\\sqrt' ? true : st.box.y1 - st.box.y0 < 0.25 * widthOf(st.box)))
      .sort((p1, p2) => p2.len - p1.len)[0];
    if (own) {
      colorOf.set(n.id, own.hex);
      taken.add(own);
    }
  });
  const rest = ink.filter((st) => !taken.has(st));
  // Strokes of one symbol together (an i's dot, the bars of =, the strokes of x or +): strokes
  // overlapping in x, unless one is far wider (a fraction bar over the digits).
  const typical = [...rest.map((st) => widthOf(st.box))].sort((p1, p2) => p1 - p2)[rest.length >> 1] || 1;
  const C = columns(rest, (st, col) =>
    col.every((o) => {
      const [n, w] = [widthOf(st.box), widthOf(o.box)].sort((p1, p2) => p1 - p2);
      return n < 0.35 * typical || w <= 3 * Math.max(n, 1);
    })
  ).map((strokes) => ({ strokes, box: span(strokes.map((st) => st.box)) }));
  if (!C.length) return null;
  const d = (a: Box, b: Box) => Math.abs(cx(a) - cx(b)) / W + 0.5 * (Math.abs(cy(a) - cy(b)) / H);
  // Glyphs and ink symbols matched in reading order, by their spacing from the previous pair:
  // handwriting drifts from the type's proportions along the line (matched by place alone, a
  // drift of half a symbol made every later symbol take its neighbour's ink).
  // Aligned by place and by rank in the sequence: handwriting drifts from the type's proportions
  // along the line (by place alone, a drift of half a symbol made every later symbol take its
  // neighbour's ink); the rank keeps the order.
  const rank = (i: number, n: number) => (n > 1 ? i / (n - 1) : 0);
  const pairs = align(U.length, C.length, (i, j) => d(U[i].box, C[j].box) + Math.abs(rank(i, U.length) - rank(j, C.length)));
  const unitsOf = new Map<number, number[]>();
  pairs.forEach((js, i) => js.forEach((j) => unitsOf.set(j, [...(unitsOf.get(j) ?? []), i])));

  // Each stroke goes to the nearest glyph its symbol is aligned with (the numerator and the
  // denominator of a fraction can be one column of ink), unless it is far wider than the glyph
  // (a container's own ink).
  const votes = new Map<number, Map<string, number>>();
  for (const [j, us] of unitsOf)
    for (const st of C[j].strokes) {
      const i = [...us].sort((p1, p2) => d(U[p1].box, st.box) - d(U[p2].box, st.box))[0];
      const g = U[i].box;
      if (widthOf(st.box) > Math.max(2.5 * widthOf(g), 1.2 * (g.y1 - g.y0))) continue;
      const v = votes.get(U[i].owner) ?? new Map<string, number>();
      v.set(st.hex, (v.get(st.hex) ?? 0) + st.len);
      votes.set(U[i].owner, v);
      taken.add(st);
    }
  // A glyph no stroke went to: the nearest stroke.
  U.forEach((u, i) => {
    if (votes.has(u.owner)) return;
    const near = pairs[i].flatMap((j) => C[j].strokes).sort((a, b) => d(u.box, a.box) - d(u.box, b.box))[0];
    if (near) votes.set(u.owner, new Map([[near.hex, near.len]]));
  });
  for (const [id, v] of votes) colorOf.set(id, [...v].sort((a, b) => b[1] - a[1])[0][0]);
  // Containers without glyphs of their own (fraction bar, radical): the longest stroke inside them
  // that went to no glyph.
  walk(nodes, (n) => {
    if ((n.k !== 'cmd' && n.k !== 'wrap') || colorOf.has(n.id)) return;
    const box = laid.boxes.get(n.id);
    if (!box) return;
    const b = map(box);
    const padX = (b.x1 - b.x0) * 0.05, padY = (b.y1 - b.y0) * 0.05;
    const own = ink
      .filter((s) => !taken.has(s) && cx(s.box) >= b.x0 - padX && cx(s.box) <= b.x1 + padX && cy(s.box) >= b.y0 - padY && cy(s.box) <= b.y1 + padY)
      .sort((a, c) => c.len - a.len)[0];
    colorOf.set(n.id, own ? own.hex : null);
  });
  return f.wrap(colored(nodes, colorOf, info.base));
}

// For the UI benchmark (bench/ui.mjs --only inkcolors).
(window as unknown as { __opennoteColorByInk?: unknown }).__opennoteColorByInk = { colorByInk, stripColors, inkColors, katex };
