/**
 * The app's Rust library on the devices (crates/native): the iOS shell links it (`rust` command of
 * the `opennote` message handler), Android loads it (OpenNoteRustPlugin). Requests and replies are
 * framed as crates/native/src/lib.rs says (u32 meta length, meta JSON, binary data), base64 over the
 * bridge. Everything here falls back to TypeScript: without the library (the browser, a build
 * without Rust), with Rust switched off (Settings > Diagnostics), or when a call fails.
 *
 * What Rust does now: the drawn line of every stroke of a note before the GPU ink is prepared, and
 * of a library card's strokes before its thumbnail is drawn (`prepareGeometry`), the very line
 * strokeGeometry computes (crates/ink/tests/reference.rs, to 1e-4 px), off the page's main thread.
 * The live line while writing stays TypeScript.
 */
import { useEffect, useState } from 'react';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { NoteDocument, Stroke } from '../types';
import { bytesToBase64, fromBase64, hasNativeCanvas, hasNativeViewport, platformKind } from '../platform';
import { computeStrokeGeometry, hasStrokeGeometry, setStrokeGeometry, type InkGeometry } from '../ink/strokeRenderer';
import { packedPoints, PACKED_STRIDE } from '../storage/packedPoints';
import { crashLog } from './crashLog';

interface RustPlugin {
  available(): Promise<{ available: boolean; error?: string }>;
  call(o: { method: string; data: string }): Promise<{ data: string }>;
}

const KEY = 'opennote_rust';
/** Fewer points than this go faster in TypeScript than through the bridge. */
const MIN_POINTS = 2000;

export function rustEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setRustEnabled(on: boolean): void {
  try {
    if (on) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, 'off');
  } catch {
    /* the setting stays as it was */
  }
}

let plugin: RustPlugin | null = null;
let availability: Promise<string | null> | null = null;

/** null when the library answers, else why not. */
export function rustUnavailable(): Promise<string | null> {
  availability ??= (async () => {
    const kind = platformKind();
    if (kind === 'ios') {
      try {
        const { meta } = await rustCall('info', {});
        return meta.error ? String(meta.error) : null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    }
    if (kind === 'capacitor' && Capacitor.getPlatform() === 'android') {
      plugin = registerPlugin<RustPlugin>('OpenNoteRust');
      try {
        const a = await plugin.available();
        return a.available ? null : a.error ?? 'not loaded';
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    }
    return 'no Rust library in a browser';
  })();
  return availability;
}

export interface RustReply {
  meta: Record<string, unknown>;
  data: Uint8Array;
  /** Time the page waited for the reply (bridge and Rust, off the main thread). */
  waitMs: number;
  /** How the request and reply crossed the bridge. */
  via: 'binary' | 'base64';
}

/** Android's binary route: the object OpenNoteRustPlugin injects (addWebMessageListener). */
interface RustPort {
  postMessage(data: ArrayBuffer): void;
  onmessage: ((e: { data: ArrayBuffer }) => void) | null;
}
const port = (): RustPort | undefined => (window as unknown as { OpenNoteRustPort?: RustPort }).OpenNoteRustPort;
const waiting = new Map<number, (reply: Uint8Array) => void>();
let nextId = 1;

function viaPort(p: RustPort, method: string, req: Uint8Array): Promise<Uint8Array> {
  if (!p.onmessage) {
    p.onmessage = (e) => {
      const bytes = new Uint8Array(e.data);
      const id = new DataView(e.data).getUint32(0, true);
      waiting.get(id)?.(bytes.subarray(4));
      waiting.delete(id);
    };
  }
  const id = nextId++;
  const name = new TextEncoder().encode(method);
  const msg = new Uint8Array(5 + name.length + req.length);
  new DataView(msg.buffer).setUint32(0, id, true);
  msg[4] = name.length;
  msg.set(name, 5);
  msg.set(req, 5 + name.length);
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    p.postMessage(msg.buffer);
  });
}

/** iOS: binary unless the shell's scheme route failed once (then base64 for the session). */
let iosBinary = true;

/**
 * One call: `meta` as JSON and `data` framed, the reply unframed. Binary both ways where the
 * shell can (iOS: POST opennote://app/__rust/<method>; Android: OpenNoteRustPort), else base64
 * through the message bridge (on a Galaxy Tab A8 ~1.5 s for a 54,000-point request, more than
 * Rust's own work). Throws when the bridge fails.
 */
