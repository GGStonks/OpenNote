import { ImageBlock, LatexBlock, ListKind, NotePage, PageSheet, PaperColor, PaperStyle, Point, Stroke, TextBlock, TextFont, TextPara, TextSpan, newId } from '../types';
import { fontFromName, fontStack } from '../editor/textStyle';
import { compactParas } from '../editor/richText';
import { ellipsePoints } from '../editor/shapeEdit';
import { TEXT_LINE_HEIGHT } from '../editor/textStyle';
import { KeyedArchive, PlistDate, PlistValue, parsePlist } from './plist';
import { ZipEntry, readZip } from './zip';

/**
 * Notability notes (.note) into OpenNote notes. What is read is described in
 * docs/notability-note-format.md: a ZIP holding Session.plist (a keyed archive: the note's ink,
 * shapes, pictures, text boxes, typed text, page layout and paper) with the files it refers to
 * (pictures, PDFs, recordings).
 *
 * The note is one tall surface in "document points", `W` of them wide; OpenNote pages are 816 px
 * wide, so everything is scaled by 816 / W. Plain pages are 1.3125 W high; a PDF page takes its
 * page's height at that width, rounded up to a whole point, and shows the PDF itself (kept in the
 * library's file store, drawn from its vectors). Each page becomes a page of exactly that size.
 * Each ink curve is a chain of cubic Béziers with one width factor per segment end.
 */

export interface NotabilityImport {
  title: string;
  createdAt: number;
  paperStyle: PaperStyle;
  paperColor: PaperColor;
  surface: NotePage;
  sheets: PageSheet[];
  /** Audio recordings of the note (Recordings/). */
  recordings: { name: string; bytes: Uint8Array; mime: string; durationMs: number; createdAt: number }[];
  /** What could not be imported (shown to the user). */
  skipped: string[];
  /** OpenNote px per Notability document point. */
  importScale: number;
  counts: { strokes: number; shapes: number; images: number; texts: number; pdfPages: number };
}

/** How the importer reaches the device (pictures need the web view, PDFs the file store). */
export interface NotabilityDeps {
  /** Decodes a picture, cut to `crop` (source px) and flipped. */
  readImage(blob: Blob, o: { crop?: { x: number; y: number; w: number; h: number } | null; cropUnit?: { w: number; h: number } | null; flipH?: boolean; flipV?: boolean }): Promise<{ dataUrl: string; w: number; h: number }>;
  /** Stores a PDF; its id and its pages' sizes (points, rotation applied). */
  storePdf(name: string, bytes: Uint8Array): Promise<{ fileId: string; sizes: { w: number; h: number }[] }>;
  /** A coloured rectangle as an image (stickies, text box backgrounds). */
  solidImage(color: string, w: number, h: number, radius: number): string;
}

/** OpenNote's page width (px): every page of the note is this wide. */
export const PAGE_PX = 816;
/** Document points of a page when the note does not say (iPad, the most common). */
const DEFAULT_W = 565;
/** Plain pages: height / width (612 x 803.25 pt in Notability's PDF export). */
const PLAIN_RATIO = 1.3125;
/** x = 0 is this much (of W) right of the page's left edge (Notability 2013: 20 of 768 points). */
const X_INSET = 20 / 768;
/** A PDF layout entry with this page number (or more) is a blank page (INT64_MAX; 0x7fffffff in old files). */
const BLANK_PAGE = 2 ** 31 - 1;
/** Text inside a text box starts this far from its corner (document points). */
export const BOX_PAD = { x: 5, y: 2 };
/** Line height of Notability's text (Helvetica Neue's), a multiple of the font size. */
const LINE = 1.2;

// curvesstyles: 1 selection, 2 partial eraser, 3 pen, 4 highlighter, 5 pencil, 6 not exported, 7 whole-object eraser.
const STYLE_HIGHLIGHTER = 4;
const STYLE_NOT_INK: Record<number, string> = { 1: 'selection', 2: 'partial eraser', 6: 'hidden', 7: 'eraser' };

/** Notability's paper textures (paper01-15), as their average colour: Legacy:N and paperIndex N - 1. */
export const TEXTURES = ['', '#FCF9F4', '#FCF5C9', '#DADBED', '#D4EBCF', '#FCC0B6', '#E9DBB0', '#DFE9EC', '#717171', '#EFCDA2', '#88689B', '#5F4534', '#47454C', '#FFFFFF', '#000F46', '#000000'];

export const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', heic: 'image/heic', tif: 'image/tiff', tiff: 'image/tiff', webp: 'image/webp' };

type Obj = { [k: string]: PlistValue };
const isObj = (v: PlistValue | undefined): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array) && !(v instanceof PlistDate);
const hex2 = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
const hexOf = (r: number, g: number, b: number) => `#${hex2(r * 255)}${hex2(g * 255)}${hex2(b * 255)}`.toUpperCase();

const PAIR = /^\{\s*(-?[\d.eE+-]+)\s*,\s*(-?[\d.eE+-]+)\s*\}$/;
const RECT = /^\{\{\s*(-?[\d.eE+-]+)\s*,\s*(-?[\d.eE+-]+)\s*\}\s*,\s*\{\s*(-?[\d.eE+-]+)\s*,\s*(-?[\d.eE+-]+)\s*\}\}$/;
const pair = (s: string | null): [number, number] | null => {
  const m = s ? PAIR.exec(s.trim()) : null;
  return m ? [+m[1], +m[2]] : null;
};
const rect = (s: string | null): { x: number; y: number; w: number; h: number } | null => {
  const m = s ? RECT.exec(s.trim()) : null;
  return m ? { x: +m[1], y: +m[2], w: +m[3], h: +m[4] } : null;
};

