import { ImageBlock, NotePage, PageSheet, PageSize, Point, Stroke, TextBlock, newId } from '../types';
import { PAGE_SIZES } from '../editor/pageSetup';
import { ellipsePoints } from '../editor/shapeEdit';
import { KeyedArchive, PlistDate, PlistValue, parsePlist } from './plist';
import { ZipEntry, readZip } from './zip';

/**
 * Notability notes (.note): a ZIP of one folder holding Session.plist (a keyed archive written by
 * Notability's GLKeyedArchiver), Images/, PDFs/, Recordings/, metadata.plist and thumbnails.
 *
 * Session.plist: root NoteTakingSession { name, creationDate, richText: FormattedString { "Handwriting
 * Overlay": HandwritingObject { SpatialHash: InkedSpatialHash { the ink } }, attributedString (typed
 * text), mediaObjects, pdfFiles, pageLayoutArray, reflowState { pageWidthInDocumentCoordsKey } } }.
 *
 * The ink (GLInkKit's InkObjectEncoder): numcurves, numpoints, numfractionalwidths and little-endian
 * arrays: curvesnumpoints (int32 per curve), curvespoints (float32 x, y per point), curveswidth
 * (float32 per curve), curvescolors (RGBA bytes per curve), curvesstyles (one byte per curve),
 * curvesfractionalwidths (float32). A curve of N points is a chain of cubic Béziers (start, two
 * controls, end, ...) with (N - 1) / 3 + 1 fractional widths, one per segment end: the line is
 * curveswidth x fractional width wide there. Shapes: "shapes", a binary property list (Swift
 * Codable) of kinds, indices and shapes. Coordinates: page points, pages pageWidth wide and stacked
 * top to bottom.
 */

export interface NotabilityImport {
  title: string;
  createdAt: number;
  pageSize: PageSize;
  surface: NotePage;
  sheets: PageSheet[];
  /** What could not be imported (shown to the user). */
  skipped: string[];
  /** OpenNote px per Notability page point. */
  importScale: number;
  counts: { strokes: number; shapes: number; images: number; text: boolean };
}

export type ImageReader = (blob: Blob) => Promise<{ dataUrl: string; w: number; h: number }>;

// InkObjectStyle (GLInkKit): 1 selection, 2 partial eraser, 3 pen, 4 highlighter, 5 pencil, 6 review, 7 whole eraser.
const STYLE_HIGHLIGHTER = 4;
const STYLE_NOT_INK: Record<number, string> = { 1: 'selection', 2: 'partial eraser', 6: 'review', 7: 'eraser' };
/** Default page width of the note in Notability's page points (Notability 7, iPad). */
const DEFAULT_PAGE_WIDTH = 537.6;

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', heic: 'image/heic', tif: 'image/tiff', tiff: 'image/tiff', webp: 'image/webp' };

