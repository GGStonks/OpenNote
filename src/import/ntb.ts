import { ImageBlock, PageSheet, PaperColor, PaperStyle, Point, Stroke, TextBlock, newId } from '../types';
import { ellipsePoints } from '../editor/shapeEdit';
import { TEXT_LINE_HEIGHT } from '../editor/textStyle';
import { FlatBuffer, half } from './flatbuffer';
import { BOX_PAD, MIME, NotabilityDeps, NotabilityImport, PAGE_PX, Run, layOut, strokeFromLine } from './notability';
import { ZipEntry, readZip } from './zip';

/**
 * Notability's newer note files (.ntb, Notability 16) into OpenNote notes. What is read is
 * described in docs/notability-note-format.md (".ntb"): a ZIP holding `noteBundle`, a FlatBuffers
 * log of records (the document's paper, ink, shapes, pictures, stickies, text boxes, typed text
 * and its styles, attached PDFs), and the files it refers to, named by their hash.
 *
 * Unlike a .note, positions are per page: x from the page's left edge, y from its top, in
 * document units of a page `W` wide; OpenNote pages are 816 px wide, so everything is scaled by
 * 816 / W and moved down to its page.
 */

// Record types.
const DOCUMENT = 1, PDF = 2, BOUNDARY = 7, TEXT = 8, CHAR_STYLE = 12, PARA_STYLE = 13, INK = 15, SHAPE = 18, MEDIA = 22, ERASE = 25;
/** Page size when the document record does not say (Notability's iPad page). */
const DEFAULT_PAGE = { w: 679, h: 891.1875 };
/** A pencil's recorded width is wider than the line it draws by this. */
const PENCIL_WIDTH = 0.45 / 0.68;

type Id = string;