export async function rustCall(method: string, meta: unknown, data: Uint8Array = new Uint8Array(0)): Promise<RustReply> {
  const m = new TextEncoder().encode(JSON.stringify(meta));
  const req = new Uint8Array(4 + m.length + data.length);
  new DataView(req.buffer).setUint32(0, m.length, true);
  req.set(m, 4);
  req.set(data, 4 + m.length);
  // Only the waiting counts as off the main thread (base64 is the page's own work).
  let waitMs = 0;
  const wait = async <T>(p: Promise<T>): Promise<T> => {
    const t = performance.now();
    try {
      return await p;
    } finally {
      waitMs += performance.now() - t;
    }
  };
  let bytes: Uint8Array | null = null;
  let via: RustReply['via'] = 'binary';
  if (platformKind() === 'ios') {
    if (iosBinary) {
      try {
        const res = await wait(fetch(`/__rust/${method}`, { method: 'POST', body: req, cache: 'no-store' }));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        bytes = new Uint8Array(await wait(res.arrayBuffer()));
      } catch (err) {
        iosBinary = false;
        crashLog.event('rust-binary-failed', { error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (!bytes) {
      via = 'base64';
      const b64 = bytesToBase64(req);
      const res = await wait(window.webkit!.messageHandlers!.opennote!.postMessage({ cmd: 'rust', method, data: b64 }));
      if (res?.error) throw new Error(String(res.error));
      bytes = fromBase64(res?.data ?? '');
    }
  } else {
    const p = port();
    if (p) bytes = await wait(viaPort(p, method, req));
    else {
      if (!plugin) throw new Error('no Rust library');
      via = 'base64';
      const b64 = bytesToBase64(req);
      bytes = fromBase64((await wait(plugin.call({ method, data: b64 }))).data);
    }
  }
  if (bytes.length < 4) throw new Error('short reply');
  const n = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
  return { meta: JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + n))), data: bytes.subarray(4 + n), waitMs, via };
}

/** A stroke's points as x, y, pressure, t (NaN: none), from its packed array while it has one. */
function pointsOf(s: Stroke): { n: number; put: (out: Float64Array, at: number) => void } {
  // Still packed: `points` is the getter db.ts gives a stored stroke until it is read.
  const packed = Object.getOwnPropertyDescriptor(s, 'points')?.get ? packedPoints.get(s) : undefined;
  if (packed) {
    const n = Math.floor(packed.length / PACKED_STRIDE);
    return {
      n,
      put: (out, at) => {
        for (let i = 0; i < n; i++) {
          const o = i * PACKED_STRIDE, d = (at + i) * 4;
          out[d] = packed[o];
          out[d + 1] = packed[o + 1];
          out[d + 2] = packed[o + 2];
          out[d + 3] = packed[o + 3];
        }
      },
    };
  }
  const pts = s.points;
  return {
    n: pts.length,
    put: (out, at) => {
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i], d = (at + i) * 4;
        out[d] = p.x;
        out[d + 1] = p.y;
        out[d + 2] = p.pressure;
        out[d + 3] = p.t ?? NaN;
      }
    },
  };
}

export interface GeometryRun {
  strokes: number;
  points: number;
  /** The whole call as the page sees it: encoding, bridge, Rust, decoding. */
  ms: number;
  /** Its share on the page's main thread (packing, base64 both ways, the points' objects). */
  pageMs: number;
  /** Rust's own share. */
  rustMs: number;
  via: RustReply['via'];
  lines: InkGeometry[];
}

