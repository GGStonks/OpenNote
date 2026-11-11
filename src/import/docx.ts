/**
 * Word documents (.docx, Office Open XML): each paragraph becomes a rich text box (editor/richText.ts)
 * on pages of the document's own size, laid out as Word lays them out from the top margin down.
 *
 * Read: the document's text in paragraphs and tables; run styles (bold, italic, underline,
 * strike-through, colour, size, typeface) resolved through the document defaults, paragraph styles
 * and character styles (headings, titles); paragraph alignment, indent level, spacing before and
 * after, line spacing; bulleted and numbered lists (numbering.xml: the number of each item counted
 * as Word counts it); page breaks; pictures (inline and floating, in the flow where they are
 * anchored); tables as a box per cell with ruled lines. Not read: headers and footers, footnotes,
 * comments, tracked deletions (left out, as Word shows the document without them), text boxes,
 * charts and equations (named in `skipped`).
 *
 * Heights come from `deps.measure` (the page's own text layout: a box drawn off screen), so boxes
 * never overlap; without it (tests) from an estimate.
 */
import type { ImageBlock, ListKind, PageSheet, Stroke, TextBlock, TextFont, TextPara, TextSpan } from '../types';
import { newId } from '../types';
import { readZip, ZipEntry } from './zip';
import { fontFromName } from '../editor/textStyle';
import { compactParas } from '../editor/richText';
import { PAGE_SIZES } from '../editor/pageSetup';

export interface DocxImport {
  sheets: PageSheet[];
  textBlocks: TextBlock[];
  imageBlocks: ImageBlock[];
  /** Table rules. */
  strokes: Stroke[];
  /** What the document had that is not imported. */
  skipped: string[];
  pages: number;
}

export interface DocxDeps {
  readImage(blob: Blob): Promise<{ dataUrl: string; w: number; h: number }>;
  /** The height (page px) of a text box as the page draws it. */
  measure?(t: TextBlock): number;
}

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
/** Twentieths of a point (twips) to page px (96 per inch). */
const TW = 1 / 15;
/** English Metric Units (pictures) to page px. */
const EMU = 96 / 914400;

/** A run's look. */
interface RunLook {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string;
  /** Points. */
  size?: number;
  font?: string;
}

interface ParaLook {
  align?: 'left' | 'center' | 'right';
  numId?: string;
  ilvl?: number;
  /** px */
  before?: number;
  after?: number;
  /** Multiple of single spacing. */
  line?: number;
  /** px */
  indent?: number;
  pageBreakBefore?: boolean;
  /** Word's "don't add space between paragraphs of the same style". */
  contextual?: boolean;
}

interface Style {
  basedOn?: string;
  run: RunLook;
  para: ParaLook;
}

/** The children of `el` named `name` in the WordprocessingML namespace. */
const kids = (el: Element | null | undefined, name: string): Element[] =>
  el ? Array.from(el.children).filter((c) => c.localName === name && (c.namespaceURI === W || !c.namespaceURI)) : [];
const kid = (el: Element | null | undefined, name: string): Element | null => kids(el, name)[0] ?? null;
const attr = (el: Element | null | undefined, name: string): string | null => el?.getAttributeNS(W, name) ?? el?.getAttribute(`w:${name}`) ?? null;
const num = (v: string | null): number | undefined => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);

/** A toggle property (<w:b/>, <w:b w:val="0"/>). */
function toggle(el: Element | null): boolean | undefined {
  if (!el) return undefined;
  const v = attr(el, 'val');
  return !(v === '0' || v === 'false' || v === 'off');
}

