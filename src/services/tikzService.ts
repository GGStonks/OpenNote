import katex from 'katex';

/**
 * Lightweight TikZ interpreter → SVG.
 *
 * Used as the instant preview (and the fallback when the TeX engine is unavailable). It is a real
 * statement/path parser rather than per-line regexes: it handles multi-line commands, several
 * commands per line, relative (+/++) and polar coordinates, named nodes/coordinates, --, |-, -|,
 * rectangle, circle, ellipse, arc, grid, to, .. controls .., cycle, inline nodes on paths, plot
 * coordinates, colours (incl. red!30, rgb specs), line widths, dashes and arrow tips.
 * Exact output (fonts, \foreach, pgfplots, libraries) comes from the TikZJax engine (tikzEngine.ts).
 */

interface Pt { x: number; y: number }

interface Style {
  stroke: string | null;
  fill: string | null;
  width: number; // pt
  dash: string | null;
  arrowStart: boolean;
  arrowEnd: boolean;
  opacity: number;
  fillOpacity: number;
  roundedCorners: boolean;
}

interface NodeItem {
  at: Pt;
  text: string;
  anchor: string; // '', 'above', 'below', 'left', 'right', ...
  color: string;
  shape: 'none' | 'rectangle' | 'circle';
  drawBorder: boolean;
  fill: string | null;
  fontScale: number;
}

const PX_PER_CM = 37.8;
const PT_PER_CM = 28.4528;

const BASE_COLORS: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#00ff00', blue: '#0000ff', cyan: '#00ffff',
  magenta: '#ff00ff', yellow: '#ffff00', gray: '#808080', grey: '#808080', darkgray: '#404040', lightgray: '#bfbfbf',
  brown: '#bf8040', lime: '#bfff00', olive: '#808000', orange: '#ff8000', pink: '#ffbfbf', purple: '#bf0040',
  teal: '#008080', violet: '#800080', navy: '#000080', maroon: '#800000', gold: '#ffd700', indigo: '#4b0082',
  darkgreen: '#006400', darkblue: '#00008b', darkred: '#8b0000', skyblue: '#87ceeb', forestgreen: '#228b22',
  royalblue: '#4169e1', crimson: '#dc143c',
};

