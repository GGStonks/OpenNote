import { Rect, Stroke } from '../types';
import { normalizeHex } from '../components/ColorPicker';

/**
 * Colours of handwriting sent to Qwen3-VL, so a transcription keeps them: `2x` written with a red
 * 2 and a blue x comes back as \textcolor{#FF1010}{2}\textcolor{#0033FF}{x}.
 *
 *  1. inkColors(): the exact colours of the selected ink, the base colour (the default ink if used,
 *     which needs no markup), where each colour is, and how it is drawn in the image (very light
 *     inks are darkened there, keeping their hue, so they stay visible on the white image).
 *  2. colorHint(): the instruction added to the prompt, listing exactly those HEX codes.
 *  3. enforceColors(): the reply may only use those codes: \textcolor[HTML]{..}, colour names and
 *     codes that are close are turned into the nearest listed code, markup of the base colour is
 *     removed (the block itself takes that colour).
 */

export interface InkColor {
  hex: string;
  name: string;
  /** Colour used for this ink in the image sent to the model. */
  imageColor: string;
  /** Share of the ink (by length). */
  share: number;
  /** Where this colour is in the image, in % of its width / height. */
  region: { x0: number; y0: number; x1: number; y1: number };
}

export interface InkColorInfo {
  colors: InkColor[];
  /** The colour of unmarked symbols (the block's colour): the default ink if used, else the most used colour. */
  base: string;
}

/** The app's default ink colours: a block in one of these follows the paper (dark / light). */
export const DEFAULT_INKS = ['#111827', '#000000', '#F3F4F6'];

const rgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const toHex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
const lum = ([r, g, b]: [number, number, number]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Names the model knows, to tell inks apart in the prompt (nearest by RGB distance). */
const NAMES: [string, string][] = [
  ['black', '#000000'], ['dark grey', '#404040'], ['grey', '#808080'], ['light grey', '#C0C0C0'], ['white', '#FFFFFF'],
  ['red', '#FF0000'], ['crimson', '#DC143C'], ['dark red', '#8B0000'], ['tomato', '#FF6347'], ['pink', '#FF69B4'], ['light pink', '#FFB6C1'],
  ['orange', '#FFA500'], ['dark orange', '#FF8C00'], ['brown', '#8B4513'], ['gold', '#FFD700'], ['yellow', '#FFFF00'], ['olive', '#808000'],
  ['lime', '#32CD32'], ['green', '#008000'], ['dark green', '#006400'], ['teal', '#008080'], ['turquoise', '#40E0D0'], ['cyan', '#00FFFF'],
  ['sky blue', '#1E90FF'], ['blue', '#0000FF'], ['royal blue', '#4169E1'], ['navy', '#000080'], ['indigo', '#4B0082'], ['purple', '#800080'],
  ['violet', '#8A2BE2'], ['magenta', '#FF00FF'],
];

function colorName(hex: string): string {
  const c = rgb(hex);
  let best = NAMES[0][0], bd = Infinity;
  for (const [name, h] of NAMES) {
    const d = rgb(h).reduce((s, v, i) => s + (v - c[i]) ** 2, 0);
    if (d < bd) { bd = d; best = name; }
  }
  return best;
}

/** Distinct names for a set of colours (a repeated name gets "2nd ..." etc.). */
function distinctNames(hexes: string[]): string[] {
  const seen = new Map<string, number>();
  return hexes.map((h) => {
    const n = colorName(h);
    const k = (seen.get(n) ?? 0) + 1;
    seen.set(n, k);
    return k === 1 ? n : `${n} (${['', '', 'second', 'third', 'fourth'][k] ?? `#${k}`} shade)`;
  });
}

/** Light inks are darkened for the image (same hue); white / light grey become mid grey. */
function visibleOnWhite(hex: string): string {
  const c = rgb(hex);
  const L = lum(c);
  if (L <= 170) return hex;
  const [r, g, b] = c;
  if (Math.max(r, g, b) - Math.min(r, g, b) < 28) return '#6B6B6B';
  const k = 120 / L;
  return toHex(r * k, g * k, b * k);
}

function inkLength(s: Stroke): number {
  let l = 0;
  for (let i = 1; i < s.points.length; i++) l += Math.hypot(s.points[i].x - s.points[i - 1].x, s.points[i].y - s.points[i - 1].y);
  return Math.max(l, 1);
}

export function inkColors(strokes: Stroke[], bounds: Rect): InkColorInfo {
  const by = new Map<string, { len: number; x0: number; y0: number; x1: number; y1: number }>();
  let total = 0;
  for (const s of strokes) {
    const hex = normalizeHex(s.color) ?? '#000000';
    const e = by.get(hex) ?? { len: 0, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    const l = inkLength(s);
    e.len += l;
    total += l;
    for (const p of s.points) {
      e.x0 = Math.min(e.x0, p.x); e.y0 = Math.min(e.y0, p.y);
      e.x1 = Math.max(e.x1, p.x); e.y1 = Math.max(e.y1, p.y);
    }
    by.set(hex, e);
  }
  const pct = (v: number, o: number, size: number) => Math.round(Math.max(0, Math.min(100, ((v - o) / Math.max(1, size)) * 100)));
  const sorted = [...by.entries()].sort((a, b) => b[1].len - a[1].len);
  const names = distinctNames(sorted.map(([hex]) => hex));
  const colors = sorted
    .map(([hex, e], i) => ({
      hex,
      name: names[i],
      imageColor: visibleOnWhite(hex),
      share: e.len / Math.max(1, total),
      region: { x0: pct(e.x0, bounds.x, bounds.width), y0: pct(e.y0, bounds.y, bounds.height), x1: pct(e.x1, bounds.x, bounds.width), y1: pct(e.y1, bounds.y, bounds.height) },
    }))
    .sort((a, b) => b.share - a.share);
  // The base colour (no markup; the block's own colour) is the default ink when it is used: what
  // the model leaves unmarked is then in the usual ink, which is right far more often than the
  // most used colour (Qwen tends to leave operators like + unmarked).
  const def = colors.find((c) => DEFAULT_INKS.includes(c.hex));
  return { colors, base: def?.hex ?? colors[0]?.hex ?? '#000000' };
}

/**
 * The prompt addition for several ink colours (empty for one colour). Tried on Qwen3-VL: asking
 * for every symbol to be wrapped (and removing the base colour's markup afterwards, see
 * enforceColors) works; "leave the base colour unmarked" made it skip the colours altogether.
 */
export function colorHint(info: InkColorInfo, mode: 'math' | 'text'): string {
  if (info.colors.length < 2) return '';
  const codes = info.colors.map((c) => `  ${c.hex} (${c.name}${c.imageColor !== c.hex ? `, appears as ${colorName(c.imageColor)} in the image` : ''})`);
  const [a, b] = info.colors;
  return [
    mode === 'math'
      ? 'The ink has several colours. Every symbol must be written inside \\textcolor{#RRGGBB}{...} with the HEX code of the colour it is drawn in. Use only these codes:'
      : 'The ink has several colours. Every word and every symbol must be written inside \\textcolor{#RRGGBB}{...} with the HEX code of the colour it is drawn in (for math, inside the $...$). Use only these codes:',
    ...codes,
    `Group adjacent symbols of the same colour in one \\textcolor. Example for a ${a.name} 3 followed by a ${b.name} y: \\textcolor{${a.hex}}{3}\\textcolor{${b.hex}}{y}`,
  ].join('\n');
}

const NAMED: Record<string, string> = {
  red: '#FF0000', blue: '#0000FF', green: '#008000', black: '#000000', white: '#FFFFFF', gray: '#808080', grey: '#808080',
  orange: '#FF8000', yellow: '#FFFF00', purple: '#800080', violet: '#8000FF', magenta: '#FF00FF', cyan: '#00FFFF', teal: '#008080',
  brown: '#804000', pink: '#FFC0CB',
};

function nearest(hex: string, allowed: string[]): string {
  const c = rgb(hex);
  let best = allowed[0], bd = Infinity;
  for (const a of allowed) {
    const d = rgb(a).reduce((s, v, i) => s + (v - c[i]) ** 2, 0);
    if (d < bd) { bd = d; best = a; }
  }
  return best;
}

/** Index just past the brace group that starts at `i` (s[i] === '{'), or -1. */
function groupEnd(s: string, i: number): number {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === '{') depth++;
    else if (s[j] === '}' && --depth === 0) return j + 1;
  }
  return -1;
}