export async function importNtb(bytes: Uint8Array, fileName: string, deps: NotabilityDeps): Promise<NotabilityImport> {
  const entries = readZip(bytes);
  const bundle = entries.filter((e) => /(^|\/)noteBundle$/.test(e.name)).sort((a, b) => a.name.length - b.name.length)[0];
  if (!bundle) throw new Error('This is not a Notability note (no noteBundle inside).');
  const base = bundle.name.slice(0, bundle.name.length - 'noteBundle'.length);
  /** A file of the bundle by its hash (assets/<hash>.<ext>, or <hash>.<ext> at the top). */
  const byHash = (hash: string, ext?: string): ZipEntry | null =>
    entries.find((e) => {
      const n = e.name.slice(base.length).replace(/^assets\//, '');
      return n.toLowerCase().startsWith(hash.toLowerCase()) && (!ext || n.toLowerCase().endsWith(`.${ext}`));
    }) ?? null;
  const fb = new FlatBuffer(await bundle.read());
  const root = fb.root();
  if (root === null) throw new Error('The note is damaged (its noteBundle cannot be read).');
  const records = fb.tables(root, 6).map((r) => {
    const at = fb.field(r, 0);
    return { id: at === null ? '' : `${fb.u32(at)}:${fb.u32(at + 4)}`, type: fb.u8At(r, 4) ?? 0, p: fb.ref(r, 5) };
  });
  const skipped: string[] = [];
  const createdMs = fb.field(root, 4) !== null ? fb.u64(fb.field(root, 4)!) : null;
  const createdAt = createdMs && createdMs > 1e12 && createdMs < 1e13 ? createdMs : Date.now();
  const idAt = (t: number | null, slot: number): Id | null => {
    const at = fb.field(t, slot);
    return at === null ? null : `${fb.u32(at)}:${fb.u32(at + 4)}`;
  };

  // Records removed by an eraser record (a log not compacted yet).
  const erased = new Set<Id>();
  for (const r of records) {
    if (r.type !== ERASE) continue;
    const ids = fb.bytesOf(r.p, 0, 8);
    if (!ids) continue;
    const dv = new DataView(ids.buffer, ids.byteOffset, ids.byteLength);
    for (let i = 0; i + 8 <= ids.length; i += 8) erased.add(`${dv.getUint32(i, true)}:${dv.getUint32(i + 4, true)}`);
  }
  const live = records.filter((r) => r.p !== null && !erased.has(r.id));

  // ---------------------------------------------------------------------------------- paper
  const doc = [...live].reverse().find((r) => r.type === DOCUMENT) ?? null;
  const layout = fb.ref(fb.ref(doc?.p ?? null, 1), 0);
  const size = fb.pair(layout, 3);
  const page = size && size[0] > 50 && size[1] > 50 ? { w: size[0], h: size[1] } : DEFAULT_PAGE;
  const W = page.w;
  const s = PAGE_PX / W;
  const margins = fb.field(layout, 4);
  const marginLeft = margins !== null ? fb.f32(margins + 8) : null;
  const inset = marginLeft !== null && marginLeft > 0 && marginLeft < W / 4 ? marginLeft : W / 38.4;
  const paper = fb.ref(layout, 0);
  const pattern = fb.field(paper, 0) !== null ? fb.u8At(paper, 0) : null;
  const spacing = fb.f32At(paper, 1);
  const paperStyle: PaperStyle = pattern === 0 ? (spacing !== null && spacing < 0.28 * 72 * (W / 612) ? 'narrowLines' : 'lines') : pattern === 1 ? 'dots' : pattern === 2 ? 'grid' : 'blank';
  const lineSpacing = pattern === 0 && spacing && spacing > 2 ? spacing : null;
  const pc = fb.rgba(paper, 4);
  const paperHex = pc ? hexOf(pc) : '#FFFFFF';
  const paperColor: PaperColor = paperHex === '#FFFFFF' ? 'white' : (paperHex as PaperColor);

  // ------------------------------------------------------------------------------ the pages
  // The PDFs, in the order their records name them: one Notability page per PDF page, from the
  // first page (a bundle holding one PDF and no record naming it: that PDF).
  const pdfNames: string[] = [];
  for (const r of live) {
    if (r.type !== PDF) continue;
    const name = hashIn(fb, r.p);
    if (name && !pdfNames.includes(name)) pdfNames.push(name);
  }
  if (!pdfNames.length) {
    const loose = entries.filter((e) => /(^|\/)(assets\/)?[0-9a-f]{40,128}\.pdf$/i.test(e.name));
    if (loose.length === 1) pdfNames.push(loose[0].name.replace(/^.*\//, '').replace(/\.pdf$/i, ''));
    else if (loose.length > 1) skipped.push(`${loose.length} PDFs whose pages' places the note does not say`);
  }
  const sheets: PageSheet[] = [];
  let pdfPages = 0;
  for (const name of pdfNames) {
    const e = byHash(name, 'pdf');
    if (!e) {
      skipped.push('a PDF that is not in the file');
      continue;
    }
    try {
      const f = await deps.storePdf(`${name}.pdf`, await e.read());
      f.sizes.forEach((sz, i) => {
        sheets.push({ id: newId('sheet'), width: PAGE_PX, height: (PAGE_PX * sz.h) / sz.w, paperStyle: 'blank', pdf: { file: f.fileId, page: i + 1 } });
        pdfPages++;
      });
    } catch {
      skipped.push('a PDF that could not be read');
    }
  }
  const plainSheet = (): PageSheet => ({ id: newId('sheet'), width: PAGE_PX, height: page.h * s });
  /** The top of page `n` on the surface (px), adding plain pages as far as needed. */
  const topOf = (n: number) => {
    while (sheets.length <= n) sheets.push(plainSheet());
    let y = 0;
    for (let i = 0; i < n; i++) y += sheets[i].height ?? 0;
    return y;
  };
  const pageOf = (t: number | null, slot: number) => {
    const n = fb.u32At(t, slot, 8) ?? 0;
    return n < 10000 ? n : 0;
  };
  const tfOn = (n: number) => {
    const top = topOf(n);
    return (x: number, y: number) => ({ x: x * s, y: top + y * s });
  };

  // ------------------------------------------------------------------------- ink and shapes
  let order = 0, below = 0;
  const stamp = () => createdAt + order++;
  const stampBelow = () => createdAt - 1_000_000 + below++;
  const strokes: Stroke[] = [];
  let shapeCount = 0, badInk = 0, badShapes = 0;
  for (const r of live) {
    if (r.type === INK) {
      const got = inkOf(fb, r.p!, tfOn(pageOf(r.p, 0)), s);
      if (!got) badInk++;
      else for (const st of got) strokes.push({ ...st, createdAt: stamp() });
    } else if (r.type === SHAPE) {
      const got = shapeOf(fb, r.p!, tfOn(pageOf(r.p, 0)), s);
      if (!got) badShapes++;
      else {
        strokes.push({ ...got, createdAt: stamp() });
        shapeCount++;
      }
    }
  }
  if (badInk) skipped.push(`${badInk} stroke${badInk === 1 ? '' : 's'} of an unknown kind`);
  if (badShapes) skipped.push(`${badShapes} shape${badShapes === 1 ? '' : 's'} of an unknown kind`);

  // ---------------------------------------------------------------------------------- text
  // Text records append to a container (the document's own text, or a text box, by record id);
  // style records cover ranges between positions (a record id and a UTF-16 offset after it).
  const docId = doc?.id ?? '0:0';
  const stores = new Map<Id, { text: string; char: { a: number; b: number; p: number }[]; para: { a: number; b: number; p: number }[] }>();
  const anchors = new Map<Id, { owner: Id; at: number }>([[docId, { owner: docId, at: 0 }]]);
  const store = (owner: Id) => {
    let st = stores.get(owner);
    if (!st) stores.set(owner, (st = { text: '', char: [], para: [] }));
    return st;
  };
  for (const r of live) {
    if (r.type !== TEXT) continue;
    const text = fb.string(r.p, 1);
    if (text === null) continue;
    const owner = idAt(r.p, 0) ?? docId;
    const st = store(owner);
    anchors.set(r.id, { owner, at: st.text.length });
    st.text += text;
  }
  const position = (t: number | null, slot: number) => {
    const anchor = anchors.get(idAt(t, slot) ?? '');
    const off = fb.u32At(t, slot, 8);
    return anchor && off !== null ? { owner: anchor.owner, at: anchor.at + off } : null;
  };
  for (const r of live) {
    if (r.type !== BOUNDARY) continue;
    const at = position(r.p, 0);
    if (at) anchors.set(r.id, at);
  }
  for (const r of live) {
    if (r.type !== CHAR_STYLE && r.type !== PARA_STYLE) continue;
    const a = position(r.p, 0), b = position(r.p, 1);
    const owner = (b ?? a)?.owner;
    const st = owner ? stores.get(owner) : null;
    if (!st || (a && a.owner !== owner && a.owner !== docId)) continue;
    const range = { a: a && a.owner === owner ? a.at : 0, b: b ? b.at : st.text.length, p: r.p! };
    (r.type === CHAR_STYLE ? st.char : st.para).push(range);
  }
  const defaultFont = fb.string(doc?.p ?? null, 4) ?? 'HelveticaNeue';
  const defaultSize = fb.f32At(doc?.p ?? null, 5) ?? 12;
  const runsOf = (st: { text: string; char: { a: number; b: number; p: number }[]; para: { a: number; b: number; p: number }[] }) => textRuns(fb, st, defaultFont, defaultSize);

  const textBlocks: TextBlock[] = [];
  const imageBlocks: ImageBlock[] = [];
  let pictures = 0;
  const unsupported: Record<string, number> = {};
  const media = live.filter((r) => r.type === MEDIA).map((r, i) => ({ r, z: fb.u64(fb.field(r.p, 9) ?? -1) ?? i, i }));
  media.sort((a, b) => a.z - b.z || a.i - b.i);
  for (const { r } of media) {
    const p = r.p!;
    const at = fb.pair(p, 3), sz = fb.pair(p, 6);
    if (!at || !sz || sz[0] <= 0 || sz[1] <= 0) {
      unsupported.object = (unsupported.object ?? 0) + 1;
      continue;
    }
    const rot = fb.f32At(p, 4) ?? 0;
    // The record keeps the turned box's top-left corner: the box's own corner, turned back.
    const [x0, y0] = unturnCorner(at, sz, rot);
    const tf = tfOn(pageOf(p, 2));
    const o = tf(x0, y0);
    const box = { x: o.x, y: o.y, w: sz[0] * s, h: sz[1] * s };
    const deg = (rot * 180) / Math.PI;
    const rotation = Math.abs(deg) > 0.01 ? { rotation: Math.round(deg * 100) / 100 } : {};
    const sticky = fb.ref(p, 15);
    if (sticky !== null) {
      const c = fb.rgba(sticky, 4);
      imageBlocks.push({ id: newId('image'), x: box.x, y: box.y, width: box.w, height: box.h, dataUrl: deps.solidImage(c ? hexOf(c) : '#FFF48E', box.w, box.h, 0), ...rotation, createdAt: stampBelow() });
    }
    const boxText = stores.get(r.id);
    if (boxText) {
      stores.delete(r.id);
      textBlocks.push(...layOut(runsOf(boxText), { x: box.x + BOX_PAD.x * s, y: box.y + BOX_PAD.y * s, w: Math.max(20, box.w - 2 * BOX_PAD.x * s) }, s, 'left', deg, stampBelow));
      continue;
    }
    const m = fb.ref(p, 10);
    const asset = fb.ref(m, 0);
    if (asset === null) {
      if (sticky === null) unsupported.object = (unsupported.object ?? 0) + 1;
      continue;
    }
    const hashAt = fb.field(asset, 0);
    const hash = hashAt !== null ? hexBytes(fb.slice(hashAt, 64)) : hashIn(fb, asset);
    const mime = fb.string(asset, 2) ?? 'image/jpeg';
    if (!/^image\//.test(mime)) {
      unsupported[mime.replace(/^.*\//, '')] = (unsupported[mime.replace(/^.*\//, '')] ?? 0) + 1;
      continue;
    }
    const e = hash ? byHash(hash) : null;
    if (!e) {
      skipped.push('a picture that is not in the file');
      continue;
    }
    const logical = fb.pair(m, 1);
    const cropAt = fb.field(p, 11);
    let crop: { x: number; y: number; w: number; h: number } | null = null;
    if (cropAt !== null) {
      const [cx, cy, cw, ch] = [0, 4, 8, 12].map((k) => fb.f32(cropAt + k) ?? 0);
      const whole = logical && cx <= 0.5 && cy <= 0.5 && cx + cw >= logical[0] - 0.5 && cy + ch >= logical[1] - 0.5;
      if (cw > 0 && ch > 0 && !whole) crop = { x: cx, y: cy, w: cw, h: ch };
    }
    try {
      const b = await e.read();
      const ext = e.name.split('.').pop()?.toLowerCase() ?? '';
      // An animated picture keeps its GIF (drawn on a canvas it would be one frame).
      const dataUrl = mime === 'image/gif' && !crop ? `data:image/gif;base64,${base64(b)}` : (await deps.readImage(new Blob([b as Uint8Array<ArrayBuffer>], { type: MIME[ext] ?? mime }), { crop, cropUnit: logical ? { w: logical[0], h: logical[1] } : null })).dataUrl;
      imageBlocks.push({ id: newId('image'), x: box.x, y: box.y, width: box.w, height: box.h, dataUrl, ...rotation, createdAt: stampBelow() });
      pictures++;
    } catch {
      skipped.push('a picture that could not be read');
    }
  }
  for (const [what, n] of Object.entries(unsupported)) skipped.push(`${n} ${what} object${n === 1 ? '' : 's'}`);

  // The note's own typed text: from the top of the first page, on the paper's lines.
  const main = stores.get(docId);
  stores.delete(docId);
  if (main?.text.trim()) textBlocks.push(...layOut(runsOf(main), { x: inset * s, y: 3 * s, w: (W - 2 * inset) * s }, s, 'left', 0, stampBelow, lineSpacing));
  const lost = [...stores.values()].filter((st) => st.text.trim()).length;
  if (lost) skipped.push(`${lost} text${lost === 1 ? '' : 's'} whose place the note does not say`);

  // Pages as far as the content reaches.
  let bottom = 0;
  for (const st of strokes) for (const p of st.points) bottom = Math.max(bottom, p.y);
  for (const b of imageBlocks) bottom = Math.max(bottom, b.y + b.height);
  for (const t of textBlocks) bottom = Math.max(bottom, t.y + (t.height ?? t.fontSize * TEXT_LINE_HEIGHT));
  if (!sheets.length) sheets.push(plainSheet());
  while (sheets.reduce((h, x) => h + (x.height ?? 0), 0) < bottom - s) sheets.push(plainSheet());

  return {
    title: fb.string(fb.ref(doc?.p ?? null, 0), 0)?.trim() || fileName.replace(/\.ntb$/i, '') || 'Notability note',
    createdAt,
    paperStyle,
    paperColor,
    surface: { id: newId('page'), pageNumber: 1, strokes, latexBlocks: [], textBlocks, imageBlocks },
    sheets,
    recordings: [],
    skipped,
    importScale: s,
    counts: { strokes: strokes.length - shapeCount, shapes: shapeCount, images: pictures, texts: textBlocks.length, pdfPages },
  };
}

// ------------------------------------------------------------------------------------- helpers

const hex2 = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
const hexOf = (c: [number, number, number, number]) => `#${hex2(c[0])}${hex2(c[1])}${hex2(c[2])}`.toUpperCase();
const hexBytes = (b: Uint8Array | null) => (b ? Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('') : null);

function base64(b: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** A file hash named by a record: a string of hex digits (with or without an extension), in its first slots. */
function hashIn(fb: FlatBuffer, t: number | null): string | null {
  for (let slot = 0; slot < 8; slot++) {
    const v = fb.string(t, slot);
    const m = v ? /^([0-9a-f]{40,128})(\.[a-z0-9]+)?$/i.exec(v.trim()) : null;
    if (m) return m[1];
  }
  return null;
}

/** The unturned box's top-left corner, from the turned box's (turned by `rot` radians about its centre). */
function unturnCorner([x, y]: [number, number], [w, h]: [number, number], rot: number): [number, number] {
  const c = Math.cos(rot), sn = Math.sin(rot);
  return [x - w / 2 + (w / 2) * c - (h / 2) * sn, y - h / 2 + (w / 2) * sn + (h / 2) * c];
}

type Tf = (x: number, y: number) => { x: number; y: number };

/**
 * An ink record as strokes (one per piece: an eraser splits a stroke into pieces); null when its
 * path is of a kind not understood. The path: precision (0 half floats, 1 float32), the number
 * of nodes, the kind (3 cubic Béziers, 7 straight lines); cubic: a node (width factor, force,
 * opacity, …) then per further node a command (0 curve to, 3 move to), its points (offsets from
 * the record's origin) and the node.
 */
function inkOf(fb: FlatBuffer, p: number, tf: Tf, s: number): Stroke[] | null {
  const origin = fb.pair(p, 1);
  const g = fb.bytesOf(p, 9);
  const width = fb.f32At(p, 8);
  if (!origin || !g || g.length < 8 || width === null) return null;
  const dv = new DataView(g.buffer, g.byteOffset, g.byteLength);
  const precise = g[0] === 1, n = dv.getUint16(1, true), kind = g[3];
  if ((g[0] !== 0 && !precise) || !n) return null;
  const sc = fb.pair(p, 3);
  const [kx, ky] = sc && Math.abs(sc[0]) > 1e-6 && Math.abs(sc[1]) > 1e-6 ? sc : [1, 1];
  const rot = fb.f32At(p, 2) ?? 0;
  const cos = Math.cos(rot), sin = Math.sin(rot);
  const size = precise ? 4 : 2;
  const num = (at: number) => (at + size > g.length ? NaN : precise ? dv.getFloat32(at, true) : half(dv.getUint16(at, true)));
  const pt = (dx: number, dy: number) => {
    const x = dx * kx, y = dy * ky;
    return tf(origin[0] + x * cos - y * sin, origin[1] + x * sin + y * cos);
  };
  const tool = fb.u8At(p, 4) ?? 0;
  const c = fb.rgba(p, 7) ?? [0, 0, 0, 255];
  const dashCode = fb.u8At(p, 5) ?? 1;
  const dash = dashCode === 2 ? ('dashed' as const) : dashCode === 3 ? ('dotted' as const) : undefined;
  const base = width * ((Math.abs(kx) + Math.abs(ky)) / 2) * (tool === 1 ? PENCIL_WIDTH : 1) * s;
  const color = hexOf(c);
  const pieces: { x: number; y: number; d: number }[][] = [];
  let alphaSum = 0, alphaN = 0;
  let at = precise ? 12 : 8;
  if (kind === 7) {
    let cur = [{ ...pt(0, 0), d: base }];
    for (let i = 1; i < n; i++) {
      const cmd = g[at], x = num(at + 1), y = num(at + 1 + size);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      if (cmd === 7) {
        pieces.push(cur);
        cur = [];
      } else if (cmd !== 6) return null;
      cur.push({ ...pt(x, y), d: base });
      at += 1 + 2 * size;
    }
    pieces.push(cur);
  } else if (kind === 3) {
    const node = (a: number) => {
      const f = a + 2 <= g.length ? half(dv.getUint16(a, true)) : 1;
      if (a + 4 < g.length) {
        alphaSum += g[a + 4];
        alphaN++;
      }
      return Number.isFinite(f) && f > 0 ? f : 1;
    };
    let fPrev = node(at);
    let cur = [{ ...pt(0, 0), d: base * fPrev }];
    let last = { x: 0, y: 0 };
    for (let i = 1; i < n; i++) {
      const cmd = g[at + 6];
      at += 7;
      if (cmd === 0) {
        const v = [0, 1, 2, 3, 4, 5].map((k) => num(at + k * size));
        if (!v.every(Number.isFinite)) return null;
        at += 6 * size;
        const fNext = node(at);
        const a = pt(last.x, last.y), b = pt(v[0], v[1]), cc = pt(v[2], v[3]), e = pt(v[4], v[5]);
        const len = Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(cc.x - b.x, cc.y - b.y) + Math.hypot(e.x - cc.x, e.y - cc.y);
        const m = Math.max(1, Math.min(64, Math.ceil(len / 1.5)));
        for (let k = 1; k <= m; k++) {
          const t = k / m, u = 1 - t;
          cur.push({
            x: u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * cc.x + t * t * t * e.x,
            y: u * u * u * a.y + 3 * u * u * t * b.y + 3 * u * t * t * cc.y + t * t * t * e.y,
            d: base * (fPrev + (fNext - fPrev) * t),
          });
        }
        last = { x: v[4], y: v[5] };
        fPrev = fNext;
      } else if (cmd === 3) {
        const x = num(at), y = num(at + size);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        at += 2 * size;
        fPrev = node(at);
        pieces.push(cur);
        cur = [{ ...pt(x, y), d: base * fPrev }];
        last = { x, y };
      } else return null;
    }
    pieces.push(cur);
  } else return null;
  // A pencil's opacity is recorded per node (how hard it was pressed): its average.
  const alpha = (c[3] / 255) * (tool === 1 && alphaN ? alphaSum / alphaN / 255 : 1);
  return pieces.filter((q) => q.length).map((q) => strokeFromLine(q, { color, alpha: tool === 2 ? c[3] / 255 : alpha, highlighter: tool === 2, dash }));
}

/** A shape record as a stroke: a line (with its control point, a curve), a polygon, an ellipse. */
function shapeOf(fb: FlatBuffer, p: number, tf: Tf, s: number): Stroke | null {
  const origin = fb.pair(p, 1);
  const sh = fb.ref(p, 5);
  const kind = fb.u8At(p, 4);
  const width = fb.f32At(p, 10);
  if (!origin || sh === null || width === null) return null;
  const rot = fb.f32At(p, 2) ?? 0;
  const cos = Math.cos(rot), sin = Math.sin(rot);
  const P = (dx: number, dy: number): Point => ({ ...tf(origin[0] + dx * cos - dy * sin, origin[1] + dx * sin + dy * cos), pressure: 0.5 });
  const c = fb.rgba(p, 9) ?? [0, 0, 0, 255];
  const tool = fb.u8At(p, 6) ?? 0;
  const dashCode = fb.u8At(p, 7) ?? 1;
  const lineStyle = dashCode === 2 ? ('dashed' as const) : dashCode === 3 ? ('dotted' as const) : ('solid' as const);
  const make = (points: Point[], closed: boolean, shapeKind: Stroke['shapeKind']): Stroke => {
    const common = { id: newId('stroke'), createdAt: 0, color: hexOf(c), lineStyle, points, isShape: true, closed, shapeKind };
    // A shape drawn with the highlighter is a highlighter stroke (see-through, wide).
    return tool === 2
      ? { ...common, tool: 'highlighter', width: (width * s) / 5.5, opacity: 1, penStyle: 'ballpoint', modeled: 'uniform', highlightAlpha: Math.max(0.15, c[3] / 255) }
      : { ...common, tool: 'pen', width: (width * s) / 1.5, opacity: c[3] / 255, penStyle: 'ballpoint' };
  };
  if (kind === 1) {
    const a = fb.pair(sh, 0) ?? [0, 0], b = fb.pair(sh, 3), ctl = fb.pair(sh, 1);
    if (!b) return null;
    if (!ctl) return make([P(a[0], a[1]), P(b[0], b[1])], false, 'line');
    const pts = Array.from({ length: 33 }, (_, i) => {
      const t = i / 32, u = 1 - t;
      return P(u * u * a[0] + 2 * u * t * ctl[0] + t * t * b[0], u * u * a[1] + 2 * u * t * ctl[1] + t * t * b[1]);
    });
    return make(pts, false, 'polyline');
  }
  if (kind === 2) {
    const pts = fb.points(sh, 0);
    if (pts.length < 2) return null;
    const closed = pts.length >= 3;
    return make(pts.map(([x, y]) => P(x, y)), closed, pts.length === 3 ? 'triangle' : pts.length === 4 ? 'rectangle' : 'polygon');
  }
  if (kind === 3) {
    const sz = fb.pair(sh, 1);
    if (!sz) return null;
    const ctr = P(sz[0] / 2, sz[1] / 2);
    const ax = { x: (sz[0] / 2) * cos * s, y: (sz[0] / 2) * sin * s };
    const pts = ellipsePoints(ctr, ax, (Math.abs(sz[1]) / 2) * s, 72);
    return make(pts, true, Math.abs(Math.abs(sz[0]) - Math.abs(sz[1])) < 0.01 * Math.abs(sz[0]) ? 'circle' : 'ellipse');
  }
  return null;
}

/**
 * The runs of a text container (character and paragraph styles over UTF-16 ranges, later records
 * over earlier ones), as the .note importer's text layout takes them. Character style: 3 bold,
 * 4 italic, 5 underline, 7 font, 8 size, 9 colour, 11 strikethrough (each a table, its value in
 * slot 0); paragraph: 2 list level, 5 list kind (1 bullet, 2 numbered, 3 checklist).
 */
function textRuns(
  fb: FlatBuffer,
  st: { text: string; char: { a: number; b: number; p: number }[]; para: { a: number; b: number; p: number }[] },
  font0: string,
  size0: number
): { text: string; runs: Run[] } {
  const text = st.text.replace(/\r\n?/g, '\n').replace(/￼/g, ' ');
  const n = text.length;
  type Style = { font: string; size: number; color: string; bold: boolean; italic: boolean; underline: boolean; strike: boolean; level: number; decoration: number };
  const styles: Style[] = Array.from({ length: n }, () => ({ font: font0, size: size0, color: '#000000', bold: false, italic: false, underline: false, strike: false, level: 0, decoration: 0 }));
  const sub = (p: number, slot: number) => fb.ref(p, slot);
  const flag = (p: number, slot: number) => (sub(p, slot) === null ? null : (fb.u8At(sub(p, slot), 0) ?? 0) !== 0);
  for (const r of st.char) {
    const font = fb.string(sub(r.p, 7), 0), size = fb.f32At(sub(r.p, 8), 0), c = fb.rgba(sub(r.p, 9), 0);
    const bold = flag(r.p, 3), italic = flag(r.p, 4), underline = flag(r.p, 5), strike = flag(r.p, 11);
    for (let i = Math.max(0, r.a); i < Math.min(n, r.b); i++) {
      const x = styles[i];
      if (font) x.font = font;
      if (size !== null && size > 0) x.size = size;
      if (c) x.color = hexOf(c);
      if (bold !== null) x.bold = bold;
      if (italic !== null) x.italic = italic;
      if (underline !== null) x.underline = underline;
      if (strike !== null) x.strike = strike;
    }
  }
  for (const r of st.para) {
    const level = fb.u8At(sub(r.p, 2), 0), deco = fb.u8At(sub(r.p, 5), 0);
    for (let i = Math.max(0, r.a); i < Math.min(n, r.b); i++) {
      if (level !== null) styles[i].level = level;
      if (deco !== null) styles[i].decoration = deco;
    }
  }
  // Bold and italic as the font's name says them (the text layout reads them from it).
  const fontName = (x: Style) => `${x.font}${x.bold || x.italic ? `-${x.bold ? 'Bold' : ''}${x.italic ? 'Italic' : ''}` : ''}`;
  const runs: Run[] = [];
  const key = (x: Style) => `${fontName(x)}|${x.size}|${x.color}|${x.underline}|${x.strike}|${x.level}|${x.decoration}`;
  for (let i = 0; i < n; ) {
    let j = i + 1;
    while (j < n && key(styles[j]) === key(styles[i])) j++;
    const x = styles[i];
    runs.push({ start: i, end: j, font: fontName(x), size: x.size, color: x.color, underline: x.underline, strike: x.strike, level: x.level, decoration: x.decoration, number: 1, checked: false });
    i = j;
  }
  // Numbered items count up within a list (by level; another kind of paragraph ends the list).
  const counters: number[] = [];
  let pos = 0;
  for (const para of text.split('\n')) {
    const r = runs.find((q) => pos >= q.start && pos < q.end);
    if (r && r.decoration === 2 && para.trim()) {
      counters.length = r.level + 1;
      counters[r.level] = (counters[r.level] ?? 0) + 1;
      r.number = counters[r.level];
      // The number belongs to this paragraph's run only.
      if (r.end > pos + para.length + 1) {
        const rest = { ...r, start: pos + para.length + 1 };
        r.end = pos + para.length + 1;
        runs.splice(runs.indexOf(r) + 1, 0, rest);
      }
    } else if (!r || r.decoration !== 2) counters.length = 0;
    pos += para.length + 1;
  }
  return { text, runs };
}