export async function importNotability(bytes: Uint8Array, fileName: string, readImage?: ImageReader): Promise<NotabilityImport> {
  const entries = readZip(bytes);
  const session = entries.filter((e) => /(^|\/)Session\.plist$/.test(e.name)).sort((a, b) => a.name.length - b.name.length)[0];
  if (!session) throw new Error('This is not a Notability note (no Session.plist inside).');
  const ar = new KeyedArchive(parsePlist(await session.read()));
  const root = ar.root();
  const skipped: string[] = [];

  const title = ar.string(ar.field(root, 'name'))?.trim() || fileName.replace(/\.note$/i, '') || 'Notability note';
  const created = ar.field(root, 'creationDate');
  const createdAt = created instanceof PlistDate ? created.ms : typeof ar.field(created, 'NS.time') === 'number' ? new PlistDate(ar.field(created, 'NS.time') as number).ms : Date.now();

  let richText = ar.field(root, 'richText');
  const objects = [...ar.walk(root)];
  if (!richText || ar.className(richText) === null) richText = objects.find((o) => 'Handwriting Overlay' in o) ?? null;

  // Page geometry: the note's page width, and the page shape (US Letter unless the layout says otherwise).
  const widthHolder = objects.find((o) => typeof ar.get(o.pageWidthInDocumentCoordsKey) === 'number');
  const pageWidth = (widthHolder ? (ar.get(widthHolder.pageWidthInDocumentCoordsKey) as number) : 0) || DEFAULT_PAGE_WIDTH;
  const aspect = pageAspect(ar, ar.field(richText, 'pageLayoutArray'));
  const pageSize = sizeForAspect(aspect);
  const sheetW = PAGE_SIZES[pageSize].w, sheetH = PAGE_SIZES[pageSize].h;
  const s = sheetW / pageWidth;

  const strokes: Stroke[] = [];
  let order = 0, below = 0;
  const stamp = () => createdAt + order++;
  /** Typed text and pictures sit under the ink, as in Notability. */
  const stampBelow = () => createdAt - 1_000_000 + below++;

  // Ink: every curve store in the archive (normally one, the handwriting overlay's spatial hash).
  let shapeCount = 0;
  for (const store of objects.filter((o) => 'curvespoints' in o)) {
    const made = curvesToStrokes(ar, store, s, stamp, skipped);
    strokes.push(...made);
    const shapes = ar.get(store.shapes);
    const shapeData = shapes instanceof Uint8Array ? shapes : ar.field(shapes, 'NS.data');
    if (shapeData instanceof Uint8Array && shapeData.length) {
      const got = shapesToStrokes(shapeData, s, stamp, skipped);
      strokes.push(...got);
      shapeCount += got.length;
    }
    const groups = ar.array(store.groupsArrays);
    if (groups.length) skipped.push(`${groups.length} grouped ink object${groups.length === 1 ? '' : 's'}`);
  }

  // Typed text: Notability flows it from the top of the note; here it becomes one text box there.
  const textBlocks: TextBlock[] = [];
  const text = typedText(ar, richText);
  if (text.trim()) {
    textBlocks.push({ id: newId('text'), x: 56, y: 56, width: sheetW - 112, text, fontSize: 16, color: '#111827', createdAt: stampBelow() });
  }

  // Images: placed where the note had them when a frame is found, else stacked at the top.
  const imageBlocks: ImageBlock[] = [];
  const media = ar.array(ar.field(richText, 'mediaObjects'));
  let nextTop = 72;
  for (const m of media) {
    const file = mediaFile(ar, m, entries);
    if (!file) {
      skipped.push(`an attachment (${ar.className(m) ?? 'unknown kind'})`);
      continue;
    }
    if (!readImage) continue;
    try {
      const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
      const img = await readImage(new Blob([(await file.read()) as Uint8Array<ArrayBuffer>], { type: MIME[ext] ?? 'application/octet-stream' }));
      const frame = mediaFrame(ar, m);
      let x: number, y: number, w: number, h: number;
      if (frame) {
        [x, y, w, h] = [frame.x * s, frame.y * s, frame.w * s, frame.h * s];
      } else {
        w = Math.min(sheetW - 160, img.w);
        h = (w * img.h) / img.w;
        x = (sheetW - w) / 2;
        y = nextTop;
        nextTop += h + 24;
      }
      imageBlocks.push({ id: newId('image'), x, y, width: w, height: h, dataUrl: img.dataUrl, createdAt: stampBelow() });
    } catch {
      skipped.push(`image ${file.name.split('/').pop()}`);
    }
  }
  const pdfs = ar.array(ar.field(richText, 'pdfFiles')).length || entries.filter((e) => /\/PDFs\/[^/]+\.pdf$/i.test(e.name)).length;
  if (pdfs) skipped.push(`${pdfs} PDF background${pdfs === 1 ? '' : 's'} (not supported yet)`);
  if (entries.some((e) => /\/Recordings\/.+\.(m4a|caf|aac|wav)$/i.test(e.name))) skipped.push('audio recordings');

  // Pages: as many as the content reaches.
  let bottom = 0;
  for (const st of strokes) for (const p of st.points) bottom = Math.max(bottom, p.y);
  for (const b of imageBlocks) bottom = Math.max(bottom, b.y + b.height);
  const pages = Math.max(1, Math.floor(bottom / sheetH) + 1, ar.array(ar.field(richText, 'pageLayoutArray')).length);
  const sheets: PageSheet[] = Array.from({ length: pages }, () => ({ id: newId('sheet') }));

  return {
    title,
    createdAt,
    pageSize,
    surface: { id: newId('page'), pageNumber: 1, strokes, latexBlocks: [], textBlocks, imageBlocks },
    sheets,
    skipped,
    importScale: s,
    counts: { strokes: strokes.length - shapeCount, shapes: shapeCount, images: imageBlocks.length, text: !!text.trim() },
  };
}