/** The drawn lines of `strokes` (pen and highlighter only) computed by Rust. */
export async function rustGeometry(strokes: Stroke[]): Promise<GeometryRun> {
  const t0 = performance.now();
  const parts = strokes.map(pointsOf);
  const total = parts.reduce((n, p) => n + p.n, 0);
  const vals = new Float64Array(total * 4);
  let at = 0;
  parts.forEach((p) => {
    p.put(vals, at);
    at += p.n;
  });
  const heads = strokes.map((s, i) => ({
    tool: s.tool, penStyle: s.penStyle ?? null, isShape: !!s.isShape, modeled: s.modeled ?? null, penEnd: !!s.penEnd, width: s.width, n: parts[i].n,
  }));
  const { meta, data, waitMs, via } = await rustCall('geometry', { strokes: heads }, new Uint8Array(vals.buffer));
  if (meta.error) throw new Error(String(meta.error));
  const out = new Float64Array(data.slice().buffer);
  const lines: InkGeometry[] = [];
  let o = 0;
  for (const m of meta.strokes as { n: number; widths: boolean; width: number }[]) {
    const pts = new Array(m.n);
    for (let i = 0; i < m.n; i++, o += 4) pts[i] = { x: out[o], y: out[o + 1], t: out[o + 2], p: out[o + 3] };
    let widths: number[] | null = null;
    if (m.widths) {
      widths = Array.from(out.subarray(o, o + m.n));
      o += m.n;
    }
    lines.push({ pts, widths, width: m.width });
  }
  if (lines.length !== strokes.length || o !== out.length) throw new Error('geometry reply does not fit the request');
  const ms = performance.now() - t0;
  return { strokes: strokes.length, points: total, ms, pageMs: ms - waitMs, rustMs: Number(meta.ms) || 0, via, lines };
}

const inFlight = new WeakMap<Stroke[], Promise<void>>();

/**
 * Has Rust compute the drawn line of every stroke of `strokes` strokeGeometry does not know yet,
 * and gives it the result. Resolves (never rejects) once done, or at once when Rust is off,
 * missing, or there is too little to gain; strokeGeometry computes whatever is left.
 */
export function prepareGeometry(strokes: Stroke[]): Promise<void> {
  if (!rustEnabled()) return Promise.resolve();
  let p = inFlight.get(strokes);
  if (p) return p;
  p = (async () => {
    if (await rustUnavailable()) return;
    const todo = strokes.filter((s) => (s.tool === 'pen' || s.tool === 'highlighter') && !hasStrokeGeometry(s) && pointsOf(s).n > 0);
    if (todo.reduce((n, s) => n + pointsOf(s).n, 0) < MIN_POINTS) return;
    try {
      const run = await rustGeometry(todo);
      todo.forEach((s, i) => {
        if (!hasStrokeGeometry(s)) setStrokeGeometry(s, run.lines[i]);
      });
      crashLog.event('rust-geometry', { strokes: run.strokes, points: run.points, ms: Math.round(run.ms), pageMs: Math.round(run.pageMs), rustMs: Math.round(run.rustMs), via: run.via });
    } catch (err) {
      crashLog.event('rust-failed', { method: 'geometry', error: err instanceof Error ? err.message : String(err) });
    }
  })();
  inFlight.set(strokes, p);
  return p;
}

export interface RustCheck {
  strokes: number;
  points: number;
  /** TypeScript computing the same lines, on the main thread. */
  tsMs: number;
  /** Rust as the page sees it (encoding, bridge, decoding), the page's main-thread share of it, and Rust's own time (off the main thread). */
  rustTotalMs: number;
  pageMs: number;
  rustMs: number;
  via: RustReply['via'];
  /** Largest difference between the two, in page px (positions and widths). */
  maxDiff: number;
  /** Lines differing by more than 1e-4 px. */
  differing: number;
  /** The stroke whose line differs most, when one differs. */
  worst?: { tool: string; penStyle?: string; isShape?: boolean; modeled?: string; penEnd?: boolean; points: number; diff: number | 'length'; width: number; pts?: number[][] };
}