function hex(c: string): [number, number, number] {
  const v = parseInt(c.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
function toHex([r, g, b]: number[]): string {
  return '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}

/** Resolves xcolor expressions: name, name!pct, name!pct!other, {rgb,255:red,r;green,g;blue,b}, rgb:red,1;... */
export function resolveColor(expr: string): string | null {
  let e = expr.trim().replace(/^\{|\}$/g, '').trim();
  if (!e || e === 'none') return null;
  const rgb255 = /^rgb,\s*255\s*:\s*red\s*,\s*(\d+)\s*;\s*green\s*,\s*(\d+)\s*;\s*blue\s*,\s*(\d+)/i.exec(e);
  if (rgb255) return toHex([+rgb255[1], +rgb255[2], +rgb255[3]]);
  const rgb1 = /^rgb\s*:\s*red\s*,\s*([\d.]+)\s*;\s*green\s*,\s*([\d.]+)\s*;\s*blue\s*,\s*([\d.]+)/i.exec(e);
  if (rgb1) return toHex([+rgb1[1] * 255, +rgb1[2] * 255, +rgb1[3] * 255]);
  if (/^#[0-9a-f]{6}$/i.test(e)) return e;
  const parts = e.split('!').map((p) => p.trim().toLowerCase());
  const base = BASE_COLORS[parts[0]];
  if (!base) return null;
  if (parts.length === 1) return base;
  const pct = Math.max(0, Math.min(100, parseFloat(parts[1]) || 0)) / 100;
  const other = parts[2] ? BASE_COLORS[parts[2]] ?? '#ffffff' : '#ffffff';
  const a = hex(base), b = hex(other);
  return toHex(a.map((v, i) => v * pct + b[i] * (1 - pct)));
}

/** Converts a TikZ length (default unit cm) to cm. */
function lengthCm(raw: string): number {
  const m = /^\s*(-?[\d.]+(?:e-?\d+)?)\s*(cm|mm|pt|in|em|ex|bp)?\s*$/.exec(raw);
  if (!m) {
    const evaluated = evalNumber(raw);
    return Number.isFinite(evaluated) ? evaluated : 0;
  }
  const v = parseFloat(m[1]);
  switch (m[2]) {
    case 'mm': return v / 10;
    case 'pt': case 'bp': return v / PT_PER_CM;
    case 'in': return v * 2.54;
    case 'em': return v * 0.35;
    case 'ex': return v * 0.15;
    default: return v;
  }
}

/** Very small arithmetic evaluator for coordinates like (2*0.5, {sqrt(2)}). */
function evalNumber(expr: string): number {
  const e = expr
    .replace(/[{}]/g, '')
    .replace(/\bpi\b/g, String(Math.PI))
    .replace(/\b(sin|cos|tan)\(([^()]*)\)/g, (_m, f, a) => String((Math as any)[f]((evalNumber(a) * Math.PI) / 180)))
    .replace(/\bsqrt\(([^()]*)\)/g, (_m, a) => String(Math.sqrt(evalNumber(a))))
    .replace(/(cm|pt|mm)\b/g, '');
  if (!/^[\d.+\-*/()\se]+$/.test(e)) return NaN;
  try {
    // eslint-disable-next-line no-new-func
    return Function(`"use strict";return (${e});`)();
  } catch {
    return NaN;
  }
}

function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    if (ch === '}' || ch === ']' || ch === ')') depth--;
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function parseOptions(opts: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of splitTopLevel(opts, ',')) {
    const item = raw.trim();
    if (!item) continue;
    const eq = item.indexOf('=');
    if (eq > 0) map.set(item.slice(0, eq).trim(), item.slice(eq + 1).trim());
    else map.set(item, '');
  }
  return map;
}

const WIDTHS: Record<string, number> = {
  'ultra thin': 0.1, 'very thin': 0.2, thin: 0.4, semithick: 0.6, thick: 0.8, 'very thick': 1.2, 'ultra thick': 1.6,
};

function styleFrom(cmd: string, opts: Map<string, string>, inherited: Style): Style {
  const s: Style = { ...inherited };
  if (cmd === 'fill' || cmd === 'filldraw' || cmd === 'shade' || cmd === 'shadedraw') s.fill = s.fill ?? 'currentColor';
  if (cmd === 'fill' || cmd === 'path' || cmd === 'shade') s.stroke = cmd === 'path' ? null : s.stroke === 'currentColor' ? null : s.stroke;
  if (cmd === 'path') s.fill = null;
  for (const [k, v] of opts) {
    if (WIDTHS[k] !== undefined) s.width = WIDTHS[k];
    else if (k === 'line width') s.width = lengthCm(v) * PT_PER_CM;
    else if (k === 'dashed') s.dash = '4,3';
    else if (k === 'densely dashed') s.dash = '3,2';
    else if (k === 'loosely dashed') s.dash = '4,6';
    else if (k === 'dotted' || k === 'densely dotted' || k === 'loosely dotted') s.dash = '0.1,3';
    else if (k === 'dash dot' || k === 'dashdotted') s.dash = '4,2,0.1,2';
    else if (k === 'solid') s.dash = null;
    else if (k === 'draw') s.stroke = v ? resolveColor(v) ?? 'currentColor' : s.stroke ?? 'currentColor';
    else if (k === 'fill') s.fill = v ? resolveColor(v) : 'currentColor';
    else if (k === 'color') {
      const c = resolveColor(v);
      if (c) { s.stroke = s.stroke === null && cmd === 'fill' ? null : c; if (s.fill === 'currentColor') s.fill = c; }
    } else if (k === 'opacity') { s.opacity = parseFloat(v) || 1; s.fillOpacity = s.opacity; }
    else if (k === 'fill opacity') s.fillOpacity = parseFloat(v) || 1;
    else if (k === 'draw opacity') s.opacity = parseFloat(v) || 1;
    else if (k === 'rounded corners') s.roundedCorners = true;
    else if (k === '->' || /^-\s*(>|latex|stealth|\{.*\}|Stealth|Latex|To|>>)/i.test(k)) s.arrowEnd = true;
    else if (k === '<-' || /^(<|latex|stealth|\{.*\})-$/i.test(k)) s.arrowStart = true;
    else if (k === '<->' || /^(<|latex|stealth|\{.*\})-(>|latex|stealth|\{.*\})$/i.test(k)) { s.arrowStart = true; s.arrowEnd = true; }
    else if (k === '-') { s.arrowStart = false; s.arrowEnd = false; }
    else if (v === '' && resolveColor(k)) {
      const c = resolveColor(k)!;
      if (cmd === 'fill') s.fill = c;
      else { s.stroke = s.stroke === null ? null : c; if (s.fill === 'currentColor') s.fill = c; if (s.stroke === null && cmd !== 'path') s.stroke = c; }
    }
  }
  return s;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
}

function renderNodeText(text: string): string {
  const parts = text.split(/(\$[^$]*\$)/g).filter((p) => p !== '');
  return parts
    .map((p) => {
      if (p.startsWith('$') && p.endsWith('$') && p.length > 1) {
        try {
          return katex.renderToString(p.slice(1, -1), { throwOnError: false, output: 'html', strict: 'ignore' });
        } catch {
          return escapeXml(p);
        }
      }
      return escapeXml(p.replace(/\\\\/g, ' ').replace(/\\textbf\{([^}]*)\}/g, '$1').replace(/\\[a-zA-Z]+\s*/g, ''));
    })
    .join('');
}

export interface FallbackResult {
  svg: string;
  warnings: string[];
}

export function compileTikzToSvg(tikzCode: string): FallbackResult {
  const warnings: string[] = [];
  let src = tikzCode.replace(/(^|[^\\])%.*$/gm, '$1');
  let globalOpts = new Map<string, string>();
  const begin = /\\begin\{tikzpicture\}\s*(\[((?:[^\[\]]|\[[^\]]*\])*)\])?/.exec(src);
  if (begin) {
    globalOpts = parseOptions(begin[2] ?? '');
    src = src.slice(begin.index + begin[0].length);
    const end = src.indexOf('\\end{tikzpicture}');
    if (end >= 0) src = src.slice(0, end);
  }
  const scale = parseFloat(globalOpts.get('scale') ?? '1') || 1;
  const xScale = (parseFloat(globalOpts.get('x') ?? '1') || 1) * scale;
  const yScale = (parseFloat(globalOpts.get('y') ?? '1') || 1) * scale;
  const baseStyle: Style = styleFrom('draw', globalOpts, {
    stroke: 'currentColor', fill: null, width: 0.4, dash: null, arrowStart: false, arrowEnd: false, opacity: 1, fillOpacity: 1, roundedCorners: false,
  });
  baseStyle.fill = null;

  const named = new Map<string, Pt>();
  const elements: string[] = [];
  const nodes: NodeItem[] = [];
  const all: Pt[] = [];
  let markerId = 0;
  const markers: string[] = [];

  const parseCoordText = (inner: string, current: Pt): Pt | null => {
    const t = inner.trim();
    const calcMid = /^\$\s*\(([^)]+)\)\s*!\s*([\d.]+)\s*!\s*\(([^)]+)\)\s*\$$/.exec(t);
    if (calcMid) {
      const a = parseCoordText(calcMid[1], current), b = parseCoordText(calcMid[3], current);
      const k = parseFloat(calcMid[2]);
      if (a && b) return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
    }
    const calcSum = /^\$\s*\(([^)]+)\)\s*([+-])\s*\(([^)]+)\)\s*\$$/.exec(t);
    if (calcSum) {
      const a = parseCoordText(calcSum[1], current), b = parseCoordText(calcSum[3], { x: 0, y: 0 });
      if (a && b) return calcSum[2] === '+' ? { x: a.x + b.x, y: a.y + b.y } : { x: a.x - b.x, y: a.y - b.y };
    }
    const polar = /^(.+?):(.+)$/.exec(t);
    if (polar && !t.includes(',')) {
      const ang = (evalNumber(polar[1]) * Math.PI) / 180;
      const r = lengthCm(polar[2]);
      return { x: r * Math.cos(ang) * scale, y: r * Math.sin(ang) * scale };
    }
    const parts = splitTopLevel(t, ',');
    if (parts.length === 2) {
      const x = lengthCm(parts[0]) * xScale;
      const y = lengthCm(parts[1]) * yScale;
      if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
    }
    const name = t.replace(/\.(north|south|east|west|center|north east|north west|south east|south west|\d+)$/, '');
    if (named.has(name)) return named.get(name)!;
    return null;
  };

  const statements = splitTopLevel(src, ';');
  for (const rawStmt of statements) {
    const stmt = rawStmt.trim();
    if (!stmt) continue;
    const head = /^\\(draw|fill|filldraw|path|node|coordinate|shade|shadedraw|clip)\b/.exec(stmt);
    if (!head) {
      if (/^\\(foreach|usetikzlibrary|tikzset|def|newcommand|pgfmathsetmacro|begin\{axis\}|addplot)/.test(stmt)) {
        warnings.push(`Preview skips ${stmt.slice(0, 18)}…`);
      }
      continue;
    }
    let cmd = head[1];
    let rest = stmt.slice(head[0].length).trim();
    let opts = new Map<string, string>();
    if (rest.startsWith('[')) {
      const close = matchBracket(rest, 0, '[', ']');
      opts = parseOptions(rest.slice(1, close));
      rest = rest.slice(close + 1).trim();
    }
    if (cmd === 'clip') continue;

    if (cmd === 'node' || cmd === 'coordinate') {
      // \node[opts] (name) at (x,y) {text}  — parts may appear in different orders.
      let name: string | null = null;
      let at: Pt = { x: 0, y: 0 };
      let text = '';
      let guard = 0;
      while (rest && guard++ < 10) {
        if (rest.startsWith('[')) {
          const close = matchBracket(rest, 0, '[', ']');
          for (const [k, v] of parseOptions(rest.slice(1, close))) opts.set(k, v);
          rest = rest.slice(close + 1).trim();
        } else if (rest.startsWith('(')) {
          const close = matchBracket(rest, 0, '(', ')');
          name = rest.slice(1, close).trim();
          rest = rest.slice(close + 1).trim();
        } else if (rest.startsWith('at')) {
          rest = rest.slice(2).trim();
          const close = matchBracket(rest, 0, '(', ')');
          at = parseCoordText(rest.slice(1, close), at) ?? at;
          rest = rest.slice(close + 1).trim();
        } else if (rest.startsWith('{')) {
          const close = matchBracket(rest, 0, '{', '}');
          text = rest.slice(1, close);
          rest = rest.slice(close + 1).trim();
        } else break;
      }
      if (name) named.set(name, at);
      all.push(at);
      if (cmd === 'node') nodes.push(makeNode(at, text, opts));
      continue;
    }

    const style = styleFrom(cmd, opts, baseStyle);
    let d = '';
    let current: Pt = { x: 0, y: 0 };
    let subpathStart: Pt = { x: 0, y: 0 };
    let pendingOp: string | null = null;
    let lastStart: Pt | null = null;
    const pathPoints: Pt[] = [];
    const moveTo = (p: Pt) => { d += ` M${sx(p)} ${sy(p)}`; current = p; subpathStart = p; all.push(p); pathPoints.push(p); };
    const lineTo = (p: Pt) => { d += ` L${sx(p)} ${sy(p)}`; current = p; all.push(p); pathPoints.push(p); };

    let i = 0;
    const s = rest;
    let guard = 0;
    while (i < s.length && guard++ < 2000) {
      const ch = s[i];
      if (/\s/.test(ch)) { i++; continue; }
      if (s.startsWith('--', i)) { pendingOp = '--'; i += 2; continue; }
      if (s.startsWith('|-', i)) { pendingOp = '|-'; i += 2; continue; }
      if (s.startsWith('-|', i)) { pendingOp = '-|'; i += 2; continue; }
      if (s.startsWith('..', i)) {
        // .. controls (a) and (b) .. (c)
        const m = /^\.\.\s*controls\s*(\+{0,2})\(([^)]*)\)\s*(?:and\s*(\+{0,2})\(([^)]*)\))?\s*\.\.\s*(\+{0,2})\(([^)]*)\)/.exec(s.slice(i));
        if (m) {
          const rel = (pref: string, p: Pt | null, base: Pt) => (p ? (pref ? { x: base.x + p.x, y: base.y + p.y } : p) : base);
          const c1 = rel(m[1], parseCoordText(m[2], current), current);
          const end = rel(m[5], parseCoordText(m[6], current), current);
          const c2 = m[4] !== undefined ? rel(m[3], parseCoordText(m[4], current), end) : c1;
          d += ` C${sx(c1)} ${sy(c1)} ${sx(c2)} ${sy(c2)} ${sx(end)} ${sy(end)}`;
          all.push(c1, c2, end);
          current = end;
          i += m[0].length;
          continue;
        }
        i += 2;
        continue;
      }
      if (s.startsWith('cycle', i)) {
        d += ' Z';
        current = subpathStart;
        pendingOp = null;
        i += 5;
        continue;
      }
      if (ch === '(' || s.startsWith('+(', i) || s.startsWith('++(', i)) {
        const prefix = s.startsWith('++', i) ? '++' : s.startsWith('+', i) ? '+' : '';
        i += prefix.length;
        const close = matchBracket(s, i, '(', ')');
        const inner = s.slice(i + 1, close);
        i = close + 1;
        let p = parseCoordText(inner, current);
        if (!p) { warnings.push(`Unknown coordinate (${inner})`); continue; }
        if (prefix) p = { x: current.x + p.x, y: current.y + p.y };
        if (pendingOp === '--' || pendingOp === 'to') lineTo(p);
        else if (pendingOp === '|-') { lineTo({ x: current.x, y: p.y }); lineTo(p); }
        else if (pendingOp === '-|') { lineTo({ x: p.x, y: current.y }); lineTo(p); }
        else if (pendingOp === 'rectangle') {
          const a = current;
          d += ` M${sx(a)} ${sy(a)} L${sx({ x: p.x, y: a.y })} ${sy({ x: p.x, y: a.y })} L${sx(p)} ${sy(p)} L${sx({ x: a.x, y: p.y })} ${sy({ x: a.x, y: p.y })} Z`;
          all.push(a, p);
          current = p;
        } else if (pendingOp === 'grid') {
          const a = current;
          const step = parseFloat(opts.get('step') ?? '1') || 1;
          const [x0, x1] = [Math.min(a.x, p.x), Math.max(a.x, p.x)];
          const [y0, y1] = [Math.min(a.y, p.y), Math.max(a.y, p.y)];
          for (let gx = Math.ceil(x0 / step) * step; gx <= x1 + 1e-9; gx += step) d += ` M${sx({ x: gx, y: y0 })} ${sy({ x: gx, y: y0 })} L${sx({ x: gx, y: y1 })} ${sy({ x: gx, y: y1 })}`;
          for (let gy = Math.ceil(y0 / step) * step; gy <= y1 + 1e-9; gy += step) d += ` M${sx({ x: x0, y: gy })} ${sy({ x: x0, y: gy })} L${sx({ x: x1, y: gy })} ${sy({ x: x1, y: gy })}`;
          all.push(a, p);
          current = p;
        } else {
          if (prefix === '+') { lastStart = current; }
          moveTo(p);
          if (!lastStart) lastStart = p;
        }
        pendingOp = null;
        continue;
      }
      const word = /^[a-z]+/i.exec(s.slice(i))?.[0] ?? '';
      if (word === 'to') {
        pendingOp = 'to';
        i += 2;
        if (s[i] === '[') i = matchBracket(s, i, '[', ']') + 1;
        continue;
      }
      if (word === 'rectangle' || word === 'grid') {
        pendingOp = word;
        i += word.length;
        while (s[i] === ' ') i++;
        if (s[i] === '[') {
          const close = matchBracket(s, i, '[', ']');
          for (const [k, v] of parseOptions(s.slice(i + 1, close))) opts.set(k, v);
          i = close + 1;
        }
        continue;
      }
      if (word === 'circle' || word === 'ellipse') {
        i += word.length;
        let rx = 0.5, ry = 0.5;
        while (s[i] === ' ') i++;
        if (s[i] === '[') {
          const close = matchBracket(s, i, '[', ']');
          const o = parseOptions(s.slice(i + 1, close));
          const r = o.get('radius');
          if (r) rx = ry = lengthCm(r);
          if (o.get('x radius')) rx = lengthCm(o.get('x radius')!);
          if (o.get('y radius')) ry = lengthCm(o.get('y radius')!);
          i = close + 1;
          while (s[i] === ' ') i++;
        }
        if (s[i] === '(') {
          const close = matchBracket(s, i, '(', ')');
          const inner = s.slice(i + 1, close);
          const andParts = inner.split(/\s+and\s+/);
          if (andParts.length === 2) { rx = lengthCm(andParts[0]); ry = lengthCm(andParts[1]); }
          else rx = ry = lengthCm(inner);
          i = close + 1;
        }
        rx *= xScale; ry *= yScale;
        const c = current;
        const rxp = rx * PX_PER_CM, ryp = ry * PX_PER_CM;
        d += ` M${(c.x * PX_PER_CM + rxp).toFixed(2)} ${sy(c)} A${rxp.toFixed(2)} ${ryp.toFixed(2)} 0 1 0 ${(c.x * PX_PER_CM - rxp).toFixed(2)} ${sy(c)} A${rxp.toFixed(2)} ${ryp.toFixed(2)} 0 1 0 ${(c.x * PX_PER_CM + rxp).toFixed(2)} ${sy(c)} M${sx(c)} ${sy(c)}`;
        all.push({ x: c.x - rx, y: c.y - ry }, { x: c.x + rx, y: c.y + ry });
        continue;
      }
      if (word === 'arc') {
        i += 3;
        while (s[i] === ' ') i++;
        let a0 = 0, a1 = 90, r = 1;
        if (s[i] === '(') {
          const close = matchBracket(s, i, '(', ')');
          const parts = s.slice(i + 1, close).split(':');
          a0 = evalNumber(parts[0]); a1 = evalNumber(parts[1]); r = lengthCm(parts[2] ?? '1');
          i = close + 1;
        } else if (s[i] === '[') {
          const close = matchBracket(s, i, '[', ']');
          const o = parseOptions(s.slice(i + 1, close));
          a0 = evalNumber(o.get('start angle') ?? '0');
          a1 = evalNumber(o.get('end angle') ?? (o.get('delta angle') ? String(a0 + evalNumber(o.get('delta angle')!)) : '90'));
          r = lengthCm(o.get('radius') ?? '1');
          i = close + 1;
        }
        r *= scale;
        const center = { x: current.x - r * Math.cos((a0 * Math.PI) / 180), y: current.y - r * Math.sin((a0 * Math.PI) / 180) };
        const steps = Math.max(4, Math.ceil(Math.abs(a1 - a0) / 5));
        for (let k = 1; k <= steps; k++) {
          const a = ((a0 + ((a1 - a0) * k) / steps) * Math.PI) / 180;
          lineTo({ x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) });
        }
        continue;
      }
      if (word === 'node' || word === 'coordinate') {
        i += word.length;
        let nOpts = new Map<string, string>();
        let name: string | null = null;
        let text = '';
        let g2 = 0;
        while (i < s.length && g2++ < 6) {
          while (s[i] === ' ') i++;
          if (s[i] === '[') { const close = matchBracket(s, i, '[', ']'); nOpts = parseOptions(s.slice(i + 1, close)); i = close + 1; }
          else if (s[i] === '(' && word === 'coordinate' || (s[i] === '(' && name === null && s.slice(i).match(/^\([A-Za-z][\w ]*\)\s*\{/))) {
            const close = matchBracket(s, i, '(', ')'); name = s.slice(i + 1, close).trim(); i = close + 1;
            if (word === 'coordinate') break;
          } else if (s[i] === '{') { const close = matchBracket(s, i, '{', '}'); text = s.slice(i + 1, close); i = close + 1; break; }
          else break;
        }
        let at = current;
        if (nOpts.has('midway') || nOpts.has('pos') || (pathPoints.length >= 2 && nOpts.has('near end')) || nOpts.has('near start')) {
          const prev = pathPoints[pathPoints.length - 2] ?? current;
          const t = nOpts.has('pos') ? parseFloat(nOpts.get('pos')!) : nOpts.has('near end') ? 0.75 : nOpts.has('near start') ? 0.25 : 0.5;
          at = { x: prev.x + (current.x - prev.x) * t, y: prev.y + (current.y - prev.y) * t };
        }
        if (name) named.set(name, at);
        if (word === 'node') nodes.push(makeNode(at, text, nOpts, style.stroke));
        continue;
      }
      if (word === 'plot') {
        const m = /^plot\s*(\[[^\]]*\])?\s*coordinates\s*\{([^}]*)\}/.exec(s.slice(i));
        if (m) {
          const pts = [...m[2].matchAll(/\(([^)]*)\)/g)].map((c) => parseCoordText(c[1], current)).filter(Boolean) as Pt[];
          const smooth = (m[1] ?? '').includes('smooth');
          if (pts.length) {
            if (pendingOp === '--') lineTo(pts[0]); else moveTo(pts[0]);
            if (smooth && pts.length > 2) {
              for (let k = 1; k < pts.length; k++) {
                const p0 = pts[k - 2] ?? pts[k - 1], p1 = pts[k - 1], p2 = pts[k], p3 = pts[k + 1] ?? p2;
                const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
                const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
                d += ` C${sx(c1)} ${sy(c1)} ${sx(c2)} ${sy(c2)} ${sx(p2)} ${sy(p2)}`;
                all.push(p2);
                pathPoints.push(p2);
                current = p2;
              }
            } else pts.slice(1).forEach(lineTo);
          }
          pendingOp = null;
          i += m[0].length;
          continue;
        }
        warnings.push('Preview cannot evaluate function plots');
        break;
      }
      // Unknown token: skip a word / char.
      i += Math.max(1, word.length);
    }
    void lastStart;
    if (!d.trim()) continue;
    const attrs: string[] = [`d="${d.trim()}"`];
    attrs.push(`fill="${style.fill ?? 'none'}"`);
    if (style.fill && style.fillOpacity !== 1) attrs.push(`fill-opacity="${style.fillOpacity}"`);
    if (style.stroke) {
      attrs.push(`stroke="${style.stroke}"`, `stroke-width="${Math.max(0.6, style.width * 1.33).toFixed(2)}"`, 'stroke-linecap="round"', 'stroke-linejoin="round"');
      if (style.opacity !== 1) attrs.push(`stroke-opacity="${style.opacity}"`);
      if (style.dash) attrs.push(`stroke-dasharray="${style.dash.split(',').map((v) => (parseFloat(v) * Math.max(1, style.width * 1.33)).toFixed(1)).join(',')}"`);
      if (style.arrowEnd || style.arrowStart) {
        const id = `ah${markerId++}`;
        markers.push(`<marker id="${id}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="${6}" markerHeight="${6}" orient="auto-start-reverse" markerUnits="strokeWidth"><path d="M0 0 L10 5 L0 10 L3 5 Z" fill="${style.stroke}"/></marker>`);
        if (style.arrowEnd) attrs.push(`marker-end="url(#${id})"`);
        if (style.arrowStart) attrs.push(`marker-start="url(#${id})"`);
      }
    } else attrs.push('stroke="none"');
    elements.push(`<path ${attrs.join(' ')}/>`);
  }

  // Nodes (rendered last so they sit above paths).
  const nodeEls: string[] = [];
  for (const n of nodes) {
    const html = renderNodeText(n.text);
    const plain = n.text.replace(/\$|\\[a-zA-Z]+|[{}^_]/g, '');
    const fontPx = 15 * n.fontScale;
    const w = Math.max(fontPx, plain.length * fontPx * 0.55 + 10);
    const h = fontPx * 1.6;
    let cx = sxn(n.at), cy = syn(n.at);
    const off = 4;
    if (n.anchor.includes('above')) cy -= h / 2 + off;
    if (n.anchor.includes('below')) cy += h / 2 + off;
    if (n.anchor.includes('left')) cx -= w / 2 + off;
    if (n.anchor.includes('right')) cx += w / 2 + off;
    all.push({ x: (cx - w / 2) / PX_PER_CM, y: -(cy - h / 2) / PX_PER_CM }, { x: (cx + w / 2) / PX_PER_CM, y: -(cy + h / 2) / PX_PER_CM });
    if (n.drawBorder || n.fill) {
      const stroke = n.drawBorder ? n.color : 'none';
      const fill = n.fill ?? 'none';
      if (n.shape === 'circle') nodeEls.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(Math.max(w, h) / 2 + 2).toFixed(1)}" stroke="${stroke}" fill="${fill}" stroke-width="1"/>`);
      else nodeEls.push(`<rect x="${(cx - w / 2 - 3).toFixed(1)}" y="${(cy - h / 2).toFixed(1)}" width="${(w + 6).toFixed(1)}" height="${h.toFixed(1)}" stroke="${stroke}" fill="${fill}" stroke-width="1"/>`);
    }
    if (n.text.trim()) {
      nodeEls.push(
        `<foreignObject x="${(cx - w / 2 - 40).toFixed(1)}" y="${(cy - h / 2 - 4).toFixed(1)}" width="${(w + 80).toFixed(1)}" height="${(h + 8).toFixed(1)}"><div xmlns="http://www.w3.org/1999/xhtml" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-family:KaTeX_Main,'Times New Roman',serif;font-size:${fontPx}px;color:${n.color};white-space:nowrap;line-height:1">${html}</div></foreignObject>`
      );
    }
  }

  if (all.length === 0) {
    return { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="10" height="10"></svg>', warnings: ['Nothing to draw'] };
  }
  const xs = all.map((p) => p.x * PX_PER_CM), ys = all.map((p) => -p.y * PX_PER_CM);
  const pad = 6;
  const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad;
  const minY = Math.min(...ys) - pad, maxY = Math.max(...ys) + pad;
  const w = maxX - minX, h = maxY - minY;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX.toFixed(1)} ${minY.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" style="overflow:visible;color:inherit">` +
    (markers.length ? `<defs>${markers.join('')}</defs>` : '') +
    elements.join('') +
    nodeEls.join('') +
    '</svg>';
  return { svg, warnings };

  function sx(p: Pt) { return (p.x * PX_PER_CM).toFixed(2); }
  function sy(p: Pt) { return (-p.y * PX_PER_CM).toFixed(2); }
  function sxn(p: Pt) { return p.x * PX_PER_CM; }
  function syn(p: Pt) { return -p.y * PX_PER_CM; }
  function makeNode(at: Pt, text: string, o: Map<string, string>, inheritColor?: string | null): NodeItem {
    let anchor = '';
    for (const k of ['above left', 'above right', 'below left', 'below right', 'above', 'below', 'left', 'right']) {
      if (o.has(k)) { anchor = k; break; }
    }
    const anchorOpt = o.get('anchor');
    if (anchorOpt) anchor = ({ south: 'above', north: 'below', east: 'left', west: 'right' } as Record<string, string>)[anchorOpt] ?? anchor;
    let color = inheritColor && inheritColor !== 'currentColor' ? inheritColor : 'currentColor';
    for (const [k, v] of o) {
      if (k === 'color' || k === 'text') color = resolveColor(v) ?? color;
      else if (v === '' && resolveColor(k)) color = resolveColor(k)!;
    }
    const shape = o.has('circle') ? 'circle' : o.has('rectangle') || o.has('draw') ? 'rectangle' : 'none';
    const fontScale = o.has('scale') ? parseFloat(o.get('scale')!) || 1 : o.has('font') && /small/.test(o.get('font')!) ? 0.85 : 1;
    return {
      at, text, anchor, color, shape,
      drawBorder: o.has('draw'),
      fill: o.has('fill') ? resolveColor(o.get('fill')!) ?? null : null,
      fontScale,
    };
  }
}

function matchBracket(s: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === open) depth++;
    else if (s[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return s.length - 1;
}
