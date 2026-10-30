import type { ListKind, TextBlock, TextFont, TextPara, TextSpan } from '../types';
import { fontStack } from './textStyle';

/**
 * A text box's content as HTML, and back: one element per paragraph (its list kind, indent level,
 * checkbox and marker as data attributes, drawn by RICH_TEXT_CSS), styled words as spans (their
 * overrides as data attributes). The page, the text editor (a contenteditable holding exactly
 * this HTML), thumbnails and the SVG export all draw it the same way, so a box looks the same
 * while typed in and after.
 *
 * Paragraphs are the text split at newlines; TextBlock.paras has one entry per paragraph and
 * TextBlock.spans are ranges of the whole text (paragraphs joined by "\n").
 */

/** The class of a box's text element (its alignment: centred and right-aligned list markers sit by their text). */
export function richTextClass(t: Pick<TextBlock, 'align'>): string {
  return t.align && t.align !== 'left' ? `on-text on-a-${t.align}` : 'on-text';
}

/** The paragraph style at each paragraph (missing entries are plain). */
export function parasOf(t: Pick<TextBlock, 'text' | 'paras'>): TextPara[] {
  const n = t.text.split('\n').length;
  return Array.from({ length: n }, (_, i) => t.paras?.[i] ?? {});
}

const ROMAN_LETTER = (n: number, upper: boolean) => {
  let s = '';
  for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode((upper ? 65 : 97) + ((k - 1) % 26)) + s;
  return s;
};

/**
 * Each paragraph's list marker: bullets by level (• ◦ ▪), numbers counting up within a list (1. at
 * the first level, A. and a. indented, as Notability numbers outlines), letters (a.), checkboxes
 * (drawn by CSS: ''). A paragraph that is not in a list ends the list.
 */
