/**
 * Stored-note codec (src/storage/db.ts): every note survives pack → structured clone (what
 * IndexedDB does) → unpack exactly, including points without t / alt / az and every recorded
 * stroke in bench/recordings.
 *
 * Also writes and verifies round-trips with Rust model crate (bench/rust-ref/storage).
 *
 * Run: npm run test:storage
 * Read-back runs whenever the Rust files exist (or with --rust, which requires them).
 */
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { deepStrictEqual, strictEqual } from 'node:assert';
import { __storageCodec, LibraryBackup, BackupFile } from '../src/storage/db';
import type { NoteDocument, Point, Stroke, PageSheet, Folder, Tag } from '../src/types';

const { packNote, unpackNote } = __storageCodec;
const dir = 'bench/recordings';
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort();

const strokes: Stroke[] = files
  .flatMap((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')).strokes)
  .map((s: { samples: number[][] }, i: number) => ({
    id: `s${i}`,
    tool: 'pen',
    color: '#111',
    width: 1.5,
    opacity: 1,
    createdAt: i,
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

const pdfFile: BackupFile = {
  id: 'pdf_file_1',
  name: 'test_document.pdf',
  mime: 'application/pdf',
  base64: Buffer.from('%PDF-1.4 mock pdf content for storage roundtrip test').toString('base64'),
};

const folders: Folder[] = [
  { id: 'folder_1', name: 'Work', color: '#3b82f6', createdAt: 1000 },
];

const tags: Tag[] = [
  { id: 'tag_1', name: 'Important', color: '#ef4444' },
];

const sheets: PageSheet[] = [
  {
    id: 'sh1',
    pdf: { file: 'pdf_file_1', page: 1 },
  },
  {
    id: 'sh2',
  },
];

const note: NoteDocument = {
  id: 'note_storage_roundtrip',
  title: 'Storage Roundtrip Note',
  folderId: 'folder_1',
  tagIds: ['tag_1'],
  createdAt: 1000,
  updatedAt: 2000,
  paperStyle: 'ruled',
  paperColor: 'white',
  schemaVersion: 5,
  sheets,
  pages: [
    { id: 'p1', pageNumber: 1, strokes, latexBlocks: [], textBlocks: [], imageBlocks: [] },
    { id: 'p2', pageNumber: 2, strokes: [], latexBlocks: [], textBlocks: [], imageBlocks: [] },
  ],
};

const backup: LibraryBackup = {
  format: 'opennote-backup',
  version: 2,
  exportedAt: 1700000000000,
  folders,
  tags,
  notes: [note],
  files: [pdfFile],
};

const storageDir = 'bench/rust-ref/storage';
if (!existsSync(storageDir)) {
  mkdirSync(storageDir, { recursive: true });
}

function serializePackedNote(n: NoteDocument, extraFiles?: BackupFile[]): string {
  const packed = packNote(n);
  const serializable = {
    ...packed,
    pages: packed.pages.map((p) => ({
      ...p,
      strokes: p.strokes.map((s) => {
        const { pts, points: _pts, ...rest } = s as any;
        if (pts instanceof Float64Array) {
          const arr = Array.from(pts).map((v) => (Number.isNaN(v) ? null : v));
          return { ...rest, pts: arr };
        }
        return s;
      }),
    })),
    ...(extraFiles ? { files: extraFiles } : {}),
  };
  return JSON.stringify(serializable, null, 2);
}

// 1. Write reference files for Rust
const backupPath = join(storageDir, 'backup.json');
writeFileSync(backupPath, JSON.stringify(backup, null, 2), 'utf8');

const notePath = join(storageDir, 'note.opennote');
writeFileSync(notePath, serializePackedNote(note, [pdfFile]), 'utf8');

// 2. Original in-memory tests
const stored = structuredClone(packNote(note));
deepStrictEqual(unpackNote(stored), note);
// A note saved by v2.0.2 and earlier (points as objects) loads unchanged.
deepStrictEqual(unpackNote(structuredClone(note)), note);
// Packing twice gives the same stored strokes (cache) and an unchanged page is reused.
const again = packNote({ ...note, title: 'u' });
if (again.pages[0] !== packNote(note).pages[0]) throw new Error('page not reused');
const n = strokes.reduce((a, s) => a + s.points.length, 0);
console.log(`storage OK: ${strokes.length} strokes, ${n} points round-trip exactly`);

// 3. Rust read-back comparison
function deserializePackedNote(jsonStr: string): { note: NoteDocument; files?: BackupFile[] } {
  const raw = JSON.parse(jsonStr);
  const { files: extraFiles, ...noteData } = raw;
  const withFloat64 = {
    ...noteData,
    pages: noteData.pages.map((p: any) => ({
      ...p,
      strokes: p.strokes.map((s: any) => {
        if (Array.isArray(s.pts)) {
          const f64 = new Float64Array(s.pts.map((v: number | null) => (v === null ? NaN : v)));
          const { points: _p, ...rest } = s;
          return { ...rest, pts: f64 };
        }
        return s;
      }),
    })),
  };
  return { note: unpackNote(withFloat64), files: extraFiles };
}

const rustBackupPath = join(storageDir, 'backup.rust.json');
const rustNotePath = join(storageDir, 'note.rust.opennote');
const rustRequested = process.argv.includes('--rust');

if (rustRequested || (existsSync(rustBackupPath) && existsSync(rustNotePath))) {
  if (!existsSync(rustBackupPath) || !existsSync(rustNotePath)) {
    throw new Error('Rust output files missing in bench/rust-ref/storage; run cargo test -p model --test ts_roundtrip first');
  }

  // 1. Verify backup.rust.json
  const rustBackupRaw = JSON.parse(readFileSync(rustBackupPath, 'utf8'));
  strictEqual(rustBackupRaw.format, 'opennote-backup');
  strictEqual(rustBackupRaw.version, 2);
  deepStrictEqual(rustBackupRaw.folders, folders);
  deepStrictEqual(rustBackupRaw.tags, tags);
  deepStrictEqual(rustBackupRaw.files, [pdfFile]);
  strictEqual(rustBackupRaw.notes.length, 1);
  const unpackedBackupNote = unpackNote(rustBackupRaw.notes[0]);
  deepStrictEqual(unpackedBackupNote, note);

  // 2. Verify note.rust.opennote
  const { note: rustNote, files: rustNoteFiles } = deserializePackedNote(readFileSync(rustNotePath, 'utf8'));
  deepStrictEqual(rustNoteFiles, [pdfFile]);
  deepStrictEqual(rustNote, note);

  // 3. Verify repack on rust-decoded note gives identical packed result
  const repacked = packNote(rustNote);
  deepStrictEqual(unpackNote(repacked), note);

  console.log(`storage Rust round-trip OK: read-back matches original TS data point-for-point`);
}
