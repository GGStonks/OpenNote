import { readFileSync, readdirSync } from 'node:fs';
import type { LineStyle } from '../../src/types';
import type { PenRecording } from '../../src/ink/penRecorder';

export const RECORDINGS_DIR = 'bench/recordings/';

export function listRecordingFiles(named?: string[]): string[] {
  if (named && named.length > 0) return named;
  return readdirSync(RECORDINGS_DIR).filter((f) => f.endsWith('.json')).sort().map((f) => RECORDINGS_DIR + f);
}

export function loadRecording(file: string): PenRecording {
  return JSON.parse(readFileSync(file, 'utf8')) as PenRecording;
}

// 9 significant digits: far below what the Rust test should allow (1e-6 px), and a smaller file.
export const n = (v: number): number => (Number.isFinite(v) ? Number(v.toPrecision(9)) : v);
export const pt4 = (q: { x: number; y: number; t?: number; pressure?: number; p?: number }): number[] => [n(q.x), n(q.y), n(q.t ?? 0), n(q.pressure ?? q.p ?? 0)];
export const xy = (q: { x: number; y: number }): number[] => [n(q.x), n(q.y)];
export const STYLES: LineStyle[] = ['dashed', 'longdash', 'dotted', 'dashdot'];