export function listMarkers(paras: TextPara[]): string[] {
  const counters: number[] = [];
  return paras.map((p) => {
    const level = Math.max(0, Math.min(8, p.level ?? 0));
    if (!p.list) {
      counters.length = 0;
      return '';
    }
    if (p.list === 'bullet') return ['•', '◦', '▪'][level % 3];
    if (p.list === 'check') return '';
    counters.length = level + 1;
    counters[level] = p.num ?? (counters[level] ?? 0) + 1;
    const n = counters[level];
    if (p.list === 'letter') return `${ROMAN_LETTER(n, false)}.`;
    return [`${n}.`, `${ROMAN_LETTER(n, true)}.`, `${ROMAN_LETTER(n, false)}.`][level % 3];
  });
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A span's overrides as data attributes and CSS. */
function spanAttrs(sp: TextSpan, t: Pick<TextBlock, 'underline' | 'strike'>): string {
  const data: string[] = [], css: string[] = [];
  if (sp.bold !== undefined) data.push(`data-b="${sp.bold ? 1 : 0}"`), css.push(`font-weight:${sp.bold ? 700 : 400}`);
  if (sp.italic !== undefined) data.push(`data-i="${sp.italic ? 1 : 0}"`), css.push(`font-style:${sp.italic ? 'italic' : 'normal'}`);
  if (sp.underline !== undefined) data.push(`data-u="${sp.underline ? 1 : 0}"`);
  if (sp.strike !== undefined) data.push(`data-s="${sp.strike ? 1 : 0}"`);
  if (sp.underline !== undefined || sp.strike !== undefined) {
    const u = sp.underline ?? t.underline, s = sp.strike ?? t.strike;
    css.push(`text-decoration:${[u ? 'underline' : '', s ? 'line-through' : ''].filter(Boolean).join(' ') || 'none'}`);
  }
  if (sp.color) data.push(`data-c="${esc(sp.color)}"`), css.push(`color:${esc(sp.color)}`);
  if (sp.font) data.push(`data-f="${esc(sp.font)}"`), css.push(`font-family:${esc(fontStack(sp.font)).replace(/&quot;/g, "'")}`);
  if (sp.size) data.push(`data-z="${sp.size}"`), css.push(`font-size:${sp.size}px`);
  return `${data.join(' ')} style="${css.join(';')}"`;
}

/** The attributes of a paragraph element. */
function paraAttrs(p: TextPara, marker: string): string {
  const a = ['class="on-p"'];
  if (p.list) a.push(`data-list="${p.list}"`, `data-marker="${esc(marker)}"`);
  if (p.level) a.push(`data-level="${Math.max(0, Math.min(8, p.level))}"`);
  if (p.list === 'check' && p.checked) a.push('data-checked=""');
  if (p.num !== undefined) a.push(`data-num="${p.num}"`);
  if (p.align) a.push(`data-align="${p.align}"`);
  return a.join(' ');
}

/** The box's content as HTML (paragraph elements; an empty paragraph holds a <br>, as an editor needs). */
export function textBlockHtml(t: Pick<TextBlock, 'text' | 'spans' | 'paras' | 'underline' | 'strike'>, tag: 'div' | 'xhtml:div' = 'div'): string {
  const paras = parasOf(t);
  const markers = listMarkers(paras);
  const spans = (t.spans ?? []).filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
  const span = tag === 'div' ? 'span' : 'xhtml:span';
  const br = tag === 'div' ? '<br>' : '<xhtml:br/>';
  let at = 0;
  return t.text
    .split('\n')
    .map((line, i) => {
      const a = at, b = at + line.length;
      at = b + 1;
      // The paragraph cut where its spans start and end.
      let html = '', pos = a;
      for (const sp of spans) {
        const s0 = Math.max(sp.start, pos), s1 = Math.min(sp.end, b);
        if (s1 <= s0) continue;
        if (s0 > pos) html += esc(t.text.slice(pos, s0));
        html += `<${span} ${spanAttrs(sp, t)}>${esc(t.text.slice(s0, s1))}</${span}>`;
        pos = s1;
      }
      if (pos < b) html += esc(t.text.slice(pos, b));
      return `<${tag} ${paraAttrs(paras[i], markers[i])}>${html || br}</${tag}>`;
    })
    .join('');
}

// ------------------------------------------------------------------------------- reading back

type RunStyle = Omit<TextSpan, 'start' | 'end'>;

/** A span element's overrides (its data attributes). */
function styleOf(el: HTMLElement, inherited: RunStyle): RunStyle {
  const d = el.dataset;
  const out: RunStyle = { ...inherited };
  if (d.b !== undefined) out.bold = d.b === '1';
  if (d.i !== undefined) out.italic = d.i === '1';
  if (d.u !== undefined) out.underline = d.u === '1';
  if (d.s !== undefined) out.strike = d.s === '1';
  if (d.c) out.color = d.c;
  if (d.f) out.font = d.f as TextFont;
  if (d.z && Number.isFinite(+d.z)) out.size = +d.z;
  return out;
}

const BLOCK = /^(DIV|P|LI|H[1-6]|BLOCKQUOTE|PRE|UL|OL)$/;

function paraOf(el: HTMLElement | null): TextPara {
  if (!el) return {};
  const d = el.dataset;
  const p: TextPara = {};
  if (d.list === 'bullet' || d.list === 'number' || d.list === 'letter' || d.list === 'check') p.list = d.list;
  if (d.level && +d.level > 0) p.level = Math.min(8, Math.round(+d.level));
  if (p.list === 'check' && d.checked !== undefined) p.checked = true;
  if (d.num !== undefined && Number.isFinite(+d.num)) p.num = +d.num;
  if (d.align === 'left' || d.align === 'center' || d.align === 'right') p.align = d.align;
  return p;
}

/**
 * The text, spans and paragraph styles in an edited box's HTML. Whatever the browser made of it
 * while typing (text straight in the root, <br> line breaks, a pasted <div> inside a paragraph,
 * style spans of its own) is read as paragraphs and styled runs; only our data attributes count.
 */
export function readTextHtml(root: HTMLElement): { text: string; spans: TextSpan[]; paras: TextPara[] } {
  const lines: { text: string; para: TextPara; runs: { text: string; style: RunStyle }[] }[] = [];
  let cur: (typeof lines)[number] | null = null;
  const start = (para: TextPara) => {
    cur = { text: '', para: { ...para }, runs: [] };
    lines.push(cur);
    return cur;
  };
  const walk = (node: Node, style: RunStyle, para: TextPara, inBlock: boolean) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.nodeValue ?? '').replace(/​/g, '').replace(/\r\n?/g, '\n');
      if (!text) return;
      const parts = text.split('\n');
      parts.forEach((part, k) => {
        if (k > 0 || !cur) start(k > 0 ? { ...para, checked: undefined } : para);
        if (part) {
          cur!.text += part;
          cur!.runs.push({ text: part, style });
        }
      });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    if (el.tagName === 'BR') {
      // A <br> ends its line, unless it is the paragraph's last (the placeholder of an empty one).
      const last = !el.nextSibling || (el.parentElement && el.parentElement.lastChild === el && inBlock);
      if (!last) start({ ...para, checked: undefined });
      return;
    }
    if (BLOCK.test(el.tagName)) {
      const p = el.classList.contains('on-p') || el.dataset.list !== undefined ? paraOf(el) : para;
      start(p);
      for (const c of Array.from(el.childNodes)) walk(c, style, p, true);
      cur = null;
      return;
    }
    const s = el.tagName === 'SPAN' || el.dataset ? styleOf(el, style) : style;
    for (const c of Array.from(el.childNodes)) walk(c, s, para, inBlock);
  };
  for (const c of Array.from(root.childNodes)) {
    if (c.nodeType === Node.ELEMENT_NODE && BLOCK.test((c as HTMLElement).tagName)) {
      walk(c, {}, {}, true);
    } else {
      if (!cur) start({});
      walk(c, {}, cur!.para, false);
    }
  }
  if (!lines.length) lines.push({ text: '', para: {}, runs: [] });
  const text = lines.map((l) => l.text).join('\n');
  const spans: TextSpan[] = [];
  let at = 0;
  for (const l of lines) {
    for (const r of l.runs) {
      if (Object.keys(r.style).length) {
        const prev = spans[spans.length - 1];
        if (prev && prev.end === at && JSON.stringify({ ...prev, start: 0, end: 0 }) === JSON.stringify({ ...r.style, start: 0, end: 0 })) prev.end += r.text.length;
        else spans.push({ start: at, end: at + r.text.length, ...r.style });
      }
      at += r.text.length;
    }
    at += 1;
  }
  return { text, spans, paras: lines.map((l) => l.para) };
}