function readRun(rPr: Element | null): RunLook {
  if (!rPr) return {};
  const out: RunLook = {};
  const b = toggle(kid(rPr, 'b')), i = toggle(kid(rPr, 'i')), s = toggle(kid(rPr, 'strike')) ?? toggle(kid(rPr, 'dstrike'));
  if (b !== undefined) out.bold = b;
  if (i !== undefined) out.italic = i;
  if (s !== undefined) out.strike = s;
  const u = kid(rPr, 'u');
  if (u) out.underline = attr(u, 'val') !== 'none';
  const c = attr(kid(rPr, 'color'), 'val');
  if (c && /^[0-9a-f]{6}$/i.test(c)) out.color = `#${c.toUpperCase()}`;
  const sz = num(attr(kid(rPr, 'sz'), 'val'));
  if (sz) out.size = sz / 2;
  const f = kid(rPr, 'rFonts');
  const font = attr(f, 'ascii') ?? attr(f, 'hAnsi') ?? attr(f, 'cs');
  if (font) out.font = font;
  return out;
}

function readPara(pPr: Element | null): ParaLook {
  if (!pPr) return {};
  const out: ParaLook = {};
  const jc = attr(kid(pPr, 'jc'), 'val');
  if (jc === 'center') out.align = 'center';
  else if (jc === 'right' || jc === 'end') out.align = 'right';
  else if (jc) out.align = 'left';
  const np = kid(pPr, 'numPr');
  if (np) {
    const id = attr(kid(np, 'numId'), 'val');
    if (id != null) out.numId = id;
    const l = num(attr(kid(np, 'ilvl'), 'val'));
    if (l != null) out.ilvl = l;
  }
  const sp = kid(pPr, 'spacing');
  if (sp) {
    const b = num(attr(sp, 'before')), a = num(attr(sp, 'after')), line = num(attr(sp, 'line'));
    if (b != null && attr(sp, 'beforeAutospacing') !== '1') out.before = b * TW;
    if (a != null && attr(sp, 'afterAutospacing') !== '1') out.after = a * TW;
    const rule = attr(sp, 'lineRule');
    if (line != null && (!rule || rule === 'auto')) out.line = line / 240;
  }
  const ind = kid(pPr, 'ind');
  const left = num(attr(ind, 'left') ?? attr(ind, 'start'));
  if (left != null) out.indent = left * TW;
  const pb = toggle(kid(pPr, 'pageBreakBefore'));
  if (pb !== undefined) out.pageBreakBefore = pb;
  const cs = toggle(kid(pPr, 'contextualSpacing'));
  if (cs !== undefined) out.contextual = cs;
  return out;
}

/** Word's own sizes and weights for the built-in heading styles when styles.xml has none. */
const BUILTIN: Record<string, RunLook> = {
  title: { size: 28 },
  subtitle: { size: 15, color: '#5A5A5A' },
  heading1: { size: 20, bold: true },
  heading2: { size: 16, bold: true },
  heading3: { size: 14, bold: true },
  heading4: { size: 12, bold: true, italic: true },
};

class Doc {
  styles = new Map<string, Style>();
  defaults: Style = { run: { size: 11 }, para: { after: 8 * (96 / 72), line: 1.08 } };
  /** numId -> level -> format. */
  numbering = new Map<string, Map<number, { fmt: string; start: number; text: string }>>();
  /** numId -> counts per level (Word counts each list's items across the document). */
  counters = new Map<string, number[]>();

