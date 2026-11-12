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
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Stroke } from '../types';
import { bytesToBase64, fromBase64, platformKind } from '../platform';
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