/** Paragraph styles worth keeping (undefined when every paragraph is plain). */
export function compactParas(paras: TextPara[]): TextPara[] | undefined {
  const clean = paras.map((p) => {
    const q: TextPara = {};
    if (p.list) q.list = p.list;
    if (p.level) q.level = p.level;
    if (p.list === 'check' && p.checked) q.checked = true;
    if (p.num !== undefined && p.list) q.num = p.num;
    if (p.align) q.align = p.align;
    return q;
  });
  return clean.some((p) => Object.keys(p).length) ? clean : undefined;
}

// ------------------------------------------------------------------------- editing helpers

/** The paragraph elements of an editor's root (wrapping text the browser left outside one). */
export function paragraphsOf(root: HTMLElement): HTMLElement[] {
  const loose = Array.from(root.childNodes).filter((n) => !(n.nodeType === Node.ELEMENT_NODE && BLOCK.test((n as HTMLElement).tagName)));
  if (loose.length) {
    const sel = window.getSelection();
    const caretIn = sel && sel.rangeCount && loose.some((n) => n.contains(sel.anchorNode));
    // Text typed into an emptied editor lands in the root: it becomes a paragraph.
    let wrap: HTMLElement | null = null;
    for (const n of Array.from(root.childNodes)) {
      if (n.nodeType === Node.ELEMENT_NODE && BLOCK.test((n as HTMLElement).tagName)) {
        wrap = null;
        continue;
      }
      if (!wrap) {
        wrap = document.createElement('div');
        wrap.className = 'on-p';
        root.insertBefore(wrap, n);
      }
      wrap.appendChild(n);
    }
    if (caretIn && sel) {
      const last = root.lastElementChild;
      if (last) {
        sel.selectAllChildren(last);
        sel.collapseToEnd();
      }
    }
  }
  return Array.from(root.children).filter((n): n is HTMLElement => BLOCK.test(n.tagName));
}

