import { Stroke } from '../types';
import { paintStrokeFill, paintStrokeInk } from '../ink/strokeRenderer';
import { StoredThumb, getAllThumbs, putThumb } from '../storage/db';
import { frameRate } from './frameRate';

/**
 * Library thumbnails as images. Drawing each card's first page from its strokes when the library
 * opened (every stroke through the ink engine, for every note) held the home screen up for
 * seconds on a large library. A card's ink is now drawn once into an image, stored with the note's
 * updatedAt, and shown from there; a missing or out-of-date one is drawn in the background, a slice
 * per frame, one at a time (the cards nearest the screen first), and the out-of-date image shown
 * meanwhile.
 */

/** Width (px) a thumbnail's page is drawn at: sharp on the widest cards at 2x. */
export const THUMB_PAGE_PX = 640;

let thumbs: Map<string, StoredThumb> | null = null;
let loading: Promise<Map<string, StoredThumb>> | null = null;

export function loadThumbs(): Promise<Map<string, StoredThumb>> {
  if (thumbs) return Promise.resolve(thumbs);
  loading ??= getAllThumbs()
    .catch(() => [] as StoredThumb[])
    .then((all) => (thumbs = new Map(all.map((t) => [t.id, t]))));
  return loading;
}

export function cachedThumb(id: string): StoredThumb | undefined {
  return thumbs?.get(id);
}

interface Job {
  id: string;
  run: () => Promise<void>;
  cancelled: boolean;
}
const queue: Job[] = [];
let running = false;

async function pump() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const job = queue.shift()!;
      if (!job.cancelled) await job.run();
    }
  } finally {
    running = false;
  }
}

const nextSlice = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Draws `strokes` (moved by `offset` into a page of `width` x `height`) into an image a slice at a
 * time, in drawStrokes' order (highlighters, fills, ink); null if cancelled.
 */
async function drawSliced(strokes: Stroke[], width: number, height: number, offset: { x: number; y: number }, job: Job): Promise<string | null> {
  const k = THUMB_PAGE_PX / width;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(width * k));
  c.height = Math.max(1, Math.round(height * k));
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(k, 0, 0, k, offset.x * k, offset.y * k);
  const passes: [(s: Stroke) => boolean, (s: Stroke) => void][] = [
    [(s) => s.tool === 'highlighter', (s) => paintStrokeInk(ctx, s)],
    [(s) => s.tool !== 'highlighter' && !!s.fill && s.fill !== 'none', (s) => paintStrokeFill(ctx, s)],
    [(s) => s.tool !== 'highlighter', (s) => paintStrokeInk(ctx, s)],
  ];
  let until = performance.now() + frameRate.frameMs * 0.36;
  for (const [want, paint] of passes) {
    for (const s of strokes) {
      if (!want(s) || !s.points.length) continue;
      paint(s);
      if (performance.now() > until) {
        await nextSlice();
        if (job.cancelled) return null;
        until = performance.now() + frameRate.frameMs * 0.36;
      }
    }
  }
  const url = c.toDataURL('image/webp', 0.85);
  c.width = c.height = 0;
  return url;
}

/**
 * The image of one ink layer of a note's first page: from the cache when it is up to date, else
 * drawn in the background. `shown` gets the image now if one is stored (also out of date) and again
 * when a new one is drawn. Returns a cancel.
 */
export function requestThumb(
  id: string,
  noteId: string,
  updatedAt: number,
  strokes: Stroke[],
  width: number,
  height: number,
  offset: { x: number; y: number },
  shown: (url: string) => void
): () => void {
  let cancelled = false;
  const job: Job = {
    id,
    cancelled: false,
    run: async () => {
      const url = await drawSliced(strokes, width, height, offset, job);
      if (!url || job.cancelled) return;
      const t = { id, noteId, updatedAt, url };
      thumbs?.set(id, t);
      shown(url);
      await putThumb(t).catch(() => undefined);
    },
  };
  void loadThumbs().then((map) => {
    if (cancelled) return;
    const have = map.get(id);
    if (have) shown(have.url);
    if (have?.updatedAt === updatedAt) return;
    queue.push(job);
    void pump();
  });
  return () => {
    cancelled = job.cancelled = true;
  };
}