/** Rust against TypeScript on `strokes`: the same lines (to 1e-4 px), and how long each takes. */
export async function rustCheck(strokes: Stroke[]): Promise<RustCheck> {
  const why = await rustUnavailable();
  if (why) throw new Error(`Rust library unavailable: ${why}`);
  const ink = strokes.filter((s) => (s.tool === 'pen' || s.tool === 'highlighter') && s.points.length);
  const t0 = performance.now();
  const ts = ink.map(computeStrokeGeometry);
  const tsMs = performance.now() - t0;
  const run = await rustGeometry(ink);
  let maxDiff = 0, differing = 0, worstAt = -1;
  ts.forEach((a, i) => {
    const b = run.lines[i];
    let d = a.pts.length === b.pts.length ? Math.abs(a.width - b.width) : Infinity;
    for (let k = 0; k < a.pts.length && d < Infinity; k++) {
      d = Math.max(d, Math.abs(a.pts[k].x - b.pts[k].x), Math.abs(a.pts[k].y - b.pts[k].y));
      if (a.widths || b.widths) d = !a.widths || !b.widths ? Infinity : Math.max(d, Math.abs(a.widths[k] - b.widths[k]));
    }
    if (d > 1e-4) differing++;
    if (d > 1e-4 && d >= maxDiff) worstAt = i;
    maxDiff = Math.max(maxDiff, d);
  });
  const w = ink[worstAt];
  const worst = w && {
    tool: w.tool, penStyle: w.penStyle, isShape: w.isShape, modeled: w.modeled, penEnd: w.penEnd, points: w.points.length,
    diff: Number.isFinite(maxDiff) ? Number(maxDiff.toExponential(2)) : ('length' as const), width: w.width,
    // Short enough to reproduce on the PC from the report.
    pts: w.points.length <= 200 ? w.points.map((p) => [p.x, p.y, p.pressure, p.t ?? NaN]) : undefined,
  };
  const result: RustCheck = { strokes: ink.length, points: run.points, tsMs, rustTotalMs: run.ms, pageMs: run.pageMs, rustMs: run.rustMs, via: run.via, maxDiff, differing, worst };
  crashLog.event('rust-check', {
    strokes: result.strokes, points: result.points, tsMs: Math.round(tsMs), rustTotalMs: Math.round(run.ms), pageMs: Math.round(run.pageMs), rustMs: Math.round(run.rustMs), via: run.via,
    maxDiff: Number.isFinite(maxDiff) ? Number(maxDiff.toExponential(2)) : 'length', differing, worst,
  });
  return result;
}

// For npm run bench:ui -- --only rustcore (as frameProbe's window.__opennoteFrameProbe).
(window as unknown as { __opennoteRust?: unknown }).__opennoteRust = { check: () => rustCheckLargestNote() };

/** rustCheck on the library's largest note (the most points), for Settings > Diagnostics. */
export async function rustCheckLargestNote(): Promise<RustCheck & { title: string }> {
  const { getAllNotes } = await import('../storage/db');
  const size = (s: Stroke) => {
    const packed = Object.getOwnPropertyDescriptor(s, 'points')?.get ? packedPoints.get(s) : undefined;
    return packed ? packed.length / PACKED_STRIDE : s.points.length;
  };
  let best: { title: string; strokes: Stroke[]; n: number } | null = null;
  for (const note of await getAllNotes()) {
    const strokes = (note.pages ?? []).flatMap((p) => p.strokes ?? []);
    const n = strokes.reduce((a, s) => a + size(s), 0);
    if (!best || n > best.n) best = { title: note.title, strokes, n };
  }
  if (!best || !best.n) throw new Error('No note with ink to check');
  return { ...(await rustCheck(best.strokes)), title: best.title };
}

export interface CanvasPlacement {
  page: string;
  tf: [number, number, number, number, number, number];
  paper?: {
    width: number;
    height: number;
    style: number;
    base: [number, number, number, number];
    dark?: boolean;
    pattern?: [number, number, number] | null;
    origin?: [number, number];
  } | null;
}

export interface CanvasFrameReq {
  clear?: [number, number, number, number];
  pages?: CanvasPlacement[];
  /**
   * A long note's sheets, compact (crates/canvas FrameSpec::parse, ADR-007): the note's distinct
   * papers, each sheet's id, box (surface px: left, top, width, height) and paper; `ink` names the
   * surface whose sheets' scenes (`ink:sheetId`) are drawn over them.
   */
  papers?: { style: number; base: [number, number, number, number]; dark?: boolean; pattern?: [number, number, number] | null }[];
  sheets?: { id: string; b: [number, number, number, number]; p: number }[];
  ink?: string;
  /** The surface alone moved: the last frame otherwise. */
  keep?: boolean;
  /**
   * Where the page's surface was when it placed the pages (device px: scale, x, y). While Rust owns
   * the camera the canvas moves the frame from there to the camera's (crates/native viewport_service).
   */
  surface?: [number, number, number];
}