  constructor(stylesXml: Document | null, numberingXml: Document | null) {
    if (stylesXml) {
      const root = stylesXml.documentElement;
      const dd = kid(root, 'docDefaults');
      const rd = kid(kid(dd, 'rPrDefault'), 'rPr'), pd = kid(kid(dd, 'pPrDefault'), 'pPr');
      // A document without docDefaults is Word 2003's: 10 pt, single spaced, no space after.
      if (dd) this.defaults = { run: { size: 10, ...readRun(rd) }, para: { ...readPara(pd) } };
      for (const s of kids(root, 'style')) {
        const id = attr(s, 'styleId');
        if (!id) continue;
        this.styles.set(id, { basedOn: attr(kid(s, 'basedOn'), 'val') ?? undefined, run: readRun(kid(s, 'rPr')), para: readPara(kid(s, 'pPr')) });
      }
    }
    if (numberingXml) {
      const root = numberingXml.documentElement;
      const abstract = new Map<string, Map<number, { fmt: string; start: number; text: string }>>();
      for (const a of kids(root, 'abstractNum')) {
        const levels = new Map<number, { fmt: string; start: number; text: string }>();
        for (const l of kids(a, 'lvl')) {
          levels.set(num(attr(l, 'ilvl')) ?? 0, { fmt: attr(kid(l, 'numFmt'), 'val') ?? 'decimal', start: num(attr(kid(l, 'start'), 'val')) ?? 1, text: attr(kid(l, 'lvlText'), 'val') ?? '' });
        }
        abstract.set(attr(a, 'abstractNumId') ?? '', levels);
      }
      for (const n of kids(root, 'num')) {
        const levels = abstract.get(attr(kid(n, 'abstractNumId'), 'val') ?? '');
        if (levels) this.numbering.set(attr(n, 'numId') ?? '', levels);
      }
    }
  }

  /** A style's run and paragraph look with what it is based on (`seen`: a loop in basedOn ends it). */
  style(id: string | null | undefined, seen = new Set<string>()): Style {
    if (!id || seen.has(id)) return { run: {}, para: {} };
    seen.add(id);
    const s = this.styles.get(id);
    const builtin = BUILTIN[id.toLowerCase()] ?? {};
    if (!s) return { run: builtin, para: {} };
    const base = this.style(s.basedOn, seen);
    return { run: { ...builtin, ...base.run, ...s.run }, para: { ...base.para, ...s.para } };
  }

  /** The list marker kind and number of a paragraph in list numId at level ilvl. */
  listItem(numId: string, ilvl: number): { kind: ListKind; number: number } | null {
    const levels = this.numbering.get(numId);
    if (!levels || numId === '0') return null;
    const lvl = levels.get(ilvl) ?? levels.get(0);
    if (!lvl || lvl.fmt === 'none') return null;
    const counts = this.counters.get(numId) ?? [];
    counts[ilvl] = (counts[ilvl] ?? lvl.start - 1) + 1;
    counts.length = ilvl + 1; // deeper levels start again
    this.counters.set(numId, counts);
    const kind: ListKind = lvl.fmt === 'bullet' ? 'bullet' : /letter/i.test(lvl.fmt) ? 'letter' : 'number';
    return { kind, number: counts[ilvl] };
  }
}

/** One piece of a paragraph, in reading order. */
type Piece = { text: string; look: RunLook } | { image: string; w: number; h: number } | { pageBreak: true };

/** The pieces of a paragraph (runs, hyperlinks, fields, insertions; deletions left out). */
function piecesOf(p: Element, doc: Doc, paraRun: RunLook, skipped: Set<string>): Piece[] {
  const out: Piece[] = [];
  const walk = (el: Element) => {
    for (const c of Array.from(el.children)) {
      const n = c.localName;
      if (n === 'r') run(c);
      else if (n === 'hyperlink' || n === 'ins' || n === 'smartTag' || n === 'fldSimple' || n === 'customXml' || n === 'bdo' || n === 'dir') walk(c);
      else if (n === 'sdt') walk(kid(c, 'sdtContent') ?? c);
      else if (n === 'oMath' || n === 'oMathPara') skipped.add('equations');
    }
  };
  const run = (r: Element) => {
    const rPr = kid(r, 'rPr');
    const charStyle = doc.style(attr(kid(rPr, 'rStyle'), 'val')).run;
    const look = { ...paraRun, ...charStyle, ...readRun(rPr) };
    for (const c of Array.from(r.children)) {
      const n = c.localName;
      if (n === 't') out.push({ text: c.textContent ?? '', look });
      else if (n === 'tab' || n === 'ptab') out.push({ text: '\t', look });
      else if (n === 'br' || n === 'cr') {
        if (attr(c, 'type') === 'page') out.push({ pageBreak: true });
        else out.push({ text: '\n', look });
      } else if (n === 'noBreakHyphen') out.push({ text: '‑', look });
      else if (n === 'softHyphen') out.push({ text: '­', look });
      else if (n === 'sym') {
        const ch = attr(c, 'char');
        if (ch) out.push({ text: String.fromCharCode(parseInt(ch, 16) & 0xffff), look });
      } else if (n === 'drawing' || n === 'pict' || n === 'object') {
        const pic = pictureOf(c);
        if (pic) out.push(pic);
        else if (c.getElementsByTagNameNS('*', 'txbxContent').length) skipped.add('text boxes');
        else if (c.getElementsByTagNameNS('*', 'chart').length) skipped.add('charts');
        else skipped.add('drawings');
      } else if (n === 'footnoteReference' || n === 'endnoteReference') skipped.add('footnotes');
    }
  };
  walk(p);
  return out;
}