// ------------------------------------------------------------------------------------------ ink

function bytesOf(ar: KeyedArchive, v: PlistValue): Uint8Array | null {
  const o = ar.get(v);
  if (o instanceof Uint8Array) return o;
  const d = ar.field(o, 'NS.data');
  return d instanceof Uint8Array ? d : null;
}

function view(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

const hex2 = (n: number) => n.toString(16).padStart(2, '0');

function curvesToStrokes(ar: KeyedArchive, store: { [k: string]: PlistValue }, s: number, stamp: () => number, skipped: string[]): Stroke[] {
  const pts = bytesOf(ar, store.curvespoints), counts = bytesOf(ar, store.curvesnumpoints);
  if (!pts || !counts) return [];
  const widths = bytesOf(ar, store.curveswidth), colors = bytesOf(ar, store.curvescolors);
  const fws = bytesOf(ar, store.curvesfractionalwidths), styles = bytesOf(ar, store.curvesstyles);
  const P = view(pts), C = view(counts), W = widths ? view(widths) : null, F = fws ? view(fws) : null;
  const nCurves = Math.floor(counts.length / 4), nPoints = Math.floor(pts.length / 8), nFw = fws ? Math.floor(fws.length / 4) : 0;
  const out: Stroke[] = [];
  const notInk: Record<string, number> = {};
  let p0 = 0, f0 = 0;
  for (let c = 0; c < nCurves; c++) {
    const n = C.getInt32(c * 4, true);
    const k = Math.floor((n - 1) / 3) + 1;
    const start = p0, fstart = f0;
    p0 += Math.max(0, n);
    f0 += Math.max(0, k);
    if (n <= 0 || p0 > nPoints) continue;
    const style = styles && c < styles.length && styles[c] <= 6 ? styles[c] : 3;
    if (STYLE_NOT_INK[style]) {
      notInk[STYLE_NOT_INK[style]] = (notInk[STYLE_NOT_INK[style]] ?? 0) + 1;
      continue;
    }
    const xy = (i: number) => ({ x: P.getFloat32((start + i) * 8, true) * s, y: P.getFloat32((start + i) * 8 + 4, true) * s });
    const fw = (j: number) => (F && fstart + j < nFw ? F.getFloat32((fstart + j) * 4, true) : 1) || 1;
    const base = (W && c * 4 + 4 <= widths!.length ? W.getFloat32(c * 4, true) : 2) * s;

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
    if (!line.length) continue;

    let color = '#000000', alpha = 1;
    if (colors && c * 4 + 4 <= colors.length) {
      color = `#${hex2(colors[c * 4])}${hex2(colors[c * 4 + 1])}${hex2(colors[c * 4 + 2])}`;
      alpha = colors[c * 4 + 3] / 255;
    }
    const ds = line.map((q) => Math.max(0.3, q.d));
    const dMax = Math.max(...ds), dMin = Math.min(...ds);
    const common = { id: newId('stroke'), createdAt: stamp(), color, lineStyle: 'solid' as const };

    if (style === STYLE_HIGHLIGHTER) {
      // OpenNote draws highlighters 5.5 x their width at a fixed transparency.
      out.push({ ...common, tool: 'highlighter', width: dMax / 5.5, opacity: 1, penStyle: 'ballpoint', modeled: 'uniform', points: line.map((q, i) => ({ x: q.x, y: q.y, pressure: 0.5, t: i * 8 })) });
    } else if (dMax - dMin < 0.02 * dMax) {
      // Constant width: a ballpoint line exactly that wide (strokeWidth = width x 1.5).
      out.push({ ...common, tool: 'pen', width: dMax / 1.5, opacity: alpha, penStyle: 'ballpoint', modeled: 'uniform', points: line.map((q, i) => ({ x: q.x, y: q.y, pressure: 0.5, t: i * 8 })) });
    } else {
      // Variable width: each point's width as a share of the widest ('proportional'; a fountain
      // line is width x 1.4 wide at its widest).
      const points: Point[] = ds.map((d, i) => ({ x: line[i].x, y: line[i].y, pressure: d / dMax, t: i * 8 }));
      out.push({ ...common, tool: 'pen', width: dMax / 1.4, opacity: alpha, penStyle: 'fountain', modeled: 'proportional', points });
    }
  }
  for (const [what, n] of Object.entries(notInk)) skipped.push(`${n} ${what} stroke${n === 1 ? '' : 's'}`);
  return out;
}

// ---------------------------------------------------------------------------------------- shapes

type Obj = { [k: string]: PlistValue };
const isObj = (v: PlistValue | undefined): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array) && !(v instanceof PlistDate);
const isPoint = (v: PlistValue | undefined): v is [number, number] => Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number';