/** A key per stroke object for the native canvas: a changed stroke is a new object, so a new key. */
const sceneKeys = new WeakMap<Stroke, number>();
let nextSceneKey = 1;
const sceneKey = (s: Stroke) => {
  let k = sceneKeys.get(s);
  if (k === undefined) sceneKeys.set(s, (k = nextSceneKey++));
  return k;
};
/** The keys the canvas holds for each page: those of the page's last scene (crates/native SCENE_OPS). */
const canvasHolds = new Map<string, Set<number>>();

/**
 * Updates a page's stroke scene in the native Rust CanvasHost. Only strokes the canvas does not
 * hold yet go with their style (JSON, without the points) and points (raw f64 x, y, pressure, t,
 * read from the stored packed arrays); the others by their key alone, and Rust reuses their
 * geometry. rs.22-25 sent and rebuilt the whole note at every lift: 140-200 ms on the iPad for a
 * 6,000-stroke note, the new stroke missing from the screen meanwhile. No strokes: the page's
 * scene goes (the note closed). Logged as `canvas-scene` (crash report).
 */
export function rustSetCanvasScene(pageId: string, strokes: readonly Stroke[], keep = false): Promise<boolean> {
  // One after the other, in the page's order: what the canvas holds is then known when each is
  // made, and an older scene never lands after a newer one.
  const run = sceneTail.then(() => setCanvasScene(pageId, strokes, keep));
  sceneTail = run.catch(() => undefined);
  return run;
}
let sceneTail: Promise<unknown> = Promise.resolve();

/**
 * Scenes the canvas let go for memory (rust/DECISIONS.md ADR-007): its reply to a scene names them,
 * and the page sends them again when they come near (CanvasPage's stream).
 */
let droppedListener: ((ids: string[]) => void) | null = null;
export function onCanvasDropped(fn: ((ids: string[]) => void) | null): void {
  droppedListener = fn;
}
/** Pages near the view the canvas does not have (the camera's `missing`, in view first). */
let missingListener: ((ids: string[]) => void) | null = null;
export function onCanvasMissing(fn: ((ids: string[]) => void) | null): void {
  missingListener = fn;
}

/** The canvas forgets scenes: `ids`, or all of a note's sheets (`prefix`, its surface's id). */
export function rustForgetCanvasScenes(what: { prefix?: string; ids?: string[] }): Promise<void> {
  const run = sceneTail.then(async () => {
    if (what.prefix) for (const k of [...canvasHolds.keys()]) if (k.startsWith(`${what.prefix}:`)) canvasHolds.delete(k);
    for (const id of what.ids ?? []) canvasHolds.delete(id);
    await rustCall('canvasForget', what).catch(() => undefined);
  });
  sceneTail = run.catch(() => undefined);
  return run;
}

async function setCanvasScene(pageId: string, strokes: readonly Stroke[], keep: boolean): Promise<boolean> {
  // The native canvas is its own switch (Settings > Diagnostics), not "Rust ink preparation".
  const t0 = performance.now();
  let total = 0;
  const send = async (held: ReadonlySet<number>) => {
    const keys = strokes.map(sceneKey);
    const fresh = strokes.filter((_, i) => !held.has(keys[i]));
    const parts = fresh.map(pointsOf);
    total = parts.reduce((n, p) => n + p.n, 0);
    const vals = new Float64Array(total * 4);
    let at = 0;
    parts.forEach((p) => {
      p.put(vals, at);
      at += p.n;
    });
    let f = 0;
    const heads = strokes.map((st, i) => {
      if (held.has(keys[i])) return { k: keys[i] };
      const head: Record<string, unknown> = {};
      // Every field but the points (a packed stroke's `points` is a getter: not touched here).
      for (const k of Object.keys(st)) if (k !== 'points') head[k] = (st as unknown as Record<string, unknown>)[k];
      return { k: keys[i], n: parts[f++].n, s: head };
    });
    const { meta } = await rustCall('canvasSceneBin', { page: pageId, strokes: heads, ...(keep ? { keep: true } : {}) }, new Uint8Array(vals.buffer));
    if (!meta.missing) {
      if (strokes.length) canvasHolds.set(pageId, new Set(keys));
      else canvasHolds.delete(pageId);
    }
    const dropped = Array.isArray(meta.dropped) ? (meta.dropped as string[]) : [];
    if (dropped.length) {
      for (const id of dropped) canvasHolds.delete(id);
      droppedListener?.(dropped);
    }
    return meta;
  };
  try {
    let meta = await send(canvasHolds.get(pageId) ?? new Set());
    // The canvas lost strokes the page thought it held (an earlier call failed): all of them again.
    if (meta.missing) meta = await send(new Set());
    crashLog.event('canvas-scene', { strokes: strokes.length, sent: meta.built ?? null, points: total, capsules: meta.capsules ?? null, attached: meta.attached ?? null, error: meta.error ?? null, ms: Math.round(performance.now() - t0) });
    return Boolean(meta.ok);
  } catch (err) {
    canvasHolds.delete(pageId);
    crashLog.event('canvas-scene', { strokes: strokes.length, points: total, error: err instanceof Error ? err.message : String(err), ms: Math.round(performance.now() - t0) });
    return false;
  }
}