/** A picture's relationship id and size (page px). */
function pictureOf(el: Element): { image: string; w: number; h: number } | null {
  const blip = el.getElementsByTagNameNS('*', 'blip')[0];
  const rid = blip?.getAttributeNS(R, 'embed') ?? blip?.getAttribute('r:embed') ?? null;
  const ext = el.getElementsByTagNameNS('*', 'extent')[0];
  if (rid) {
    const cx = num(ext?.getAttribute('cx') ?? null), cy = num(ext?.getAttribute('cy') ?? null);
    return { image: rid, w: (cx ?? 0) * EMU, h: (cy ?? 0) * EMU };
  }
  // VML (older documents): <v:imagedata r:id="…"/> in a shape whose style gives its size in pt.
  const vml = el.getElementsByTagNameNS('*', 'imagedata')[0];
  const vid = vml?.getAttributeNS(R, 'id') ?? vml?.getAttribute('r:id') ?? null;
  if (!vid) return null;
  const style = vml!.parentElement?.getAttribute('style') ?? '';
  const pt = (k: string) => {
    const m = new RegExp(`${k}:\\s*([\\d.]+)pt`).exec(style);
    return m ? Number(m[1]) * (96 / 72) : 0;
  };
  return { image: vid, w: pt('width'), h: pt('height') };
}

/** A run look as the text box draws it. */
function boxLook(l: RunLook) {
  const f = fontFromName(l.font ?? 'Helvetica Neue');
  return {
    family: f.family as TextFont,
    bold: !!l.bold || f.bold,
    italic: !!l.italic || f.italic,
    underline: !!l.underline,
    strike: !!l.strike,
    color: l.color ?? '#000000',
    size: Math.round((l.size ?? 11) * (96 / 72) * 10) / 10,
  };
}

/** Text pieces as one text box's text, its style (the most used look) and the other looks as spans. */
function richOf(pieces: { text: string; look: RunLook }[]) {
  let text = '';
  const ranges: { start: number; end: number; l: ReturnType<typeof boxLook> }[] = [];
  for (const p of pieces) {
    if (!p.text) continue;
    ranges.push({ start: text.length, end: text.length + p.text.length, l: boxLook(p.look) });
    text += p.text;
  }
  const weight = new Map<string, { l: ReturnType<typeof boxLook>; n: number }>();
  for (const r of ranges) {
    if (!text.slice(r.start, r.end).trim()) continue;
    const k = JSON.stringify(r.l);
    const w = weight.get(k);
    if (w) w.n += r.end - r.start;
    else weight.set(k, { l: r.l, n: r.end - r.start });
  }
  const base = [...weight.values()].sort((a, b) => b.n - a.n)[0]?.l ?? ranges[0]?.l ?? boxLook({});
  const spans: TextSpan[] = [];
  for (const r of ranges) {
    const sp: TextSpan = { start: r.start, end: r.end };
    if (r.l.family !== base.family) sp.font = r.l.family;
    if (r.l.bold !== base.bold) sp.bold = r.l.bold;
    if (r.l.italic !== base.italic) sp.italic = r.l.italic;
    if (Math.abs(r.l.size - base.size) > 0.05) sp.size = r.l.size;
    if (r.l.color !== base.color) sp.color = r.l.color;
    if (r.l.underline !== base.underline) sp.underline = r.l.underline;
    if (r.l.strike !== base.strike) sp.strike = r.l.strike;
    if (Object.keys(sp).length > 2) spans.push(sp);
  }
  return { text, spans, base };
}

