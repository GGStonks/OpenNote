import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Stroke } from '../types';
import type { SheetBox } from '../editor/sheets';
import { strokeOwnY } from '../editor/sheets';
import { onCanvasDropped, onCanvasMissing, rustForgetCanvasScenes, rustSetCanvasScene } from './rustCore';

/**
 * The native canvas's pages, streamed (rust/DECISIONS.md ADR-007, docs/rust-native-canvas.md
 * "Scale"): the canvas is given each sheet's strokes as a scene of its own (`surfaceId:sheetId`),
 * only for the sheets near the view, and asks for the ones it misses; nothing here walks the
 * note's sheets per frame.
 *
 * - `SheetBuckets`: the surface's strokes by the sheet that owns them (the one holding the middle
 *   of their height, as sheets.ts `ownership`), in the page's order. Kept by difference: a lift
 *   appends to one sheet, an erase takes from some; a bucket that did not change keeps its array,
 *   so the scene sent for it is not sent again.
 * - `nearSheets`: the sheets near a view (binary search on their tops).
 */

/** The scene id of a sheet's ink on the native canvas (crates/canvas FrameSpec's compact `ink`). */
export const sheetSceneId = (surfaceId: string, sheetId: string): string => `${surfaceId}:${sheetId}`;

export class SheetBuckets {
  private strokes: readonly Stroke[] | null = null;
  private sheets: readonly SheetBox[] | null = null;
  private tops: number[] = [];
  private buckets: Stroke[][] = [];
  private owner = new WeakMap<Stroke, number>();
  /** Sheets whose bucket changed since `takeChanged` (or all of them). */
  private changed: Set<number> | 'all' = 'all';

  /** The sheets whose strokes changed since the last call ('all': another layout or the first). */
  takeChanged(): Set<number> | 'all' {
    const c = this.changed;
    this.changed = new Set();
    return c;
  }

  private mark(k: number): void {
    if (this.changed !== 'all') this.changed.add(k);
  }

  /** The owning sheet's index (cached per stroke for this layout). */
  private sheetOf(s: Stroke): number {
    let k = this.owner.get(s);
    if (k === undefined) {
      const y = strokeOwnY(s);
      const t = this.tops;
      let lo = 0, hi = t.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (t[mid] <= y) lo = mid;
        else hi = mid - 1;
      }
      k = Math.max(0, lo);
      this.owner.set(s, k);
    }
    return k;
  }

  private rebuild(strokes: readonly Stroke[]): void {
    const prev = this.buckets;
    const next: Stroke[][] = this.tops.map(() => []);
    for (const s of strokes) next[this.sheetOf(s)].push(s);
    // A bucket whose strokes are the same keeps its array (nothing to send for it).
    this.buckets = next.map((b, i) => {
      const p = prev[i];
      if (p && p.length === b.length && p.every((s, j) => s === b[j])) return p;
      this.mark(i);
      return b;
    });
  }

  /** Each sheet's strokes, in the page's order. Unchanged buckets keep their array. */
  update(strokes: readonly Stroke[], sheets: readonly SheetBox[]): readonly Stroke[][] {
    if (sheets !== this.sheets) {
      const tops = sheets.map((s) => s.top);
      const same = tops.length === this.tops.length && tops.every((t, i) => t === this.tops[i]);
      this.sheets = sheets;
      if (!same) {
        const old = this.tops;
        const extends_ = tops.length > old.length && old.length > 0 && old.every((t, i) => t === tops[i]);
        this.tops = tops;
        if (extends_) {
          // Pages added at the end (the pull): only the strokes of the last page before them may
          // belong to a new one; every other bucket keeps its array.
          for (const st of this.buckets[old.length - 1] ?? []) this.owner.delete(st);
          const all = this.strokes;
          this.strokes = null;
          if (all) {
            this.strokes = all;
            this.rebuild(all);
            for (let k = old.length; k < tops.length; k++) this.mark(k);
          }
        } else {
          // Another layout: owners again (a page inserted moves those below it; their strokes are
          // new objects anyway).
          this.owner = new WeakMap();
          this.buckets = [];
          this.strokes = null;
          this.changed = 'all';
        }
      }
    }
    if (strokes === this.strokes) return this.buckets;
    const old = this.strokes;
    this.strokes = strokes;
    if (!old) {
      this.rebuild(strokes);
      return this.buckets;
    }
    // What changed: a common start and a common end, the middle replaced.
    let p = 0;
    const n = Math.min(old.length, strokes.length);
    while (p < n && old[p] === strokes[p]) p++;
    let q = 0;
    while (q < n - p && old[old.length - 1 - q] === strokes[strokes.length - 1 - q]) q++;
    const removed = old.slice(p, old.length - q);
    const added = strokes.slice(p, strokes.length - q);
    if (removed.length === 0 && q === 0) {
      // Appended (a lift, a paste at the end): each sheet's new strokes go after its others.
      const touched = new Map<number, Stroke[]>();
      for (const s of added) {
        const k = this.sheetOf(s);
        let b = touched.get(k);
        if (!b) touched.set(k, (b = [...this.buckets[k]]));
        b.push(s);
      }
      for (const [k, b] of touched) {
        this.buckets[k] = b;
        this.mark(k);
      }
      return this.buckets;
    }
    if (added.length === 0) {
      // Taken out (erased, deleted): those sheets' buckets without them.
      const gone = new Set(removed);
      const sheetsHit = new Set(removed.map((s) => this.sheetOf(s)));
      for (const k of sheetsHit) {
        this.buckets[k] = this.buckets[k].filter((s) => !gone.has(s));
        this.mark(k);
      }
      return this.buckets;
    }
    // Anything else (moved, reshaped, reordered): every bucket again, unchanged ones kept.
    this.rebuild(strokes);
    return this.buckets;
  }
}