/**
 * Makes the reply use only the given colours (see the top of this file). `allowed` is the list of
 * ink colours; with a single colour all colour markup is removed.
 */
export function enforceColors(latex: string, info: InkColorInfo): string {
  const allowed = info.colors.map((c) => c.hex);
  if (!allowed.length) return latex;
  const resolve = (spec: string, model?: string): string => {
    let hex = normalizeHex(spec.replace(/^#/, ''));
    if (!hex && model && /rgb/i.test(model)) {
      const v = spec.split(/[ ,]+/).map(Number);
      if (v.length === 3 && v.every((x) => Number.isFinite(x))) hex = /RGB/.test(model) ? toHex(v[0], v[1], v[2]) : toHex(v[0] * 255, v[1] * 255, v[2] * 255);
    }
    hex ??= NAMED[spec.trim().toLowerCase()] ?? null;
    return nearest(hex ?? info.base, allowed);
  };
  let s = latex;
  // \textcolor[HTML]{FF1010}{..}, \textcolor{red}{..}, \color[rgb]{..} -> \textcolor{#XXXXXX}
  s = s.replace(/\\(textcolor|color)\s*(?:\[([A-Za-z]+)\])?\s*\{([^{}]*)\}/g, (_m, cmd: string, model: string | undefined, spec: string) => `\\${cmd}{${resolve(spec, model)}}`);
  // Remove the markup of the base colour (and all markup when there is one colour): the block has that colour.
  let out = '';
  for (let i = 0; i < s.length; ) {
    const m = /^\\textcolor\{(#[0-9A-F]{6})\}\s*\{/.exec(s.slice(i, i + 40));
    if (m && (m[1] === info.base || allowed.length === 1)) {
      const open = i + m[0].length - 1;
      const end = groupEnd(s, open);
      if (end > 0) {
        out += enforceInner(s.slice(open + 1, end - 1));
        i = end;
        continue;
      }
    }
    out += s[i++];
  }
  return out;

  function enforceInner(inner: string): string {
    return enforceColors(inner, info);
  }
}
