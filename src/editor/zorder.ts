import { ImageBlock, LatexBlock, NotePage, Stroke, TextBlock } from '../types';

/**
 * Stacking order of a page's content: everything (strokes, images, LaTeX, text) is stacked in the
 * order it was made, older below newer. A stroke drawn before an image was inserted stays under
 * it; one drawn afterwards goes over it.
 *
 * Ink is painted on canvases (CanvasPage InkTile), blocks are HTML: the page is drawn as a list of
 * layers, each block a layer of its own and the strokes made between two blocks one ink layer.
 */

type Timed = { id: string; createdAt?: number };

/** When an item was made: its createdAt, or (strokes made before v2.0.1) the time in its id (newId). */
export function itemTime(x: Timed): number {
  if (typeof x.createdAt === 'number') return x.createdAt;
  const t = parseInt(x.id.split('_')[1] ?? '', 36);
  return Number.isFinite(t) ? t : 0;
}

export type ZLayer =
  | { kind: 'ink'; key: string; strokes: Stroke[] }
  | { kind: 'image'; key: string; block: ImageBlock }
  | { kind: 'latex'; key: string; block: LatexBlock }
  | { kind: 'text'; key: string; block: TextBlock };

type BlockLayer = Exclude<ZLayer, { kind: 'ink' }>;

/**
 * The page's layers, bottom to top. Within an ink layer strokes keep their order on the page.
 * `prev`: the previous result; an ink layer whose strokes did not change keeps its array, so its
 * canvases are not repainted.
 */
export function zLayers(page: NotePage, prev?: ZLayer[]): ZLayer[] {
  const blocks: { t: number; layer: BlockLayer }[] = [];
  for (const b of page.imageBlocks ?? []) blocks.push({ t: itemTime(b), layer: { kind: 'image', key: b.id, block: b } });
  for (const b of page.latexBlocks) blocks.push({ t: itemTime(b), layer: { kind: 'latex', key: b.id, block: b } });
  for (const b of page.textBlocks ?? []) blocks.push({ t: itemTime(b), layer: { kind: 'text', key: b.id, block: b } });
  blocks.sort((a, b) => a.t - b.t);

  // Ink layer k: the strokes made after block k-1 and before block k.
  const ink: Stroke[][] = blocks.map(() => []);
  ink.push([]);
  for (const s of page.strokes) {
    const t = itemTime(s);
    let lo = 0, hi = blocks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (blocks[mid].t <= t) lo = mid + 1;
      else hi = mid;
    }
    ink[lo].push(s);
  }

  const before = new Map<string, Stroke[]>();
  for (const l of prev ?? []) if (l.kind === 'ink') before.set(l.key, l.strokes);
  const out: ZLayer[] = [];
  const addInk = (key: string, strokes: Stroke[]) => {
    if (!strokes.length) return;
    const old = before.get(key);
    const same = old && old.length === strokes.length && old.every((s, i) => s === strokes[i]);
    out.push({ kind: 'ink', key, strokes: same ? old : strokes });
  };
  addInk('ink:base', ink[0]);
  blocks.forEach((b, i) => {
    out.push(b.layer);
    addInk(`ink:${b.layer.key}`, ink[i + 1]);
  });
  return out;
}

/**
 * New creation times for a copy of items (paste, duplicates): the copy is made now and goes on
 * top, its items keeping their stacking order among themselves.
 */
export function restamp<C extends { strokes: Stroke[]; latexBlocks: LatexBlock[]; textBlocks: TextBlock[]; imageBlocks: ImageBlock[] }>(c: C, now = Date.now()): C {
  const out: C = { ...c, strokes: [...c.strokes], latexBlocks: [...c.latexBlocks], textBlocks: [...c.textBlocks], imageBlocks: [...c.imageBlocks] };
  const all: { t: number; set: (t: number) => void }[] = [];
  (['strokes', 'latexBlocks', 'textBlocks', 'imageBlocks'] as const).forEach((k) => {
    const list = out[k] as Timed[];
    list.forEach((x, i) => all.push({ t: itemTime(x), set: (t) => (list[i] = { ...x, createdAt: t }) }));
  });
  all.sort((a, b) => a.t - b.t);
  all.forEach((e, rank) => e.set(now + rank / 1000));
  return out;
}