/**
 * The sheets near a view (surface px, top and bottom), nearest first: those in view, then the
 * others within `margin` (surface px) above and below, more ahead of the motion (`ahead`: signed,
 * surface px). A binary search on the tops: O(log n + found).
 */
export function nearSheets(sheets: readonly SheetBox[], top: number, bottom: number, margin: number, ahead = 0): number[] {
  if (!sheets.length || !(bottom >= top)) return [];
  const lo = top - margin + Math.min(0, ahead), hi = bottom + margin + Math.max(0, ahead);
  // First sheet whose bottom is below `lo`.
  let a = 0, b = sheets.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (sheets[m].top + sheets[m].height < lo) a = m + 1;
    else b = m;
  }
  const out: { i: number; d: number }[] = [];
  const mid = (top + bottom) / 2;
  for (let i = a; i < sheets.length && sheets[i].top <= hi; i++) {
    const s = sheets[i];
    const inView = s.top <= bottom && s.top + s.height >= top;
    const d = inView ? 0 : Math.min(Math.abs(s.top - mid), Math.abs(s.top + s.height - mid));
    out.push({ i, d });
  }
  return out.sort((x, y) => x.d - y.d).map((o) => o.i);
}

const NO_STROKES: readonly Stroke[] = [];
/** Of `hidden`, whether any is in `b` (cached per bucket and set): the set when so, else null. */
const hiddenCache = new WeakMap<readonly Stroke[], { h: ReadonlySet<string>; r: ReadonlySet<string> | null }>();
function hiddenIn(b: readonly Stroke[], hidden: ReadonlySet<string> | null): ReadonlySet<string> | null {
  if (!hidden || !b.length) return null;
  const c = hiddenCache.get(b);
  if (c && c.h === hidden) return c.r;
  const r = b.some((s) => hidden.has(s.id)) ? hidden : null;
  hiddenCache.set(b, { h: hidden, r });
  return r;
}

interface Version {
  b: readonly Stroke[];
  h: ReadonlySet<string> | null;
}

/** Ahead of the motion: its speed (surface px per ms) times this, at most this many screens. */
const AHEAD_MS = 500;
const AHEAD_SCREENS = 4;

/**
 * Streams the note's sheets to the native canvas (ADR-007): each sheet's strokes as a scene of its
 * own, sent when the sheet comes near the view (the view with a screen around it, more ahead of
 * the motion; nearest first, one at a time, never blocking a frame) or when the canvas says it
 * misses it (the camera's `missing`, its reply's `dropped`), and again when its strokes change
 * (by difference: the canvas keeps each stroke's drawn line by key). A sheet changed far from the
 * view is forgotten by the canvas until it comes near. `sent` counts the sends made for a change
 * and `arrived` is their arrival (a finished stroke's live copy stays until then).
 */