/** First value under one of `keys`, searched depth first. */
function find(v: PlistValue | undefined, keys: string[], depth = 0): PlistValue | undefined {
  if (depth > 8 || v == null) return undefined;
  if (isObj(v)) {
    for (const k of keys) if (k in v) return v[k];
    for (const x of Object.values(v)) {
      const r = find(x, keys, depth + 1);
      if (r !== undefined) return r;
    }
  } else if (Array.isArray(v)) {
    for (const x of v) {
      const r = find(x, keys, depth + 1);
      if (r !== undefined) return r;
    }
  }
  return undefined;
}

function shapeColor(sh: PlistValue): { color: string; alpha: number } {
  const c = find(sh, ['rgba', 'strokeColor', 'color']);
  const comps = isObj(c) ? find(c, ['rgba', 'components']) : c;
  if (Array.isArray(comps) && comps.length >= 3 && comps.every((x) => typeof x === 'number')) {
    const [r, g, b, a = 1] = comps as number[];
    const to = (x: number) => hex2(Math.round(Math.max(0, Math.min(1, x > 1 ? x / 255 : x)) * 255));
    return { color: `#${to(r)}${to(g)}${to(b)}`, alpha: a > 1 ? a / 255 : a };
  }
  if (comps instanceof Uint8Array && comps.length >= 4) return { color: `#${hex2(comps[0])}${hex2(comps[1])}${hex2(comps[2])}`, alpha: comps[3] / 255 };
  return { color: '#000000', alpha: 1 };
}

function shapesToStrokes(data: Uint8Array, s: number, stamp: () => number, skipped: string[]): Stroke[] {
  let root: PlistValue;
  try {
    root = parsePlist(data);
  } catch {
    skipped.push('shapes (unreadable)');
    return [];
  }
  const kinds = (find(root, ['kinds']) as number[] | undefined) ?? [];
  const shapes = (find(root, ['shapes']) as PlistValue[] | undefined) ?? [];
  const out: Stroke[] = [];
  let unknown = 0;
  shapes.forEach((sh, i) => {
    const kind = typeof kinds[i] === 'number' ? kinds[i] : -1;
    const P = (p: [number, number]): Point => ({ x: p[0] * s, y: p[1] * s, pressure: 0.5 });
    let points: Point[] | null = null;
    let shapeKind: Stroke['shapeKind'] = 'polygon';
    let closed = true;
    if (kind === 0) {
      const a = find(sh, ['startPt', 'start']), b = find(sh, ['endPt', 'end']);
      if (isPoint(a) && isPoint(b)) [points, shapeKind, closed] = [[P(a), P(b)], 'line', false];
    } else if (kind === 5 || kind === 6) {
      const c = find(sh, ['center']);
      const r = find(sh, ['radius']);
      const rect = find(sh, ['rect']);
      if (isPoint(c) && typeof r === 'number') points = ellipsePoints({ x: c[0] * s, y: c[1] * s }, { x: r * s, y: 0 }, r * s, 72);
      else if (Array.isArray(rect) && isPoint(rect[0]) && isPoint(rect[1])) {
        const [[x, y], [w, h]] = rect as [[number, number], [number, number]];
        points = ellipsePoints({ x: (x + w / 2) * s, y: (y + h / 2) * s }, { x: (w / 2) * s, y: 0 }, (h / 2) * s, 72);
      }
      shapeKind = kind === 6 ? 'circle' : 'ellipse';
    } else if (kind >= 1 && kind <= 4) {
      const corners = find(sh, ['corners', 'edges', 'points']);
      if (Array.isArray(corners) && corners.length >= 2 && corners.every(isPoint)) points = (corners as [number, number][]).map(P);
      shapeKind = kind === 3 ? 'triangle' : kind === 4 ? 'polygon' : 'rectangle';
    }
    if (!points) {
      unknown++;
      return;
    }
    const { color, alpha } = shapeColor(sh);
    const width = (typeof find(sh, ['strokeWidth']) === 'number' ? (find(sh, ['strokeWidth']) as number) : 2) * s;
    out.push({ id: newId('stroke'), createdAt: stamp(), tool: 'pen', color, width: width / 1.5, opacity: alpha, penStyle: 'ballpoint', lineStyle: 'solid', points, isShape: true, closed, shapeKind });
  });
  if (unknown) skipped.push(`${unknown} shape${unknown === 1 ? '' : 's'} of an unknown kind`);
  return out;
}

