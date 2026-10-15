/**
 * Stored-note codec (src/storage/db.ts): every note survives pack → structured clone (what
 * IndexedDB does) → unpack exactly, including points without t / alt / az and every recorded
 * stroke in bench/recordings.
 *
 * Run: npm run test:storage
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { deepStrictEqual } from 'node:assert';
import { __storageCodec } from '../src/storage/db';
import type { NoteDocument, Point, Stroke } from '../src/types';

const { packNote, unpackNote } = __storageCodec;
const dir = 'bench/recordings';
const strokes: Stroke[] = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .flatMap((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')).strokes)
  .map((s: { samples: number[][] }, i: number) => ({
    id: `s${i}`, tool: 'pen', color: '#111', width: 1.5, opacity: 1, createdAt: i,
    points: s.samples.map((p, j): Point => {
      const q: Point = { x: p[0], y: p[1], pressure: p[3] };
      if (j % 3) q.t = p[2];
      if (j % 5) q.alt = p[5];
      if (j % 7) q.az = p[6];
      return q;
    }),
    ...(i % 4 ? {} : { modeled: 'variable' as const, rotation: 15 }),
  }));
strokes.push({ id: 'empty', tool: 'highlighter', color: '#ff0', width: 8, opacity: 0.4, points: [] });

const note: NoteDocument = {
  id: 'n', title: 't', createdAt: 1, updatedAt: 2, paperStyle: 'ruled', paperColor: 'white', schemaVersion: 5,
  sheets: [{ id: 'sh' }],
  pages: [
    { id: 'p1', pageNumber: 1, strokes, latexBlocks: [], textBlocks: [], imageBlocks: [] },
    { id: 'p2', pageNumber: 2, strokes: [], latexBlocks: [], textBlocks: [], imageBlocks: [] },
  ],
} as NoteDocument;

const stored = structuredClone(packNote(note));
deepStrictEqual(unpackNote(stored), note);
// A note saved by v2.0.2 and earlier (points as objects) loads unchanged.
deepStrictEqual(unpackNote(structuredClone(note)), note);
// Packing twice gives the same stored strokes (cache) and an unchanged page is reused.
const again = packNote({ ...note, title: 'u' });
if (again.pages[0] !== packNote(note).pages[0]) throw new Error('page not reused');
const n = strokes.reduce((a, s) => a + s.points.length, 0);
console.log(`storage OK: ${strokes.length} strokes, ${n} points round-trip exactly`);