export function useCanvasPageStream(o: {
  enabled: boolean;
  surfaceId: string;
  strokes: readonly Stroke[];
  hidden: ReadonlySet<string> | null;
  sheets: readonly SheetBox[];
  surfaceWidth: number;
  container: RefObject<HTMLElement | null>;
  scrollRoot: HTMLElement | null;
}): { sent: { current: number }; arrived: { current: Promise<unknown> } } {
  const sent = useRef(0);
  const arrived = useRef<Promise<unknown>>(Promise.resolve());
  const bucketsRef = useRef<SheetBuckets | null>(null);
  if (!bucketsRef.current) bucketsRef.current = new SheetBuckets();
  const buckets = useMemo(() => (o.enabled ? bucketsRef.current!.update(o.strokes, o.sheets) : null), [o.enabled, o.strokes, o.sheets]);
  const index = useMemo(() => new Map(o.sheets.map((sh, k) => [sheetSceneId(o.surfaceId, sh.id), k])), [o.sheets, o.surfaceId]);
  const latest = useRef({ ...o, buckets, index });
  latest.current = { ...o, buckets, index };
  const stream = useRef<{
    sent: Map<string, Version>;
    inflight: Map<string, Version>;
    busy: boolean;
    alive: boolean;
    missing: string[];
    near: number[];
    lastTop: number;
    lastAt: number;
    speed: number;
    needs: (k: number) => boolean;
    send: (k: number) => Promise<unknown>;
  } | null>(null);

  useEffect(() => {
    if (!o.enabled) return;
    const surfaceId = o.surfaceId;
    const versionOf = (k: number): { id: string; v: Version } | null => {
      const L = latest.current;
      const sh = L.sheets[k];
      if (!sh || !L.buckets) return null;
      const b = L.buckets[k] ?? NO_STROKES;
      return { id: sheetSceneId(surfaceId, sh.id), v: { b, h: hiddenIn(b, L.hidden) } };
    };
    const s = {
      sent: new Map<string, Version>(),
      inflight: new Map<string, Version>(),
      busy: false,
      alive: true,
      missing: [] as string[],
      near: [] as number[],
      lastTop: NaN,
      lastAt: 0,
      speed: 0,
      needs: (k: number) => {
        const x = versionOf(k);
        if (!x) return false;
        const cur = s.inflight.get(x.id) ?? s.sent.get(x.id);
        return !cur || cur.b !== x.v.b || cur.h !== x.v.h;
      },
      send: (k: number): Promise<unknown> => {
        const x = versionOf(k);
        if (!x) return Promise.resolve();
        const strokes = x.v.h ? x.v.b.filter((st) => !x.v.h!.has(st.id)) : x.v.b;
        s.inflight.set(x.id, x.v);
        return rustSetCanvasScene(x.id, strokes, true).finally(() => {
          if (s.inflight.get(x.id) === x.v) s.inflight.delete(x.id);
          if (!s.alive) return;
          // Its sheet went while it was on its way (another layout): the canvas forgets it.
          if (!latest.current.index.has(x.id)) void rustForgetCanvasScenes({ ids: [x.id] });
          else s.sent.set(x.id, x.v);
        });
      },
    };
    stream.current = s;
    // One at a time, nearest first: what the canvas misses, then what is near.
    const pump = () => {
      if (s.busy || !s.alive) return;
      const { index } = latest.current;
      let next = -1;
      for (const id of s.missing) {
        const k = index.get(id);
        if (k !== undefined && s.needs(k)) {
          next = k;
          break;
        }
      }
      if (next < 0) next = s.near.find((k) => s.needs(k)) ?? -1;
      if (next < 0) return;
      s.busy = true;
      void s.send(next).finally(() => {
        s.busy = false;
        if (s.alive) pump();
      });
    };
    onCanvasDropped((ids) => {
      for (const id of ids) s.sent.delete(id);
      pump();
    });
    onCanvasMissing((ids) => {
      s.missing = ids;
      // The canvas does not have them (evicted, or a call that failed): sent again.
      for (const id of ids) if (!s.inflight.has(id)) s.sent.delete(id);
      pump();
    });
    // What is near, read from the page's own box each frame (O(log pages + near)).
    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const L = latest.current;
      const el = L.container.current;
      if (!el || !L.surfaceWidth) return;
      const r = el.getBoundingClientRect();
      const v = L.scrollRoot?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
      const k = r.width / L.surfaceWidth;
      if (!(k > 0)) return;
      const top = (v.top - r.top) / k, bottom = (v.bottom - r.top) / k;
      const now = performance.now();
      const dt = now - s.lastAt;
      if (dt > 0 && dt < 250 && Number.isFinite(s.lastTop)) s.speed += ((top - s.lastTop) / dt - s.speed) * 0.5;
      else if (dt >= 250) s.speed = 0;
      s.lastTop = top;
      s.lastAt = now;
      const h = bottom - top;
      const ahead = Math.max(-AHEAD_SCREENS * h, Math.min(AHEAD_SCREENS * h, s.speed * AHEAD_MS));
      s.near = nearSheets(L.sheets, top, bottom, h, ahead);
      pump();
    };
    raf = requestAnimationFrame(frame);
    return () => {
      s.alive = false;
      cancelAnimationFrame(raf);
      onCanvasDropped(null);
      onCanvasMissing(null);
      if (stream.current === s) stream.current = null;
      // The note closed: its scenes and the strokes' drawn lines the canvas kept go.
      void rustForgetCanvasScenes({ prefix: surfaceId });
    };
  }, [o.enabled, o.surfaceId]);

  // The strokes changed: sheets near the view sent now (a lift's live copy waits for them), those
  // the canvas has far from it forgotten (sent again when they come near).
  useEffect(() => {
    const s = stream.current;
    const B = bucketsRef.current;
    if (!s || !o.enabled || !B) return;
    const changed = B.takeChanged();
    const near = new Set(s.near);
    const ids = latest.current.index;
    const sends: number[] = [];
    const forget: string[] = [];
    const consider = (k: number) => {
      if (!s.needs(k)) return;
      if (near.has(k)) sends.push(k);
      else {
        const sh = o.sheets[k];
        const id = sh && sheetSceneId(o.surfaceId, sh.id);
        if (id && (s.sent.has(id) || s.inflight.has(id))) {
          s.sent.delete(id);
          forget.push(id);
        }
      }
    };
    if (changed === 'all') {
      // Another layout: what the canvas has of sheets that are gone, forgotten.
      for (const id of [...s.sent.keys()]) {
        const k = ids.get(id);
        if (k === undefined) {
          s.sent.delete(id);
          forget.push(id);
        } else consider(k);
      }
      for (const k of near) consider(k);
    } else {
      for (const k of changed) consider(k);
      // Strokes hidden or shown again (moved, reshaped): the sheets holding them.
      for (const k of near) consider(k);
      if (o.hidden || [...s.sent.values()].some((v) => v.h)) for (const id of [...s.sent.keys()]) {
        const k = ids.get(id);
        if (k !== undefined) consider(k);
      }
    }
    if (forget.length) void rustForgetCanvasScenes({ ids: forget });
    if (sends.length) {
      sent.current++;
      arrived.current = Promise.all(sends.map((k) => s.send(k)));
    }
  }, [o.enabled, o.surfaceId, buckets, o.strokes, o.hidden, o.sheets]);

  return { sent, arrived };
}