/** Updates the frame specification (clear color, page placements, paper) in the native Rust CanvasHost. */
export async function rustSetCanvasFrame(frame: CanvasFrameReq): Promise<boolean> {
  // The native canvas is its own switch (Settings > Diagnostics), not "Rust ink preparation".
  try {
    const { meta } = await rustCall('canvasFrame', frame);
    return Boolean(meta.ok);
  } catch {
    return false;
  }
}

/** Fetches native CanvasHost render statistics. */
export async function rustGetCanvasStats(): Promise<Record<string, unknown> | null> {
  try {
    const { meta } = await rustCall('canvasStats', {});
    return meta;
  } catch {
    return null;
  }
}

/**
 * Whether the native canvas draws this note (the one decision App, Editor and CanvasPage share:
 * the desk and pages are see-through exactly when the canvas draws what is under them). Not for
 * notes with PDF pages or pictures: those, in the web view, would cover the native ink (N4).
 * Made separately, a note with a picture got a see-through desk over a canvas nobody drew: black.
 */
export function nativeCanvasFor(note?: Pick<NoteDocument, 'sheets' | 'pages'> | null): boolean {
  if (!note || !hasNativeCanvas() || canvasFallback) return false;
  const sheets = note.sheets ?? [];
  const pages = note.pages ?? [];
  return !sheets.some((s) => s?.pdf) && !pages.some((p) => (p?.imageBlocks ?? []).length > 0);
}

/**
 * Never a black page: when the canvas is not actually drawing (no host, nothing presented after
 * the page's first frame, frames failing or errors growing, the bridge silent), the page takes its
 * drawing back for the rest of the run: `nativeCanvasFor` is false from then on, so the page draws
 * its ink and paper, the desk is opaque again over the canvas, and the camera is the page's own
 * (useViewport hands it back to the page). Logged as `canvas-fallback` with the canvas's status.
 * The 2.9.5 rule (a crashed run starts the next on GLES) can therefore never leave a black page
 * either: a GLES that draws nothing ends here too. CanvasPage checks `canvasStats` once a second.
 */
let canvasFallback: string | null = null;
export const CANVAS_FALLBACK = 'opennote:canvasFallback';
export function canvasFellBack(): string | null {
  return canvasFallback;
}
export function fallBackFromNativeCanvas(why: string, status: unknown): void {
  if (canvasFallback) return;
  canvasFallback = why;
  crashLog.event('canvas-fallback', { why, status });
  window.dispatchEvent(new Event(CANVAS_FALLBACK));
}

/** Re-renders its component when the page takes its drawing back from the canvas. */
export function useCanvasFallback(): string | null {
  const [why, setWhy] = useState(canvasFallback);
  useEffect(() => {
    const on = () => setWhy(canvasFallback);
    window.addEventListener(CANVAS_FALLBACK, on);
    return () => window.removeEventListener(CANVAS_FALLBACK, on);
  }, []);
  return why;
}

/**
 * Whether the canvas is drawing, from successive `canvasStats` (CanvasPage): why not, else null.
 * `since` is when the page sent its first frame and scene (ms, performance.now()).
 */