export async function importNotability(bytes: Uint8Array, fileName: string, deps: NotabilityDeps): Promise<NotabilityImport> {
  const entries = readZip(bytes);
  const session = entries.filter((e) => /(^|\/)Session\.plist$/.test(e.name)).sort((a, b) => a.name.length - b.name.length)[0];
  if (!session) throw new Error('This is not a Notability note (no Session.plist inside).');
  // The bundle's folder: files are named relative to it (its name is not always the note's).
  const base = session.name.slice(0, session.name.length - 'Session.plist'.length);
  const entry = (rel: string): ZipEntry | null => entries.find((e) => e.name === base + rel) ?? entries.find((e) => e.name.endsWith('/' + rel) || e.name === rel) ?? null;
  const ar = new KeyedArchive(parsePlist(await session.read()));
  const root = ar.root();
  const str = (o: PlistValue, k: string) => ar.string(ar.field(o, k));
  const num = (o: PlistValue, k: string) => ar.number(ar.field(o, k));
  const skipped: string[] = [];

  const title = ar.string(ar.field(root, 'name'))?.trim() || fileName.replace(/\.note$/i, '') || 'Notability note';
  const created = ar.field(root, 'creationDate');
  const createdAt = created instanceof PlistDate ? created.ms : typeof ar.field(created, 'NS.time') === 'number' ? new PlistDate(ar.field(created, 'NS.time') as number).ms : Date.now();

  let richText = ar.field(root, 'richText');
  if (!isObj(richText)) richText = [...ar.walk(root)].find((o) => 'Handwriting Overlay' in o) ?? null;

  // ---------------------------------------------------------------------------------- paper
  const model = ar.field(root, 'NBNoteTakingSessionDocumentPaperLayoutModelKey');
  const attrs = ar.field(model, 'documentPaperAttributes');
  const sizing = str(attrs, 'paperSizingBehavior') ?? '';
  const W =
    num(ar.field(richText, 'reflowState'), 'pageWidthInDocumentCoordsKey') ||
    Number(/^lockedWidth:([\d.]+)/.exec(sizing)?.[1]) ||
    ar.number(([...ar.walk(root)].find((o) => typeof ar.get(o.pageWidthInDocumentCoordsKey) === 'number') ?? {}).pageWidthInDocumentCoordsKey) ||
    DEFAULT_W;
  const s = PAGE_PX / W;
  const inset = W * X_INSET;
  const X = (x: number) => (x + inset) * s;
  const Y = (y: number) => y * s;
  const paperSize = (str(attrs, 'paperSize') ?? 'letter').toLowerCase();
  const plainH = /^staticWidth/.test(sizing) ? Math.floor(W * ({ a4: 297 / 210, a5: 210 / 148, legal: 14 / 8.5 }[paperSize] ?? 11 / 8.5)) : W * PLAIN_RATIO;

  const pid = str(attrs, 'paperIdentifier') ?? '';
  let paperHex = '#FFFFFF';
  let template: string | null = null;
  const colorId = /^Color:(#[0-9a-f]{6})/i.exec(pid);
  const legacy = /^Legacy:(\d+)/.exec(pid);
  const tpl = /^TemplatePDF:([^:]+)(?::(#[0-9a-f]{6}))?/i.exec(pid);
  if (colorId) paperHex = colorId[1].toUpperCase();
  else if (legacy) paperHex = TEXTURES[+legacy[1]] || '#FFFFFF';
  else if (tpl) {
    template = tpl[1];
    paperHex = (tpl[2] ?? '#FFFFFF').toUpperCase();
  } else {
    const idx = num(root, 'paperIndex');
    if (idx !== null && idx >= 0) paperHex = TEXTURES[idx + 1] || '#FFFFFF';
  }
  const paperColor: PaperColor = paperHex === '#FFFFFF' ? 'white' : (paperHex as PaperColor);
  // Lines: "Lines:<…>:<spacing in inches>"; other patterns by name.
  const lineStyle = str(attrs, 'lineStyle2') ?? '';
  let paperStyle: PaperStyle = 'blank';
  /** Spacing of the paper's lines (document points), the grid typed text sits on. */
  let lineSpacing: number | null = null;
  // "Lines:<margin>:<…>:<spacing in inches>".
  const lines = /^Lines:([^:]*):.*:([\d.]+)$/.exec(lineStyle);
  if (lines) {
    const margin = lines[1] === 'true';
    paperStyle = +lines[2] <= 0.28 ? (margin ? 'narrow' : 'narrowLines') : margin ? 'ruled' : 'lines';
    lineSpacing = (+lines[2] * 72 * W) / 612;
  } else if (/^(grid|squares)/i.test(lineStyle)) paperStyle = 'grid';
  else if (/^graph/i.test(lineStyle)) paperStyle = 'graph';
  else if (/^dot/i.test(lineStyle)) paperStyle = 'dots';
  else if (!attrs && (num(root, 'paperLineStyle') ?? 0) > 0) paperStyle = 'ruled';

  // -------------------------------------------------------------------------------- the PDFs
  const stored = new Map<string, Promise<{ fileId: string; sizes: { w: number; h: number }[] } | null>>();
  const pdfFile = (name: string) => {
    let p = stored.get(name);
    if (!p) {
      p = (async () => {
        const e = entry(`PDFs/${name}`) ?? entry(`PDFs/${name}.pdf`);
        if (!e) return null;
        try {
          return await deps.storePdf(name, await e.read());
        } catch {
          return null;
        }
      })();
      stored.set(name, p);
    }
    return p;
  };

  // ---------------------------------------------------------------------------------- pages
  let layout = ar.array(ar.field(model, 'pageLayoutArray'));
  if (!layout.length) layout = ar.array(ar.field(richText, 'pageLayoutArray'));
  const items = layout.map((l) => {
    const d = ar.dict(l);
    const n = ar.number(d.get('kPageLayoutPDFPageNumberKey') ?? null);
    const fileObj = d.get('kPageLayoutPDFFileKey') ?? null;
    const name = ar.string(d.get('kPageLayoutPDFFileNameKey') ?? null) ?? ar.string(ar.field(fileObj, 'pdfFileName'));
    const version = ar.number(ar.field(fileObj, 'version'));
    // A bookmarked page (Notability's page manager bookmarks).
    const bookmarked = ar.get(d.get('kPageLayoutPageIsBookmarkedKey') ?? null) === true;
    return { pdf: n !== null && n < BLANK_PAGE && name ? { pdf: name, page: n, version } : null, bookmarked };
  });
  // Page numbers are 1-based; a note holding a 0 counts from 0.
  const zeroBased = items.some((i) => i.pdf && i.pdf.page === 0);
  const sheets: PageSheet[] = [];
  let pdfPages = 0;
  let missingPdf = 0;
  let top = 0;
  const templateFile = template ? await pdfFile(`${template}.pdf`) : null;
  const plainSheet = (): PageSheet => ({
    id: newId('sheet'),
    width: PAGE_PX,
    height: plainH * s,
    ...(templateFile ? { pdf: { file: templateFile.fileId, page: 1 }, paperStyle: 'blank' as const } : {}),
  });
  for (const { pdf: it, bookmarked } of items) {
    const mark = bookmarked ? { bookmarked: true } : {};
    if (it) {
      const f = await pdfFile(it.pdf);
      const page = it.page + (zeroBased ? 1 : 0);
      const size = f?.sizes[page - 1];
      if (f && size) {
        // Version 1 (old notes): the page keeps its height in inches at 8.5 in wide.
        const h = Math.ceil(it.version === 1 ? (size.h * W) / 612 : (size.h * W) / size.w);
        sheets.push({ id: newId('sheet'), width: PAGE_PX, height: h * s, paperStyle: 'blank', pdf: { file: f.fileId, page }, ...mark });
        top += h;
        pdfPages++;
        continue;
      }
      missingPdf++;
    }
    sheets.push({ ...plainSheet(), ...mark });
    top += plainH;
  }
  if (missingPdf) skipped.push(`${missingPdf} PDF page${missingPdf === 1 ? '' : 's'} whose PDF is not in the file (blank pages instead)`);

  // ---------------------------------------------------------------------------------- ink
  /** Stamps in drawing order; pictures and text boxes go under the ink, as in Notability. */
  let order = 0, below = 0;
  const stamp = () => createdAt + order++;
  const stampBelow = () => createdAt - 1_000_000 + below++;
  const hash = ar.field(ar.field(richText, 'Handwriting Overlay'), 'SpatialHash');
  const store = isObj(hash) && 'curvespoints' in hash ? hash : [...ar.walk(root)].filter((o) => 'curvespoints' in o).sort((a, b) => (ar.number(b.numcurves) ?? 0) - (ar.number(a.numcurves) ?? 0))[0];
  const notInk: Record<string, number> = {};
  /** Curves, shapes and groups in Notability's order (shapes and groups have their place in it). */
  const sequence: (Stroke | Stroke[] | null)[] = [];
  let shapeCount = 0, unknownShapes = 0;
  if (store) {
    const curves = curvesToStrokes(ar, store, (x, y) => [X(x), Y(y)], s, notInk);
    const shapes = shapesOf(ar, store);
    const placed: (Stroke | Stroke[] | null)[] = new Array(curves.length + shapes.length).fill(undefined);
    const shapeStrokes = shapes.map((sh) => {
      const got = shapeToStrokes(sh.shape, sh.kind, (x, y) => [X(x), Y(y)], s);
      if (!got) unknownShapes++;
      else shapeCount += got.length;
      return got ?? [];
    });
    shapes.forEach((sh, i) => {
      const at = sh.index;
      if (at !== null && at >= 0 && at < placed.length && placed[at] === undefined) placed[at] = shapeStrokes[i];
      else placed.push(shapeStrokes[i]);
    });
    let c = 0;
    for (let i = 0; i < placed.length; i++) if (placed[i] === undefined) placed[i] = c < curves.length ? curves[c++] : null;
    while (c < curves.length) placed.push(curves[c++]);
    sequence.push(...placed);
    // Ink groups (Notability 16): nested curve stores and shapes under a transform, at their place.
    const groups = groupsOf(ar, store);
    for (const g of groups.sort((a, b) => a.index - b.index)) {
      const tf = (x: number, y: number): [number, number] => {
        const [a, b, cc, d, tx, ty] = g.transform;
        return [X(a * x + cc * y + tx), Y(b * x + d * y + ty)];
      };
      const k = Math.hypot(g.transform[0], g.transform[1]) || 1;
      const made: Stroke[] = [];
      for (const o of g.objects) {
        if (o.kind === 'curves') made.push(...curvesToStrokes(o.ar, o.store, tf, s * k, notInk).filter((x): x is Stroke => !!x));
        else {
          const got = shapeToStrokes(o.shape, o.shapeKind, tf, s * k);
          if (got) {
            made.push(...got);
            shapeCount += got.length;
          } else unknownShapes++;
        }
      }
      sequence.splice(Math.min(Math.max(0, g.index), sequence.length), 0, made);
    }
  }
  const strokes: Stroke[] = [];
  for (const x of sequence) for (const st of x === null ? [] : Array.isArray(x) ? x : [x]) strokes.push({ ...st, createdAt: stamp() });
  for (const [what, n] of Object.entries(notInk)) skipped.push(`${n} ${what} stroke${n === 1 ? '' : 's'}`);
  if (unknownShapes) skipped.push(`${unknownShapes} shape${unknownShapes === 1 ? '' : 's'} of an unknown kind`);

  // ------------------------------------------------------------------------- media objects
  const imageBlocks: ImageBlock[] = [];
  const textBlocks: TextBlock[] = [];
  const latexBlocks: LatexBlock[] = [];
  const media = ar.array(ar.field(richText, 'mediaObjects')).map((m, i) => ({ m, z: num(m, 'zIndex') ?? i, i }));
  media.sort((a, b) => a.z - b.z || a.i - b.i);
  const unsupported: Record<string, number> = {};
  for (const { m } of media) {
    const cls = ar.className(m) ?? 'unknown';
    const origin = pair(str(m, 'documentOrigin') ?? str(m, 'documentContentOrigin'));
    const size = pair(str(m, 'unscaledContentSize'));
    if (!origin || !size) {
      unsupported[cls] = (unsupported[cls] ?? 0) + 1;
      continue;
    }
    const box = { x: X(origin[0]), y: Y(origin[1]), w: size[0] * s, h: size[1] * s };
    const rotation = ((num(m, 'rotationDegrees') ?? 0) * 180) / Math.PI;
    const rot = Math.abs(rotation) > 0.01 ? { rotation: Math.round(rotation * 100) / 100 } : {};
    const background = mediaBackground(ar, m);
    const radius = num(m, 'cornerMode') === 2 ? 8 * s : 0;
    const isTextBox = /TextBlockMediaObject$/.test(cls);
    // A text box's colour is the box's own (TextBlock background); other objects' (stickies) a coloured rectangle.
    if (background && !isTextBox) {
      imageBlocks.push({ id: newId('image'), x: box.x, y: box.y, width: box.w, height: box.h, dataUrl: deps.solidImage(background, box.w, box.h, radius), ...rot, createdAt: stampBelow() });
    }
    if (/ImageMediaObject$/.test(cls)) {
      const pic = await mediaPicture(ar, m, entry, deps);
      if (pic) imageBlocks.push({ id: newId('image'), x: box.x, y: box.y, width: box.w, height: box.h, dataUrl: pic, ...rot, createdAt: stampBelow() });
      else skipped.push('a picture that could not be read');
    } else if (/MathMediaObject$/.test(cls)) {
      const latex = str(m, 'latex');
      if (latex?.trim()) {
        const color = uiColor(ar, ar.field(m, 'color'));
        latexBlocks.push({
          id: newId('latex'), x: box.x, y: box.y, width: box.w, height: box.h, latexCode: latex,
          scale: Math.round(Math.min(4, Math.max(0.5, box.h / 34)) * 100) / 100,
          ...(color && color !== '#000000' ? { color } : {}), ...rot, createdAt: stampBelow(),
        });
      }
    } else if (/TextBlockMediaObject$/.test(cls)) {
      const store = ar.field(m, 'textStore');
      const align = (['left', 'center', 'right'] as const)[num(store, 'formattedStringTextAlignmentKey') ?? 0] ?? 'left';
      const runs = attributed(ar, ar.field(store, 'attributedString'));
      textBlocks.push(...layOut(runs, { x: box.x, y: box.y, w: Math.max(20, box.w) }, s, align, rotation, stampBelow, null, { pad: [BOX_PAD.x * s, BOX_PAD.y * s], background, radius, height: box.h }));
    } else if (/CanvasMediaObject$/.test(cls)) {
      // A sticky note: its colour (above); its ink is with the rest.
      if (!background) unsupported[cls] = (unsupported[cls] ?? 0) + 1;
    } else {
      unsupported[cls] = (unsupported[cls] ?? 0) + 1;
    }
  }
  for (const [cls, n] of Object.entries(unsupported)) skipped.push(`${n} ${cls.replace(/^.*\./, '').replace(/MediaObject$/, '').toLowerCase() || 'unknown'} object${n === 1 ? '' : 's'}`);

  // Typed text of the note itself: it flows from the top of the first page on the paper's lines.
  let flow = attributed(ar, ar.field(richText, 'attributedString'));
  if (!flow.text.trim()) flow = attributed(ar, ar.field(ar.field(richText, 'NBAttributedBackingString'), 'NBAttributedBackingStringCodingKey'));
  if (flow.text.trim()) {
    textBlocks.push(...layOut(flow, { x: X(0), y: Y(3), w: (W - 2 * inset) * s }, s, 'left', 0, stampBelow, lineSpacing));
  }

  // ----------------------------------------------------------------------------- recordings
  const recordings = await recordingsOf(entry, entries, base, createdAt);

  // Pages: the laid out ones, then plain ones as far as the content reaches.
  let bottom = 0;
  for (const st of strokes) for (const p of st.points) bottom = Math.max(bottom, p.y);
  for (const b of [...imageBlocks, ...latexBlocks]) bottom = Math.max(bottom, b.y + b.height);
  for (const t of textBlocks) bottom = Math.max(bottom, t.y + (t.height ?? t.fontSize * TEXT_LINE_HEIGHT));
  // (A curve resting a point on the page's edge does not make a new page.)
  let laid = top * s;
  while (laid < bottom - 1 * s || !sheets.length) {
    sheets.push(plainSheet());
    laid += plainH * s;
  }

  return {
    title,
    createdAt,
    paperStyle,
    paperColor,
    surface: { id: newId('page'), pageNumber: 1, strokes, latexBlocks, textBlocks, imageBlocks },
    sheets,
    recordings,
    skipped,
    importScale: s,
    counts: { strokes: strokes.length - shapeCount, shapes: shapeCount, images: imageBlocks.length, texts: textBlocks.length, pdfPages },
  };
}

// ------------------------------------------------------------------------------------------ ink

type Tf = (x: number, y: number) => [number, number];

function bytesOf(ar: KeyedArchive, v: PlistValue): Uint8Array | null {
  const o = ar.get(v);
  if (o instanceof Uint8Array) return o;
  const d = ar.field(o, 'NS.data');
  return d instanceof Uint8Array ? d : null;
}

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** dashStyles: curve index -> 'dashed' / 'dotted'. */
function dashesOf(ar: KeyedArchive, store: Obj): Map<number, 'dashed' | 'dotted'> {
  const out = new Map<number, 'dashed' | 'dotted'>();
  const b = bytesOf(ar, store.dashStyles);
  if (!b || !b.length) return out;
  try {
    const p = parsePlist(b) as Obj;
    const pats = (p?.objectPatterns ?? {}) as Obj;
    for (const [k, v] of Object.entries(pats)) {
      const pat = isObj(v) ? v.pattern : null;
      if (pat === 1) out.set(+k, 'dashed');
      else if (pat === 2) out.set(+k, 'dotted');
    }
  } catch {
    /* solid */
  }
  return out;
}

/** The curves of a curve store, in order (null where a curve is not ink). `ws`: px per width point. */
function curvesToStrokes(ar: KeyedArchive, store: Obj, tf: Tf, ws: number, notInk: Record<string, number>): (Stroke | null)[] {
  const pts = bytesOf(ar, store.curvespoints), counts = bytesOf(ar, store.curvesnumpoints);
  if (!pts || !counts) return [];
  const widths = bytesOf(ar, store.curveswidth), colors = bytesOf(ar, store.curvescolors);
  const fws = bytesOf(ar, store.curvesfractionalwidths), styles = bytesOf(ar, store.curvesstyles);
  const dashes = dashesOf(ar, store);
  const P = view(pts), C = view(counts), Wv = widths ? view(widths) : null, F = fws ? view(fws) : null;
  const nCurves = Math.floor(counts.length / 4), nPoints = Math.floor(pts.length / 8), nFw = fws ? Math.floor(fws.length / 4) : 0;
  const out: (Stroke | null)[] = [];
  let p0 = 0, f0 = 0;
  for (let c = 0; c < nCurves; c++) {
    const n = C.getInt32(c * 4, true);
    const k = Math.floor((n - 1) / 3) + 1;
    const start = p0, fstart = f0;
    p0 += Math.max(0, n);
    f0 += Math.max(0, k);
    if (n <= 0 || p0 > nPoints) {
      out.push(null);
      continue;
    }
    let color = '#000000', alpha = 1;
    if (colors && c * 4 + 4 <= colors.length) {
      color = `#${hex2(colors[c * 4])}${hex2(colors[c * 4 + 1])}${hex2(colors[c * 4 + 2])}`.toUpperCase();
      alpha = colors[c * 4 + 3] / 255;
    }
    // Styles may be missing (old notes) or shorter than the curves: a see-through curve is a highlighter.
    const style = styles && c < styles.length && styles[c] >= 1 && styles[c] <= 7 ? styles[c] : alpha < 1 ? STYLE_HIGHLIGHTER : 3;
    if (STYLE_NOT_INK[style]) {
      notInk[STYLE_NOT_INK[style]] = (notInk[STYLE_NOT_INK[style]] ?? 0) + 1;
      out.push(null);
      continue;
    }
    const xy = (i: number) => {
      const [x, y] = tf(P.getFloat32((start + i) * 8, true), P.getFloat32((start + i) * 8 + 4, true));
      return { x, y };
    };
    const fw = (j: number) => (F && fstart + j < nFw ? F.getFloat32((fstart + j) * 4, true) : 1) || 1;
    const base = (Wv && c * 4 + 4 <= widths!.length ? Wv.getFloat32(c * 4, true) : 2) * ws;

    // The centre line: each cubic segment flattened, the width interpolated along it.
    const line: { x: number; y: number; d: number }[] = [];
    if (n === 1) line.push({ ...xy(0), d: base * fw(0) });
    else {
      let j = 0;
      for (; 3 * j + 3 < n; j++) {
        const a = xy(3 * j), b = xy(3 * j + 1), cc = xy(3 * j + 2), e = xy(3 * j + 3);
        const len = Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(cc.x - b.x, cc.y - b.y) + Math.hypot(e.x - cc.x, e.y - cc.y);
        const m = Math.max(1, Math.min(64, Math.ceil(len / 1.5)));
        const fa = fw(j), fb = fw(j + 1);
        for (let i = line.length ? 1 : 0; i <= m; i++) {
          const t = i / m, u = 1 - t;
          line.push({
            x: u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * cc.x + t * t * t * e.x,
            y: u * u * u * a.y + 3 * u * u * t * b.y + 3 * u * t * t * cc.y + t * t * t * e.y,
            d: base * (fa + (fb - fa) * t),
          });
        }
      }
      // Points left over that do not make a whole segment: straight on.
      for (let i = 3 * j + (line.length ? 1 : 0); i < n; i++) line.push({ ...xy(i), d: base * fw(Math.min(j, k - 1)) });
    }
    out.push(line.length ? strokeFromLine(line, { color, alpha, highlighter: style === STYLE_HIGHLIGHTER, dash: dashes.get(c) }) : null);
  }
  return out;
}

/**
 * A stroke from its centre line (OpenNote px) and the drawn width at each point (`d`, px): a
 * highlighter, a constant-width line or a variable-width one (shared with the .ntb importer).
 */
export function strokeFromLine(
  line: { x: number; y: number; d: number }[],
  o: { color: string; alpha: number; highlighter: boolean; dash?: 'dashed' | 'dotted' }
): Stroke {
  const { color, alpha, dash } = o;
  const ds = line.map((q) => Math.max(0.3, q.d));
  const dMax = Math.max(...ds), dMin = Math.min(...ds);
  const common = { id: newId('stroke'), createdAt: 0, color, lineStyle: dash ?? ('solid' as const) };
  const flat = (q: { x: number; y: number }, i: number): Point => ({ x: q.x, y: q.y, pressure: 0.5, t: i * 8 });
  if (o.highlighter) {
    // OpenNote draws highlighters 5.5 x their width, as see-through as the curve's colour says.
    // One width (OpenNote's highlighters have one): the body's, not a wider blob at an end.
    const body = [...ds].sort((x, y) => x - y)[ds.length >> 1];
    return { ...common, tool: 'highlighter', width: body / 5.5, opacity: 1, penStyle: 'ballpoint', modeled: 'uniform', highlightAlpha: alpha < 1 ? Math.max(0.15, alpha) : 0.42, points: line.map(flat) };
  }
  if (dash || dMax - dMin < 0.02 * dMax) {
    // Constant width (and dashed lines): a ballpoint line exactly that wide (strokeWidth = width x 1.5).
    return { ...common, tool: 'pen', width: dMax / 1.5, opacity: alpha, penStyle: 'ballpoint', modeled: 'uniform', points: line.map(flat) };
  }
  // Variable width: each point's width as a share of the widest ('proportional'; a fountain
  // line is width x 1.4 wide at its widest).
  const points: Point[] = ds.map((d, i) => ({ x: line[i].x, y: line[i].y, pressure: d / dMax, t: i * 8 }));
  return { ...common, tool: 'pen', width: dMax / 1.4, opacity: alpha, penStyle: 'fountain', modeled: 'proportional', points };
}

// ---------------------------------------------------------------------------------------- shapes

interface ShapeEntry {
  shape: Obj;
  kind: string;
  /** Its place among the curves (curves and shapes counted together); null: after them. */
  index: number | null;
}

const KIND_NAMES = ['line', 'square', 'rectangle', 'triangle', 'polygon', 'ellipse', 'circle', '', 'partialshape'];

function shapesOf(ar: KeyedArchive, store: Obj): ShapeEntry[] {
  const b = bytesOf(ar, store.shapes);
  if (!b || !b.length) return [];
  try {
    const p = parsePlist(b) as Obj;
    const shapes = (Array.isArray(p.shapes) ? p.shapes : []) as PlistValue[];
    const kinds = (Array.isArray(p.kinds) ? p.kinds : []) as PlistValue[];
    const indices = (Array.isArray(p.indices) ? p.indices : []) as PlistValue[];
    return shapes.flatMap((sh, i) =>
      isObj(sh)
        ? [{ shape: sh, kind: typeof kinds[i] === 'number' ? KIND_NAMES[kinds[i] as number] ?? '' : String(kinds[i] ?? ''), index: typeof indices[i] === 'number' ? (indices[i] as number) : null }]
        : []
    );
  } catch {
    return [];
  }
}

const isPt = (v: PlistValue | undefined): v is [number, number] => Array.isArray(v) && v.length >= 2 && typeof v[0] === 'number' && typeof v[1] === 'number';

function rgbaOf(v: PlistValue | undefined): { color: string; alpha: number } | null {
  const c = isObj(v) ? v.rgba ?? v.components : v;
  if (Array.isArray(c) && c.length >= 3 && c.every((x) => typeof x === 'number')) {
    const [r, g, b, a = 1] = c as number[];
    const sc = Math.max(r, g, b) > 1 ? 1 / 255 : 1;
    return { color: hexOf(r * sc, g * sc, b * sc), alpha: a > 1 ? a / 255 : a };
  }
  return null;
}

/** Flattens a quadratic (start, control, end) into points. */
function quadPoints(a: [number, number], c: [number, number], b: [number, number], n = 32): [number, number][] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n, u = 1 - t;
    return [u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]];
  });
}