/** Writes the list markers again (numbers change as paragraphs come and go). */
export function refreshMarkers(root: HTMLElement) {
  const ps = paragraphsOf(root);
  const markers = listMarkers(ps.map((p) => paraOf(p)));
  ps.forEach((p, i) => {
    if (!p.classList.contains('on-p')) p.classList.add('on-p');
    if (p.dataset.list) {
      if (p.dataset.marker !== markers[i]) p.dataset.marker = markers[i];
    } else if (p.dataset.marker !== undefined) delete p.dataset.marker;
  });
}

/** The paragraphs the selection touches (the caret's when collapsed). */
export function selectedParagraphs(root: HTMLElement): HTMLElement[] {
  const ps = paragraphsOf(root);
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !root.contains(sel.anchorNode)) return ps.slice(-1);
  const r = sel.getRangeAt(0);
  const hit = ps.filter((p) => r.intersectsNode(p));
  if (hit.length) return hit;
  const at = ps.find((p) => p.contains(r.startContainer));
  return at ? [at] : ps.slice(-1);
}

/** Sets (or, when all have it already, clears) a list kind on the selected paragraphs. */
export function toggleList(root: HTMLElement, kind: ListKind) {
  const ps = selectedParagraphs(root);
  const all = ps.every((p) => p.dataset.list === kind);
  for (const p of ps) {
    if (all) {
      delete p.dataset.list;
      delete p.dataset.checked;
    } else {
      p.dataset.list = kind;
      if (kind !== 'check') delete p.dataset.checked;
    }
    delete p.dataset.num;
  }
  refreshMarkers(root);
}

/** Indents (1) or outdents (-1) the selected paragraphs. */
export function indentParagraphs(root: HTMLElement, d: 1 | -1) {
  for (const p of selectedParagraphs(root)) {
    const level = Math.max(0, Math.min(8, (+(p.dataset.level ?? 0) || 0) + d));
    if (level) p.dataset.level = String(level);
    else delete p.dataset.level;
  }
  refreshMarkers(root);
}

/** The list kind of the caret's paragraph. */
export function listAtCaret(root: HTMLElement): ListKind | null {
  const p = selectedParagraphs(root)[0];
  const k = p?.dataset.list;
  return k === 'bullet' || k === 'number' || k === 'letter' || k === 'check' ? k : null;
}

/** The paragraph a pointer is on when it is on that paragraph's checkbox (null elsewhere). */
export function checkboxAt(root: HTMLElement, clientX: number, clientY: number): HTMLElement | null {
  for (const p of paragraphsOf(root)) {
    if (p.dataset.list !== 'check') continue;
    const r = p.getBoundingClientRect();
    if (clientY < r.top || clientY > r.bottom) continue;
    const k = r.width / Math.max(1, p.offsetWidth);
    const cs = getComputedStyle(p);
    const before = getComputedStyle(p, '::before');
    if (before.position === 'static') {
      // Beside its text (a centred or right-aligned list): the box is just before the first line.
      const range = document.createRange();
      range.selectNodeContents(p);
      const first = range.getClientRects()[0];
      const box = parseFloat(before.width) * k, gap = parseFloat(before.marginRight) * k;
      const x0 = (first ? first.left : r.left) - (first && first.left > r.left + box ? 0 : 0);
      if (clientX >= x0 - 4 && clientX <= x0 + box + gap + 4 && clientY <= (first ? first.bottom : r.bottom) + 2) return p;
      continue;
    }
    const pad = parseFloat(cs.paddingLeft) * k;
    if (clientX >= r.left - 4 && clientX <= r.left + pad + 2) return p;
  }
  return null;
}