/** Page size and margins (page px) of a section (w:sectPr). */
function pageOf(sect: Element | null) {
  const sz = kid(sect, 'pgSz'), mar = kid(sect, 'pgMar');
  const w = (num(attr(sz, 'w')) ?? 12240) * TW, h = (num(attr(sz, 'h')) ?? 15840) * TW;
  const m = (k: string, d: number) => Math.max(0, Math.abs(num(attr(mar, k)) ?? d) * TW);
  return { w, h, top: m('top', 1440), bottom: m('bottom', 1440), left: m('left', 1440), right: m('right', 1440) };
}

/** A sheet of the page's size: a named format when it is one (to the px), else its own size. */
function sheetOf(w: number, h: number): PageSheet {
  for (const [id, s] of Object.entries(PAGE_SIZES)) {
    if (Math.abs(s.w - w) < 2 && Math.abs(s.h - h) < 2) return { id: newId('sheet'), size: id as PageSheet['size'], orientation: 'portrait', paperStyle: 'blank' };
    if (Math.abs(s.h - w) < 2 && Math.abs(s.w - h) < 2) return { id: newId('sheet'), size: id as PageSheet['size'], orientation: 'landscape', paperStyle: 'blank' };
  }
  return { id: newId('sheet'), width: Math.round(w * 100) / 100, height: Math.round(h * 100) / 100, paperStyle: 'blank' };
}

/** Line height of a paragraph's box: Word's single spacing is about 1.17 x the font size. */
const SINGLE = 1.17;