/** The subpaths of an Apple CGPath archive (magic 25 b3 e5 48: element count, element kinds, float64 points). */
function cgPathParts(b: Uint8Array): { pts: [number, number][]; closed: boolean }[] {
  if (b.length < 8 || b[0] !== 0x25 || b[1] !== 0xb3 || b[2] !== 0xe5 || b[3] !== 0x48) return [];
  const dv = view(b);
  const n = dv.getUint32(4, true);
  let at = 8 + n;
  const pt = (): [number, number] => {
    const p: [number, number] = [dv.getFloat64(at, true), dv.getFloat64(at + 8, true)];
    at += 16;
    return p;
  };
  const parts: { pts: [number, number][]; closed: boolean }[] = [];
  let cur: { pts: [number, number][]; closed: boolean } | null = null;
  for (let i = 0; i < n; i++) {
    const kind = b[8 + i];
    if (at + 16 > b.length && kind !== 4) break;
    if (kind === 0) {
      cur = { pts: [pt()], closed: false };
      parts.push(cur);
    } else if (!cur) break;
    else if (kind === 1) cur.pts.push(pt());
    else if (kind === 2) {
      const c = pt(), e = pt();
      cur.pts.push(...quadPoints(cur.pts[cur.pts.length - 1], c, e, 16).slice(1));
    } else if (kind === 3) {
      const c1 = pt(), c2 = pt(), e = pt();
      const a = cur.pts[cur.pts.length - 1];
      for (let k = 1; k <= 16; k++) {
        const t = k / 16, u = 1 - t;
        cur.pts.push([
          u * u * u * a[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * e[0],
          u * u * u * a[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * e[1],
        ]);
      }
    } else if (kind === 4) cur.closed = true;
    else break;
  }
  return parts.filter((p) => p.pts.length >= 1);
}

/** A shape as strokes (several for a shape erased in parts); null for a kind not understood. */
function shapeToStrokes(sh: Obj, kind: string, tf: Tf, ws: number): Stroke[] | null {
  const ap = isObj(sh.appearance) ? sh.appearance : {};
  const stroke = rgbaOf(ap.strokeColor) ?? { color: '#000000', alpha: 1 };
  const fill = rgbaOf(ap.fillColor);
  const width = (typeof ap.strokeWidth === 'number' ? ap.strokeWidth : 2) * ws;
  const dashStyle = isObj(ap.dashStyle) ? ap.dashStyle : {};
  const lineStyle = dashStyle.pattern === 1 ? 'dashed' : dashStyle.pattern === 2 ? 'dotted' : 'solid';
  const P = (p: [number, number]): Point => {
    const [x, y] = tf(p[0], p[1]);
    return { x, y, pressure: 0.5 };
  };
  const base = (points: Point[], closed: boolean, shapeKind: Stroke['shapeKind']): Stroke => ({
    id: newId('stroke'), createdAt: 0, tool: 'pen', color: stroke.color, width: width / 1.5, opacity: stroke.alpha, penStyle: 'ballpoint', lineStyle,
    points, isShape: true, closed, shapeKind,
    ...(closed && fill ? { fill: 'solid' as const, fillColor: fill.color, fillOpacity: fill.alpha } : {}),
  });
  switch (kind) {
    case 'line': {
      const a = sh.startPt, b = sh.endPt, c = sh.controlPoint1;
      if (!isPt(a) || !isPt(b)) return null;
      const pts = isPt(c) ? quadPoints(a, c, b) : [a, b];
      const st = base(pts.map(P), false, isPt(c) ? 'polyline' : 'line');
      if (dashStyle.arrowHead === 1 || dashStyle.arrowHead === true) st.arrow = true;
      return [st];
    }
    case 'rectangle':
    case 'square':
    case 'triangle':
    case 'polygon': {
      const pts = sh.points;
      if (!Array.isArray(pts) || pts.length < 2 || !pts.every(isPt)) return null;
      const closed = sh.isClosed !== false;
      return [base((pts as [number, number][]).map(P), closed, kind === 'triangle' ? 'triangle' : kind === 'polygon' ? 'polygon' : 'rectangle')];
    }
    case 'circle':
    case 'ellipse': {
      const rr = isObj(sh.rotatedRect) ? sh.rotatedRect.corners : null;
      let corners: [number, number][] | null = Array.isArray(rr) && rr.length === 4 && rr.every(isPt) ? (rr as [number, number][]) : null;
      if (!corners && Array.isArray(sh.rect) && isPt(sh.rect[0]) && isPt(sh.rect[1])) {
        const [[x, y], [w, h]] = sh.rect as [[number, number], [number, number]];
        corners = [[x, y + h], [x + w, y + h], [x + w, y], [x, y]];
      }
      if (!corners) return null;
      const c = corners.map(P);
      const ctr = { x: (c[0].x + c[1].x + c[2].x + c[3].x) / 4, y: (c[0].y + c[1].y + c[2].y + c[3].y) / 4 };
      const ax = { x: (c[1].x - c[0].x) / 2, y: (c[1].y - c[0].y) / 2 };
      const rb = Math.hypot(c[3].x - c[0].x, c[3].y - c[0].y) / 2;
      return [base(ellipsePoints(ctr, ax, rb, 72), true, kind === 'circle' ? 'circle' : 'ellipse')];
    }
    case 'partialshape': {
      // What is left of a shape erased in parts: its centre line, piece by piece.
      const b = sh.outlinePath instanceof Uint8Array ? sh.outlinePath : null;
      const parts = b ? cgPathParts(b) : [];
      if (!parts.length) return null;
      return parts.map((p) => base(p.pts.map(P), p.closed && p.pts.length > 2, 'polyline'));
    }
    default:
      return null;
  }
}

interface Group {
  index: number;
  transform: [number, number, number, number, number, number];
  objects: ({ kind: 'curves'; ar: KeyedArchive; store: Obj } | { kind: 'shape'; shape: Obj; shapeKind: string })[];
}

/** Ink groups: each a binary plist { inkGroup: { inkGroupObjects, transform }, index }. */
function groupsOf(ar: KeyedArchive, store: Obj): Group[] {
  const out: Group[] = [];
  for (const g of ar.array(store.groupsArrays)) {
    const b = bytesOf(ar, g);
    if (!b) continue;
    try {
      const p = parsePlist(b) as Obj;
      const ig = isObj(p.inkGroup) ? p.inkGroup : null;
      if (!ig) continue;
      const t: Group['transform'] = Array.isArray(ig.transform) && ig.transform.length === 6 && ig.transform.every((x) => typeof x === 'number') ? (ig.transform as Group['transform']) : [1, 0, 0, 1, 0, 0];
      const objects: Group['objects'] = [];
      for (const o of Array.isArray(ig.inkGroupObjects) ? ig.inkGroupObjects : []) {
        if (!isObj(o)) continue;
        if (o.type === 1 && o.object instanceof Uint8Array) {
          const nar = new KeyedArchive(parsePlist(o.object));
          const r = nar.root();
          if (isObj(r)) objects.push({ kind: 'curves', ar: nar, store: r });
        } else if (o.type === 2 && isObj(o.object)) {
          // A list of shapes, as the curve store's own (shapes and their kinds).
          const list = o.object;
          const shapes = Array.isArray(list.shapes) ? list.shapes : [list];
          const kinds = Array.isArray(list.kinds) ? list.kinds : [];
          shapes.forEach((sh, i) => {
            if (!isObj(sh)) return;
            const k = typeof kinds[i] === 'string' ? (kinds[i] as string) : typeof kinds[i] === 'number' ? KIND_NAMES[kinds[i] as number] ?? '' : sh.startPt ? 'line' : sh.outlinePath ? 'partialshape' : sh.rotatedRect ? 'ellipse' : sh.points ? 'polygon' : '';
            objects.push({ kind: 'shape', shape: sh, shapeKind: k });
          });
        }
      }
      out.push({ index: typeof p.index === 'number' ? p.index : Number.MAX_SAFE_INTEGER, transform: t, objects });
    } catch {
      /* left out */
    }
  }
  return out;
}

// ------------------------------------------------------------------------------- media objects

/** A UIColor's #RRGGBB (null when see-through). */
function uiColor(ar: KeyedArchive, v: PlistValue): string | null {
  const c = ar.get(v);
  if (!isObj(c)) return null;
  const n = (k: string) => ar.number(c[k] ?? null);
  const a = n('UIAlpha') ?? 1;
  if (a < 0.02) return null;
  if (n('UIRed') !== null) return hexOf(n('UIRed')!, n('UIGreen') ?? 0, n('UIBlue') ?? 0);
  if (n('UIWhite') !== null) return hexOf(n('UIWhite')!, n('UIWhite')!, n('UIWhite')!);
  const rgb = c.NSRGB instanceof Uint8Array ? new TextDecoder().decode(c.NSRGB).trim().split(/\s+/).map(Number) : null;
  return rgb && rgb.length >= 3 && rgb.every(Number.isFinite) ? hexOf(rgb[0], rgb[1], rgb[2]) : null;
}

/** A text box's or sticky's colour (its paper), if it has one. */
function mediaBackground(ar: KeyedArchive, m: PlistValue): string | null {
  const id = ar.string(ar.field(ar.field(m, 'kCanvasMediaObjectPaperAttributes'), 'paperIdentifier'));
  const hex = id ? /^Color:(#[0-9a-f]{6})/i.exec(id)?.[1] : null;
  if (hex) return hex.toUpperCase();
  return uiColor(ar, ar.field(ar.field(m, 'paperStyleObject'), 'paperColor'));
}

async function mediaPicture(ar: KeyedArchive, m: PlistValue, entry: (rel: string) => ZipEntry | null, deps: NotabilityDeps): Promise<string | null> {
  const figure = ar.field(m, 'figure');
  const snap = ar.field(ar.field(figure, 'FigureBackgroundObjectKey'), 'kImageObjectSnapshotKey');
  const paths = [ar.string(ar.field(snap, 'relativePath')), ar.string(ar.field(ar.field(m, 'contentSnapshot'), 'relativePath'))].filter((p): p is string => !!p);
  // Animated pictures keep their GIF (Images/ holds one frame of it).
  const asset = ar.string(ar.field(m, 'assetsIdKey'));
  const gif = ar.field(m, 'isGif') === true && asset ? entry(`Assets/${asset}/media.gif`) : null;
  const flipH = ar.field(m, 'isFlippedHorizontal') === true, flipV = ar.field(m, 'isFlippedVertical') === true;
  // The crop is in the source picture's pixels; it applies only when the figure has its crop path.
  const crop = ar.get((ar.get(figure) as Obj | null)?.$0) instanceof Uint8Array ? rect(ar.string(ar.field(figure, 'FigureCropRectKey'))) : null;
  if (gif && !crop && !flipH && !flipV) {
    const b = await gif.read();
    let bin = '';
    for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return `data:image/gif;base64,${btoa(bin)}`;
  }
  for (const p of paths) {
    const e = entry(p);
    if (!e) continue;
    const ext = p.split('.').pop()?.toLowerCase() ?? '';
    try {
      const pic = await deps.readImage(new Blob([(await e.read()) as Uint8Array<ArrayBuffer>], { type: MIME[ext] ?? 'application/octet-stream' }), { crop, flipH, flipV });
      return pic.dataUrl;
    } catch {
      /* the next copy */
    }
  }
  return null;
}

// ----------------------------------------------------------------------------------------- text

export interface Run {
  start: number;
  end: number;
  font: string;
  size: number;
  color: string;
  underline: boolean;
  strike: boolean;
  level: number;
  /** 1 bullet, 2 numbered, 3 checklist. */
  decoration: number;
  number: number;
  checked: boolean;
}

/** An attributed string { stringKey, subRangesKey }: its text and its runs (UTF-16 ranges). */
function attributed(ar: KeyedArchive, v: PlistValue): { text: string; runs: Run[] } {
  const d = ar.dict(v);
  const text = (ar.string(d.get('stringKey') ?? null) ?? ar.string(v) ?? '').replace(/\r\n?/g, '\n').replace(/￼/g, ' ');
  const runs: Run[] = [];
  for (const r of ar.array(d.get('subRangesKey') ?? null)) {
    const rd = ar.dict(r);
    const range = pair(ar.string(rd.get('subRangeRangeKey') ?? null));
    if (!range) continue;
    const font = ar.dict(rd.get('subRangeFontKey') ?? null);
    const other = ar.dict(rd.get('subRangeOtherAttributesKey') ?? null);
    const o = (k: string) => ar.number(other.get(k) ?? null);
    const cp = ar.string(rd.get('subRangeColorCrossPlatformKey') ?? null)?.split(',').map(Number);
    const color = cp && cp.length >= 3 && cp.every(Number.isFinite) ? hexOf(cp[0], cp[1], cp[2]) : uiColor(ar, rd.get('subRangeColorKey') ?? null) ?? '#000000';
    runs.push({
      start: range[0], end: range[0] + range[1],
      font: ar.string(font.get('NSFontNameAttribute') ?? null) ?? 'HelveticaNeue',
      size: ar.number(font.get('NSFontSizeAttribute') ?? null) ?? 12,
      color, underline: (o('NSUnderline') ?? 0) > 0, strike: (o('NSStrikethrough') ?? 0) > 0,
      level: o('indent-level') ?? 0, decoration: o('indent-decoration-style') ?? 0, number: o('indent-decoration-number') ?? 1, checked: (o('checklist-checked') ?? 0) > 0,
    });
  }
  return { text, runs };
}

let measureCtx: CanvasRenderingContext2D | null | undefined;
/** Width (px) of `text` in a font (an estimate where there is no canvas, e.g. tests). */
function textWidth(text: string, px: number, family: TextFont, bold: boolean): number {
  if (measureCtx === undefined) measureCtx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
  if (!measureCtx) return text.length * px * (family === 'mono' || family === 'courier' || family === 'menlo' ? 0.6 : 0.52);
  measureCtx.font = `${bold ? 700 : 400} ${px}px ${fontStack(family)}`;
  return measureCtx.measureText(text).width;
}

const LIST_KIND: Record<number, ListKind> = { 1: 'bullet', 2: 'number', 3: 'check' };

/** A run's look: typeface, weight, slant, size (px), colour, lines. */
function lookOf(r: Run | null, s: number) {
  const f = fontFromName(r?.font ?? 'HelveticaNeue');
  return { family: f.family, bold: f.bold, italic: f.italic, size: Math.round((r?.size ?? 12) * s * 10) / 10, color: r?.color ?? '#000000', underline: !!r?.underline, strike: !!r?.strike };
}

/**
 * Text as one rich text box (editor/richText.ts): the box's style is its most used run's, the
 * other runs are spans (a bold word, a larger title, another typeface or colour), each paragraph's
 * list (bullet, numbered with Notability's own number, checkbox ticked or not) and indent level
 * are paragraph styles. `range`: the paragraphs taken (from, to: character offsets).
 */
function richText(t: { text: string; runs: Run[] }, s: number, from = 0, to = t.text.length): Pick<TextBlock, 'text' | 'spans' | 'paras' | 'fontSize' | 'color' | 'fontFamily' | 'bold' | 'italic' | 'underline' | 'strike'> {
  const text = t.text.slice(from, to);
  const runs = t.runs.map((r) => ({ ...r, start: Math.max(r.start, from) - from, end: Math.min(r.end, to) - from })).filter((r) => r.end > r.start);
  // The box's style: the run covering most text.
  const weight = new Map<string, { r: Run; n: number }>();
  for (const r of runs) {
    const k = JSON.stringify(lookOf(r, s));
    const w = weight.get(k);
    if (w) w.n += r.end - r.start;
    else weight.set(k, { r, n: r.end - r.start });
  }
  const baseRun = [...weight.values()].sort((a, b) => b.n - a.n)[0]?.r ?? null;
  const base = lookOf(baseRun, s);
  const spans: TextSpan[] = [];
  for (const r of runs) {
    const l = lookOf(r, s);
    const sp: TextSpan = { start: r.start, end: r.end };
    if (l.family !== base.family) sp.font = l.family;
    if (l.bold !== base.bold) sp.bold = l.bold;
    if (l.italic !== base.italic) sp.italic = l.italic;
    if (Math.abs(l.size - base.size) > 0.05) sp.size = l.size;
    if (l.color !== base.color) sp.color = l.color;
    if (l.underline !== base.underline) sp.underline = l.underline;
    if (l.strike !== base.strike) sp.strike = l.strike;
    if (Object.keys(sp).length > 2) spans.push(sp);
  }
  const paras: TextPara[] = [];
  let pos = 0;
  for (const line of text.split('\n')) {
    // The paragraph's list: its longest run's.
    let run: Run | null = null, best = -1;
    for (const r of runs) {
      const ov = Math.min(r.end, pos + Math.max(1, line.length)) - Math.max(r.start, pos);
      if (ov > best) [run, best] = [r, ov];
    }
    const list = run && line.trim() ? LIST_KIND[run.decoration] : undefined;
    const p: TextPara = {};
    if (list) {
      p.list = list;
      if (list === 'number') p.num = run!.number;
      if (list === 'check' && run!.checked) p.checked = true;
    }
    if (run?.level && line.trim()) p.level = run.level;
    paras.push(p);
    pos += line.length + 1;
  }
  return {
    text,
    ...(spans.length ? { spans } : {}),
    ...(compactParas(paras) ? { paras: compactParas(paras) } : {}),
    fontSize: base.size,
    color: base.color,
    ...(base.family !== 'sans' ? { fontFamily: base.family } : {}),
    ...(base.bold ? { bold: true } : {}),
    ...(base.italic ? { italic: true } : {}),
    ...(base.underline ? { underline: true } : {}),
    ...(base.strike ? { strike: true } : {}),
  };
}

/**
 * Text laid out from `at` (shared with the .ntb importer). A text box (`box`) is one rich text box:
 * `at` is its outside, its text inset by `box.pad`, with the box's colour, rounded corners and
 * height. The note's own typed text (`grid`: the paper's line spacing in document points) is a
 * box per paragraph, each paragraph's lines snapped to the paper's lines as Notability lays them.
 */
export function layOut(
  t: { text: string; runs: Run[] },
  at: { x: number; y: number; w: number },
  s: number,
  align: 'left' | 'center' | 'right',
  rotation: number,
  stampBelow: () => number,
  grid: number | null = null,
  box: { pad: [number, number]; background?: string | null; radius?: number; height?: number } | null = null
): TextBlock[] {
  const rot = Math.abs(rotation) > 0.01 ? { rotation: Math.round(rotation * 100) / 100 } : {};
  const al = align !== 'left' ? { align } : {};
  if (!grid) {
    if (!t.text.trim()) return [];
    const rich = richText(t, s);
    return [
      {
        id: newId('text'), x: at.x, y: at.y, width: at.w, ...rich, lineHeight: LINE,
        ...(box ? { padding: box.pad, ...(box.background ? { background: box.background } : {}), ...(box.radius ? { radius: box.radius } : {}), ...(box.height ? { height: box.height } : {}) } : {}),
        ...al, ...rot, createdAt: stampBelow(),
      },
    ];
  }
  const out: TextBlock[] = [];
  let y = at.y, pos = 0;
  for (const para of t.text.split('\n')) {
    const from = pos, to = pos + para.length;
    pos = to + 1;
    const run = t.runs.find((r) => from >= r.start && from < r.end) ?? t.runs.find((r) => r.end > from) ?? null;
    const l = lookOf(run, s);
    const indent = run && para.trim() ? (run.level + (run.decoration ? 1 : 0)) * 1.6 * l.size : 0;
    const wraps = Math.max(1, Math.ceil((textWidth(para, l.size, l.family, l.bold) + indent) / at.w));
    const height = Math.max(1, Math.ceil((wraps * l.size * LINE) / (grid * s))) * grid * s;
    if (para.trim()) {
      const rich = richText(t, s, from, to);
      out.push({ id: newId('text'), x: at.x, y, width: at.w, height, ...rich, lineHeight: Math.round((height / wraps / rich.fontSize) * 1000) / 1000, ...al, ...rot, createdAt: stampBelow() });
    }
    y += height;
  }
  return out;
}

// ----------------------------------------------------------------------------------- recordings

async function recordingsOf(entry: (rel: string) => ZipEntry | null, entries: ZipEntry[], base: string, fallbackDate: number): Promise<NotabilityImport['recordings']> {
  const files = entries.filter((e) => e.name.startsWith(base + 'Recordings/') && /\.(m4a|aac|caf|wav|mp3)$/i.test(e.name));
  if (!files.length) return [];
  /** Name, length and date of each file from Recordings/library.plist. */
  const info = new Map<string, { name?: string; duration?: number; date?: number }>();
  const lib = entry('Recordings/library.plist');
  if (lib) {
    try {
      const p = parsePlist(await lib.read()) as Obj;
      const recs = isObj(p.recordings) ? p.recordings : {};
      for (const r of Object.values(recs)) {
        if (!isObj(r) || typeof r.filepath !== 'string') continue;
        info.set(r.filepath, {
          name: typeof r.name === 'string' && r.name ? r.name : undefined,
          duration: typeof r.duration === 'number' ? r.duration : undefined,
          date: r.createddate instanceof PlistDate ? r.createddate.ms : undefined,
        });
      }
    } catch {
      /* names from the files */
    }
  }
  const mime = (n: string) => (/\.(m4a|aac)$/i.test(n) ? 'audio/mp4' : /\.wav$/i.test(n) ? 'audio/wav' : /\.mp3$/i.test(n) ? 'audio/mpeg' : 'audio/x-caf');
  const out: NotabilityImport['recordings'] = [];
  for (const [i, f] of files.entries()) {
    const file = f.name.slice(f.name.lastIndexOf('/') + 1);
    const meta = info.get(file) ?? {};
    out.push({ name: meta.name ?? file.replace(/\.[^.]+$/, ''), bytes: await f.read(), mime: mime(file), durationMs: Math.round((meta.duration ?? 0) * 1000), createdAt: meta.date ?? fallbackDate + i });
  }
  return out;
}