export function canvasHealth(prev: Record<string, unknown> | null, st: Record<string, unknown> | null, since: number, now: number): string | null {
  if (!st) return 'the bridge does not answer';
  const n = (k: string, o: Record<string, unknown> | null = st) => (typeof o?.[k] === 'number' ? (o[k] as number) : 0);
  const waited = now - since;
  if (!st.attached && waited > 1500) return `no canvas host (${String(st.firstError ?? st.error ?? 'none')})`;
  if (n('frames') === 0 && st.attached && waited > 3000) return 'nothing presented';
  if (prev) {
    const failed = n('failedFrames') - n('failedFrames', prev);
    const errors = n('errors') - n('errors', prev);
    const frames = n('frames') - n('frames', prev);
    const lost = n('lost') - n('lost', prev);
    if (lost > 0 && !st.attached) return 'device lost';
    if (failed >= 3 && failed >= frames) return `${failed} frames failed`;
    if (errors >= 3 && frames === 0) return `${errors} errors, no frame`;
  }
  return null;
}

/** The theme's desk colour (index.css --ui-desk: "r g b"), 0..1, for the native canvas. */
export function deskRgba(): [number, number, number, number] {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--ui-desk').trim().split(/\s+/).map(Number);
  return v.length === 3 && v.every((x) => Number.isFinite(x)) ? [v[0] / 255, v[1] / 255, v[2] / 255, 1] : [0.9, 0.9, 0.92, 1];
}

/**
 * Settings > Diagnostics: the native canvas (docs/rust-native-canvas.md N2) from the next start.
 * The shells keep the choice (iOS NSUserDefaults, Android SharedPreferences).
 */
export async function setNativeCanvas(on: boolean): Promise<void> {
  if (platformKind() === 'ios') {
    await window.webkit!.messageHandlers!.opennote!.postMessage({ cmd: 'setNativeCanvas', on });
  } else if (platformKind() === 'capacitor' && Capacitor.getPlatform() === 'android') {
    await registerPlugin<{ setNativeCanvas(o: { on: boolean }): Promise<void> }>('OpenNoteRust').setNativeCanvas({ on });
  }
}

// ------------------------------------------------------------------------------------------------
// The Rust camera (rust/DECISIONS.md ADR-006, docs/rust-native-canvas.md N5): while the native canvas
// draws a note, two fingers move crates/viewport (a port of useViewport.ts's gestures) at the
// display's rate; the page sends its layout and its own views, and mirrors the camera.

/** The camera as crates/viewport publishes it (`Camera`). */
export interface RustCamera {
  seq: number;
  /** The committed zoom and scroll positions (the page's zoom state, scrollLeft, scrollTop). */
  zoom: number;
  sl: number;
  st: number;
  /** The content's corner on screen (scroll view px) and its scale, every transform included. */
  x: number;
  y: number;
  ez: number;
  fit: 'width' | 'page' | null;
  /** useViewport's onPull distance, and how many pulls added a page. */
  pull: number;
  pulls: number;
  /** applyAnchor placements so far (CONTENT_PLACED). */
  placed: number;
  gesture: boolean;
  moving: boolean;
  /** The last change was the page's own scroll: its DOM has it. */
  byPage: boolean;
}

/** One gesture's frames, from the render thread (crates/viewport GestureSummary). */
export interface RustGesture {
  id: number;
  ms: number;
  frames: number;
  drawn: number;
  fps: number;
  hz: number;
  p50: number;
  p95: number;
  max: number;
  slow: number;
  events: number;
  rebases: number;
  z0: number;
  z: number;
  glide: boolean;
}

export interface RustCameraReply {
  owned: boolean;
  camera: RustCamera;
  view: { zoom: number; cx: number; cy: number; fit: 'width' | 'page' | null };
  page: number;
  fingers: number;
  log: RustGesture[];
  /** Pages near the view the canvas does not have (in view first): the page sends them (ADR-007). */
  missing?: string[];
}

/** The layout the camera needs (crates/viewport `Layout`). */
export interface RustViewportLayout {
  view: [number, number, number, number];
  content: [number, number];
  surface: [number, number];
  sheets: [number, number, number, number][];
  pull: boolean;
  single: boolean;
  holes: [number, number, number, number][];
  dpr: number;
  frameMs: number;
  owned: boolean;
  /** window.visualViewport: offsetLeft, offsetTop, scale (the shells' points are the web view's). */
  vv: [number, number, number];
  /** The bench's "before" (`--only cameracoherence`): 2.9.6's camera. */
  legacy?: boolean;
}