export async function importDocx(bytes: Uint8Array, deps: DocxDeps): Promise<DocxImport> {
  const entries = readZip(bytes);
  const byName = new Map<string, ZipEntry>(entries.map((e) => [e.name.replace(/^\/+/, ''), e]));
  const xml = async (name: string): Promise<Document | null> => {
    const e = byName.get(name);
    if (!e) return null;
    const d = new DOMParser().parseFromString(new TextDecoder().decode(await e.read()), 'application/xml');
    return d.getElementsByTagName('parsererror').length ? null : d;
  };
  const main = await xml('word/document.xml');
  if (!main) {
    if (byName.has('content.xml') && byName.has('mimetype')) throw new Error('an OpenDocument text (.odt): save it as Word (.docx) to import it');
    throw new Error('not a Word document (no word/document.xml)');
  }
  const rels = new Map<string, string>();
  const relsXml = await xml('word/_rels/document.xml.rels');
  for (const r of Array.from(relsXml?.getElementsByTagName('Relationship') ?? [])) {
    const target = r.getAttribute('Target') ?? '';
    if (r.getAttribute('TargetMode') === 'External') continue;
    rels.set(r.getAttribute('Id') ?? '', target.startsWith('/') ? target.slice(1) : `word/${target}`.replace(/\/\.\//g, '/'));
  }
  const doc = new Doc(await xml('word/styles.xml'), await xml('word/numbering.xml'));
  const skipped = new Set<string>();
  if (byName.has('word/header1.xml') || byName.has('word/footer1.xml')) skipped.add('headers and footers');
  if (byName.has('word/comments.xml')) skipped.add('comments');

  const body = kid(main.documentElement, 'body');
  if (!body) throw new Error('an empty Word document');
  const page = pageOf(kid(body, 'sectPr'));
  const contentW = Math.max(100, page.w - page.left - page.right);

  const textBlocks: TextBlock[] = [], imageBlocks: ImageBlock[] = [], strokes: Stroke[] = [];
  let pageIndex = 0;
  let y = page.top;
  let stamp = Date.now() - 1_000_000;
  const pageTop = () => pageIndex * page.h;
  const room = () => page.h - page.bottom - y;
  const newPage = () => {
    pageIndex++;
    y = page.top;
  };
  /** Room for `h` px on this page, or a new page (unless at a page's top already). */
  const fit = (h: number) => {
    if (h > room() && y > page.top + 0.5) newPage();
  };
  let lastAfter = 0, lastStyle: string | null = null;

  const measure = (t: TextBlock, lines: number): number => {
    if (deps.measure) return deps.measure(t);
    return lines * t.fontSize * (t.lineHeight ?? 1.35);
  };

  const images = new Map<string, Promise<{ dataUrl: string; w: number; h: number } | null>>();
  const image = (rid: string) => {
    let p = images.get(rid);
    if (!p) {
      const target = rels.get(rid);
      const e = target ? byName.get(target) : undefined;
      p = e
        ? e.read().then((b) => {
            const ext = (target!.split('.').pop() ?? '').toLowerCase();
            const type = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'svg' ? 'image/svg+xml' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
            if (ext === 'emf' || ext === 'wmf') {
              skipped.add('Windows metafile pictures');
              return null;
            }
            return deps.readImage(new Blob([b as Uint8Array<ArrayBuffer>], { type })).catch(() => {
              skipped.add('unreadable pictures');
              return null;
            });
          })
        : Promise.resolve(null);
      images.set(rid, p);
    }
    return p;
  };

  /** A text box of a paragraph's text (before any picture in it), placed at x within `w`. */
  const paraBox = (pieces: { text: string; look: RunLook }[], look: ParaLook, list: { kind: ListKind; number: number } | null, level: number, x: number, w: number): TextBlock | null => {
    const { text, spans, base } = richOf(pieces);
    if (!text.replace(/\s+/g, '')) return null;
    const lines = text.split('\n');
    const paras: TextPara[] = lines.map((_, i) => {
      const p: TextPara = {};
      if (i === 0 && list) {
        p.list = list.kind;
        if (list.kind !== 'bullet') p.num = list.number;
      }
      if (level) p.level = level;
      return p;
    });
    const lh = Math.round(Math.max(1, (look.line ?? 1) * SINGLE) * 1000) / 1000;
    return {
      id: newId('text'), x, y: 0, width: w, text,
      ...(spans.length ? { spans } : {}),
      ...(compactParas(paras) ? { paras: compactParas(paras) } : {}),
      fontSize: base.size, color: base.color,
      ...(base.family !== 'helvetica-neue' ? { fontFamily: base.family } : {}),
      ...(base.bold ? { bold: true } : {}), ...(base.italic ? { italic: true } : {}),
      ...(base.underline ? { underline: true } : {}), ...(base.strike ? { strike: true } : {}),
      ...(look.align && look.align !== 'left' ? { align: look.align } : {}),
      lineHeight: lh,
      createdAt: stamp++,
    };
  };

  /** Lays out one paragraph in the column at x, width w (the page's, or a table cell's when `into` is given). */
  const paragraph = async (p: Element, x: number, w: number, into?: TextBlock[]): Promise<void> => {
    const pPr = kid(p, 'pPr');
    const styleId = attr(kid(pPr, 'pStyle'), 'val');
    const st = doc.style(styleId);
    const look: ParaLook = { ...doc.defaults.para, ...st.para, ...readPara(pPr) };
    const runLook: RunLook = { ...doc.defaults.run, ...st.run, ...readRun(kid(pPr, 'rPr')) };
    // The paragraph mark's own run look counts only for an empty paragraph's height.
    const paraRun: RunLook = { ...doc.defaults.run, ...st.run };
    const list = look.numId != null ? doc.listItem(look.numId, look.ilvl ?? 0) : null;
    const level = Math.min(8, list ? (look.ilvl ?? 0) : Math.round((look.indent ?? 0) / (2.1 * 16)));
    const pieces = piecesOf(p, doc, paraRun, skipped);
    if (!into && look.pageBreakBefore) newPage();
    // Space before: Word adds the larger of the last paragraph's after and this one's before.
    const contextual = look.contextual && styleId === lastStyle;
    const before = contextual ? 0 : Math.max(lastAfter, look.before ?? 0);
    if (!into && y > page.top + 0.5) y += before - lastAfter;
    let text: { text: string; look: RunLook }[] = [];
    let placedAny = false;
    const flushText = () => {
      const box = paraBox(text, look, placedAny ? null : list, level, x, w);
      text = [];
      if (!box) return;
      placedAny = true;
      const h = measure(box, Math.max(1, Math.ceil(box.text.length / Math.max(1, w / (box.fontSize * 0.5)))) + box.text.split('\n').length - 1);
      if (into) {
        into.push(box);
        return;
      }
      fit(h);
      box.y = pageTop() + y;
      textBlocks.push(box);
      y += h;
    };
    for (const piece of pieces) {
      if ('pageBreak' in piece) {
        if (into) continue;
        flushText();
        newPage();
        continue;
      }
      if ('image' in piece) {
        flushText();
        const pic = await image(piece.image);
        if (!pic) continue;
        let iw = piece.w || pic.w, ih = piece.h || pic.h;
        const s = Math.min(1, w / iw, into ? 1 : (page.h - page.top - page.bottom) / ih);
        iw *= s;
        ih *= s;
        const ix = look.align === 'center' ? x + (w - iw) / 2 : look.align === 'right' ? x + w - iw : x;
        if (into) continue; // pictures in tables: left out of the cell's text
        fit(ih);
        imageBlocks.push({ id: newId('image'), x: ix, y: pageTop() + y, width: iw, height: ih, dataUrl: pic.dataUrl, createdAt: stamp++ });
        y += ih;
        placedAny = true;
        continue;
      }
      text.push(piece);
    }
    flushText();
    if (!placedAny && !into) {
      // An empty paragraph: a blank line of its font.
      const size = boxLook(runLook).size;
      const h = size * Math.max(1, (look.line ?? 1) * SINGLE);
      fit(h);
      y += h;
    }
    if (!into) {
      lastAfter = contextual ? 0 : look.after ?? 0;
      y += lastAfter;
      lastStyle = styleId;
    }
  };

  /** A table: each row's cells side by side (columns from the table's grid), ruled. */
  const table = async (tbl: Element) => {
    const grid = kids(kid(tbl, 'tblGrid'), 'gridCol').map((g) => (num(attr(g, 'w')) ?? 0) * TW);
    const total = grid.reduce((a, b) => a + b, 0);
    const cols = grid.length && total > 0 ? grid.map((g) => (g / total) * Math.min(contentW, total)) : null;
    const PAD = 5;
    const rule = (x0: number, y0: number, x1: number, y1: number) =>
      strokes.push({
        id: newId('stroke'), createdAt: stamp++, tool: 'pen', color: '#9CA3AF', width: 0.6, opacity: 1, penStyle: 'ballpoint', lineStyle: 'solid',
        points: [{ x: x0, y: y0, pressure: 0.5 }, { x: x1, y: y1, pressure: 0.5 }], isShape: true, shapeKind: 'line',
      });
    if (y > page.top + 0.5) y += lastAfter ? 0 : 4;
    for (const tr of kids(tbl, 'tr')) {
      const cells = kids(tr, 'tc');
      const n = cols ? cols.length : Math.max(1, cells.length);
      const widthOf = (k: number, span: number) => (cols ? cols.slice(k, k + span).reduce((a, b) => a + b, 0) : (contentW / n) * span);
      const boxes: { x: number; w: number; blocks: TextBlock[] }[] = [];
      let col = 0;
      for (const tc of cells) {
        const span = num(attr(kid(kid(tc, 'tcPr'), 'gridSpan'), 'val')) ?? 1;
        const cx = page.left + (cols ? cols.slice(0, col).reduce((a, b) => a + b, 0) : (contentW / n) * col);
        const cw = widthOf(col, span);
        const blocks: TextBlock[] = [];
        for (const c of Array.from(tc.children)) {
          if (c.localName === 'p') await paragraph(c, cx + PAD, Math.max(10, cw - 2 * PAD), blocks);
          else if (c.localName === 'tbl') skipped.add('tables inside tables');
        }
        // A cell's paragraphs as one box.
        if (blocks.length) {
          const first = blocks[0];
          let text = '', spans: TextSpan[] = [];
          const paras: TextPara[] = [];
          for (const b of blocks) {
            if (text) text += '\n';
            const at = text.length;
            text += b.text;
            // Each paragraph's look where it differs from the cell's first paragraph.
            spans = spans.concat((b.spans ?? []).map((s) => ({ ...s, start: s.start + at, end: s.end + at })));
            const own: TextSpan = { start: at, end: at + b.text.length };
            if (b.fontSize !== first.fontSize) own.size = b.fontSize;
            if (!!b.bold !== !!first.bold) own.bold = !!b.bold;
            if (!!b.italic !== !!first.italic) own.italic = !!b.italic;
            if (b.color !== first.color) own.color = b.color;
            if (b.fontFamily !== first.fontFamily) own.font = b.fontFamily ?? 'helvetica-neue';
            if (Object.keys(own).length > 2) spans.unshift(own);
            const bp = b.paras ?? [];
            b.text.split('\n').forEach((_, i) => paras.push({ ...(bp[i] ?? {}), ...(b.align && b.align !== first.align ? { align: b.align } : {}) }));
          }
          blocks.length = 0;
          blocks.push({ ...first, text, ...(spans.length ? { spans } : { spans: undefined }), paras: compactParas(paras), createdAt: stamp++ });
        }
        boxes.push({ x: cx, w: cw, blocks });
        col += span;
      }
      const rowH = Math.max(18, ...boxes.map((b) => (b.blocks[0] ? measure(b.blocks[0], b.blocks[0].text.split('\n').length) : 0) + 2 * PAD));
      fit(rowH);
      const top = pageTop() + y;
      for (const b of boxes) for (const t of b.blocks) textBlocks.push({ ...t, y: top + PAD });
      const right = boxes.length ? boxes[boxes.length - 1].x + boxes[boxes.length - 1].w : page.left + contentW;
      rule(page.left, top, right, top);
      rule(page.left, top + rowH, right, top + rowH);
      for (const b of boxes) rule(b.x, top, b.x, top + rowH);
      rule(right, top, right, top + rowH);
      y += rowH;
    }
    lastAfter = 8;
    y += lastAfter;
    lastStyle = null;
  };

  for (const el of Array.from(body.children)) {
    if (el.localName === 'p') await paragraph(el, page.left, contentW);
    else if (el.localName === 'tbl') await table(el);
    else if (el.localName === 'sdt') {
      for (const c of Array.from(kid(el, 'sdtContent')?.children ?? [])) {
        if (c.localName === 'p') await paragraph(c, page.left, contentW);
        else if (c.localName === 'tbl') await table(c);
      }
    }
  }

  const pages = pageIndex + 1;
  const sheets = Array.from({ length: pages }, () => sheetOf(page.w, page.h));
  return { sheets, textBlocks, imageBlocks, strokes, skipped: [...skipped], pages };
}