// ---------------------------------------------------------------------------------- text, media

function typedText(ar: KeyedArchive, richText: PlistValue): string {
  for (const key of ['attributedString', 'NBAttributedBackingString']) {
    let holder = ar.field(richText, key);
    // NBAttributedString wraps its string dictionaries.
    const inner = ar.field(holder, 'NBAttributedBackingStringCodingKey');
    if (inner) holder = inner;
    const str = ar.string(holder) ?? ar.string(ar.dict(holder).get('stringKey') ?? null);
    if (str && str.trim()) return str.replace(/￼/g, '').replace(/\r\n?/g, '\n');
  }
  return '';
}

function mediaFile(ar: KeyedArchive, m: PlistValue, entries: ZipEntry[]): ZipEntry | null {
  for (const o of ar.walk(m)) {
    for (const v of Object.values(o)) {
      const str = ar.string(v);
      if (!str || str.length > 300 || !/\.[a-z0-9]{2,5}$/i.test(str)) continue;
      const base = str.split('/').pop()!;
      const hit = entries.find((e) => e.name.endsWith(`/${base}`) && /\/(Images|Assets|Media)\//.test(e.name) && MIME[base.split('.').pop()!.toLowerCase()]);
      if (hit) return hit;
    }
  }
  return null;
}

const RECT = /^\{\{\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\}\s*,\s*\{\s*([\d.]+)\s*,\s*([\d.]+)\s*\}\}$/;
const PAIR = /^\{\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\}$/;

function mediaFrame(ar: KeyedArchive, m: PlistValue): { x: number; y: number; w: number; h: number } | null {
  let origin: [number, number] | null = null, size: [number, number] | null = null;
  for (const o of ar.walk(m)) {
    for (const [k, v] of Object.entries(o)) {
      const str = ar.string(v);
      if (!str) continue;
      const r = RECT.exec(str);
      if (r && +r[3] > 0 && +r[4] > 0) return { x: +r[1], y: +r[2], w: +r[3], h: +r[4] };
      const p = PAIR.exec(str);
      if (!p) continue;
      if (/origin/i.test(k)) origin ??= [+p[1], +p[2]];
      else if (/size/i.test(k) && +p[1] > 0 && +p[2] > 0) size ??= [+p[1], +p[2]];
    }
  }
  return origin && size ? { x: origin[0], y: origin[1], w: size[0], h: size[1] } : null;
}

/** Height / width of the note's pages from its page layout, when it records sizes. */
function pageAspect(ar: KeyedArchive, layouts: PlistValue): number | null {
  for (const l of ar.array(layouts)) {
    for (const o of ar.walk(l)) {
      for (const v of Object.values(o)) {
        const str = ar.string(v);
        if (!str) continue;
        const r = RECT.exec(str);
        if (r && +r[3] > 0) return +r[4] / +r[3];
        const p = PAIR.exec(str);
        if (p && +p[1] > 100 && +p[2] > 100) return +p[2] / +p[1];
      }
    }
  }
  return null;
}

function sizeForAspect(aspect: number | null): PageSize {
  if (!aspect) return 'letter';
  let best: PageSize = 'letter', err = Infinity;
  for (const [id, sz] of Object.entries(PAGE_SIZES) as [PageSize, { w: number; h: number }][]) {
    const e = Math.abs(sz.h / sz.w - aspect);
    if (e < err) [best, err] = [id, e];
  }
  return err < 0.03 ? best : 'letter';
}