/** Sheets kept in the page's DOM beyond those near the view, each way (fewer re-renders). */
const WINDOW_SLACK = 4;

/**
 * The sheets the page keeps in its DOM while the native canvas draws the note (ADR-007: the page's
 * DOM near the view only): those within a screen of the view and `WINDOW_SLACK` more each way,
 * as indices [lo, hi]. Changes only when the view leaves that window (a re-render every few
 * pages of travel, not per frame); null when every sheet is kept (not native, or a short note).
 */
export function useSheetWindow(enabled: boolean, sheets: readonly SheetBox[], surfaceWidth: number, container: RefObject<HTMLElement | null>, scrollRoot: HTMLElement | null): [number, number] | null {
  const on = enabled && sheets.length > 2 * WINDOW_SLACK + 4;
  const [win, setWin] = useState<[number, number] | null>(null);
  const latest = useRef({ sheets, surfaceWidth, scrollRoot, win });
  latest.current = { sheets, surfaceWidth, scrollRoot, win };
  useEffect(() => {
    if (!on) {
      setWin(null);
      return;
    }
    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const L = latest.current;
      const el = container.current;
      if (!el || !L.surfaceWidth) return;
      const r = el.getBoundingClientRect();
      const v = L.scrollRoot?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
      const k = r.width / L.surfaceWidth;
      if (!(k > 0)) return;
      const top = (v.top - r.top) / k, bottom = (v.bottom - r.top) / k;
      const near = nearSheets(L.sheets, top, bottom, bottom - top);
      if (!near.length) return;
      const a = Math.min(...near), b = Math.max(...near);
      const w = L.win;
      if (w && a >= w[0] && b <= w[1]) return;
      setWin([Math.max(0, a - WINDOW_SLACK), Math.min(L.sheets.length - 1, b + WINDOW_SLACK)]);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [on, container]);
  // Before the first frame's measure: the first sheets (the view is placed in the next frame).
  return on ? (win ?? [0, Math.min(sheets.length - 1, 2 * WINDOW_SLACK + 2)]) : null;
}