/**
 * How paragraphs, lists and checkboxes are drawn (in the page's CSS, and inside an exported SVG).
 * Each indent level is 2.1 em, a list item's marker sits in 1.7 em before its text (a bullet in
 * 1.25 em), aligned with
 * its first line, and a checkbox is a circle, ticked filled with the text's colour (as Notability
 * draws them).
 */
export const RICH_TEXT_CSS = `
.on-text { white-space: pre-wrap; overflow-wrap: break-word; }
.on-text .on-p { position: relative; min-height: calc(var(--lh, 1.35) * 1em); padding-left: var(--ind, 0em); }
.on-text .on-p[data-level="1"] { --ind: 2.1em; } .on-text .on-p[data-level="2"] { --ind: 4.2em; }
.on-text .on-p[data-level="3"] { --ind: 6.3em; } .on-text .on-p[data-level="4"] { --ind: 8.4em; }
.on-text .on-p[data-level="5"] { --ind: 10.5em; } .on-text .on-p[data-level="6"] { --ind: 12.6em; }
.on-text .on-p[data-level="7"] { --ind: 14.7em; } .on-text .on-p[data-level="8"] { --ind: 16.8em; }
.on-text .on-p[data-list] { padding-left: calc(var(--ind, 0em) + 1.7em); }
.on-text .on-p[data-list]::before { content: attr(data-marker); position: absolute; left: var(--ind, 0em); width: 1.4em; text-align: left; font-weight: inherit; text-decoration: none; }
.on-text .on-p[data-list="bullet"] { padding-left: calc(var(--ind, 0em) + 1.25em); }
.on-text .on-p[data-list="bullet"]::before { width: 1em; text-align: center; }
.on-text .on-p[data-list="check"] { padding-top: 0.18em; padding-bottom: 0.18em; }
.on-text .on-p[data-list="check"]::before { content: ""; box-sizing: border-box; left: calc(var(--ind, 0em) + 0.15em); top: calc(0.18em + (var(--lh, 1.35) * 1em - 1.1em) / 2); width: 1.1em; height: 1.1em; border: max(1px, 0.08em) solid currentColor; border-radius: 50%; }
.on-text .on-p[data-list="check"][data-checked]::before { background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'%3E%3Cpath d='M2.2 5.3l1.9 1.9 3.8-4.3' fill='none' stroke='white' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center / 100% no-repeat currentColor; }
.on-text .on-p[data-list="check"][data-checked] { text-decoration: line-through; opacity: 0.55; }
.on-text .on-p[data-align="left"] { text-align: left; } .on-text .on-p[data-align="center"] { text-align: center; } .on-text .on-p[data-align="right"] { text-align: right; }
.on-text.on-a-center .on-p[data-list]:not([data-align="left"]), .on-text.on-a-right .on-p[data-list]:not([data-align="left"]), .on-text .on-p[data-list][data-align="center"], .on-text .on-p[data-list][data-align="right"] { padding-left: var(--ind, 0em); }
.on-text.on-a-center .on-p[data-list]:not([data-align="left"])::before, .on-text.on-a-right .on-p[data-list]:not([data-align="left"])::before, .on-text .on-p[data-list][data-align="center"]::before, .on-text .on-p[data-list][data-align="right"]::before { position: static; display: inline-block; width: auto; min-width: 1em; margin-right: 0.45em; vertical-align: baseline; }
.on-text.on-a-center .on-p[data-list="check"]:not([data-align="left"])::before, .on-text.on-a-right .on-p[data-list="check"]:not([data-align="left"])::before, .on-text .on-p[data-list="check"][data-align="center"]::before, .on-text .on-p[data-list="check"][data-align="right"]::before { width: 1.1em; height: 1.1em; vertical-align: -0.2em; }
`;

// The page's own copy of the CSS.
if (typeof document !== 'undefined' && !document.getElementById('on-rich-text-css')) {
  const style = document.createElement('style');
  style.id = 'on-rich-text-css';
  style.textContent = RICH_TEXT_CSS;
  document.head.appendChild(style);
}