export type RustViewportOp =
  | { op: 'fitWidth'; target?: [number, number] | null }
  | { op: 'zoomToRect'; rect: [number, number, number, number] }
  | { op: 'restore'; view: { zoom: number; cx: number; cy: number; fit: 'width' | 'page' | null }; target?: [number, number] | null }
  | { op: 'zoomBy'; f: number }
  | { op: 'zoomAt'; f: number; sx: number; sy: number }
  | { op: 'scroll'; sl: number; st: number; dsl: number; dst: number }
  | { op: 'scrollTo'; y: number; smooth: boolean }
  | { op: 'pull'; d: number; animate: boolean }
  | { op: 'stop' };

/** Whether Rust owns this note's camera: the native canvas draws it and the shell runs the camera. */
export function nativeViewportFor(note?: Pick<NoteDocument, 'sheets' | 'pages'> | null): boolean {
  return nativeCanvasFor(note) && hasNativeViewport();
}

/**
 * The newest camera the page has: pushed by the shell after the canvas drew it (iOS
 * evaluateJavaScript, Android evaluateJavascript, at most once per page frame), or the reply to a
 * bridge call. Each gesture's record (the render thread's frame intervals) goes to the crash report
 * as a `pinch` entry, as useViewport logs its own pinches (`gl: 'rust'`).
 */
export const cameraFeed: { latest: RustCameraReply | null; pushedAt: number; pushes: number } = { latest: null, pushedAt: -Infinity, pushes: 0 };
let gestureLogger: ((g: RustGesture) => void) | null = null;
/** Who logs the gestures (useViewport, with the page's frame rate and power state). */
export function onRustGesture(fn: ((g: RustGesture) => void) | null): void {
  gestureLogger = fn;
}
function takeCamera(r: RustCameraReply | null | undefined): RustCameraReply | null {
  if (!r || !r.camera) return null;
  for (const g of r.log ?? []) gestureLogger?.(g);
  if (r.missing?.length) missingListener?.(r.missing);
  if (!cameraFeed.latest || r.camera.seq >= cameraFeed.latest.camera.seq || !r.owned) cameraFeed.latest = r;
  return r;
}
if (typeof window !== 'undefined') {
  (window as unknown as { __opennoteCamera?: (r: RustCameraReply) => void }).__opennoteCamera = (r) => {
    cameraFeed.pushedAt = performance.now();
    cameraFeed.pushes++;
    takeCamera(r);
  };
}

/** The shell pushes the camera (else the page asks for it each frame: the PC's stand-in shell). */
export function shellPushesCamera(): boolean {
  return cameraFeed.pushes > 0;
}

async function viewportCall(method: string, meta: unknown): Promise<RustCameraReply | null> {
  try {
    const { meta: m } = await rustCall(method, meta);
    if (m.error) throw new Error(String(m.error));
    return takeCamera(m as unknown as RustCameraReply);
  } catch (err) {
    crashLog.event('viewport-failed', { method, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** The page's layout (and, as Rust takes the camera over, the page's camera as it is). */
export function rustViewportLayout(layout: RustViewportLayout, adopt?: { zoom: number; sl: number; st: number; sub: [number, number]; fit: 'width' | 'page' | null }): Promise<RustCameraReply | null> {
  return viewportCall('viewportLayout', { layout, adopt: adopt ?? null });
}

/** A camera change the page makes (fit to width, a saved view, a page, the keyboard, its own scroll). */
export function rustViewportSet(op: RustViewportOp): Promise<RustCameraReply | null> {
  return viewportCall('viewportSet', op);
}

/** The camera now (and the gestures recorded since the last read). */
/** The camera the page just put on its DOM (its seq): the canvas draws that one (ADR-008). */
export function rustViewportShown(seq: number): void {
  void rustCall('viewportShown', { seq }).catch(() => undefined);
}

export function rustViewportCamera(): Promise<RustCameraReply | null> {
  return viewportCall('viewportCamera', {});
}
