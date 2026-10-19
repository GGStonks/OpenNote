import { httpRequest } from '../platform';
import { AppSettings, resolveChatUrl } from '../settings';
import { authError, serverHeaders } from './serverAuth';

/**
 * Crash report (Settings > Diagnostics). The iPad can end the app's web view without a word: WebKit
 * kills its content process when memory runs out (the shell then reloads the page), or its GPU
 * process (every canvas goes black). None of that can be seen from the PC, so the app keeps a short
 * log of what it was doing, written to localStorage as it goes: a snapshot every few seconds (zoom,
 * canvases and their memory, LaTeX blocks) and notable events (zooms, conversions, resizes). A
 * session that ended moments before the next one started, or with its canvases lost, is kept as
 * the last crash, to be shared or sent to the PC.
 *
 * Lost canvases (GPU process gone) also reload the page, at most once a minute: better than a
 * black screen.
 */

const KEY = 'opennote_crashlog_v1';
const MAX_CRUMBS = 150;
const SNAPSHOT_MS = 3000;
/** A session that ended this soon before the next started did not end normally. */
const RESTART_WINDOW_MS = 60_000;

export interface Crumb {
  t: number;
  kind: string;
  [k: string]: unknown;
}

interface Session {
  id: string;
  start: number;
  lastAt: number;
  app: string;
  userAgent: string;
  dpr: number;
  lost?: boolean;
  crumbs: Crumb[];
}

interface Stored {
  current?: Session;
  /** The last session that ended abnormally. */
  crash?: Session & { detectedAt: number; reason: string };
  /** The session before the current one (also kept when it looked normal). */
  previous?: Session;
  lastAutoReload?: number;
}

let store: Stored = {};
let session: Session | null = null;
const state: Record<string, unknown> = {};
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function load(): Stored {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}') as Stored;
  } catch {
    return {};
  }
}

function save() {
  if (!session) return;
  session.lastAt = Date.now();
  store.current = session;
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* storage full or unavailable */
  }
}

function canvasStats() {
  const cs = document.querySelectorAll('canvas');
  let px = 0, n = 0, lost = 0;
  cs.forEach((c) => {
    if (c.width * c.height <= 1) return;
    n++;
    px += c.width * c.height;
    const ctx = c.getContext('2d') as (CanvasRenderingContext2D & { isContextLost?: () => boolean }) | null;
    if (ctx?.isContextLost?.()) lost++;
  });
  return { canvases: n, canvasMB: Math.round((px * 4) / 1048576), lost };
}

function snapshot() {
  if (!session || document.visibilityState === 'hidden') return;
  const c = canvasStats();
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  push({ kind: 'snap', ...state, ...c, latex: document.querySelectorAll('.on-math, .on-tikz').length, ...(mem ? { heapMB: Math.round(mem.usedJSHeapSize / 1048576) } : {}) });
  if (c.lost) canvasesLost('isContextLost');
}

function push(c: Omit<Crumb, 't'>) {
  if (!session) return;
  session.crumbs.push({ t: Date.now(), ...c } as Crumb);
  if (session.crumbs.length > MAX_CRUMBS) session.crumbs.splice(0, session.crumbs.length - MAX_CRUMBS);
  save();
}

function canvasesLost(how: string) {
  if (!session || session.lost) return;
  session.lost = true;
  push({ kind: 'canvas-lost', how, ...state });
  const now = Date.now();
  if (!store.lastAutoReload || now - store.lastAutoReload > 60_000) {
    store.lastAutoReload = now;
    save();
    setTimeout(() => location.reload(), 300);
  }
}

export const crashLog = {
  /** Starts this session's log; a previous session that ended abnormally becomes the last crash. */
  start() {
    if (session) return;
    store = load();
    const prev = store.current;
    const now = Date.now();
    if (prev) {
      store.previous = prev;
      const quick = now - prev.lastAt < RESTART_WINDOW_MS;
      if (prev.lost || quick) store.crash = { ...prev, detectedAt: now, reason: prev.lost ? 'canvases lost (GPU process)' : 'the app restarted moments after (web view ended)' };
    }
    session = { id: Math.random().toString(36).slice(2, 10), start: now, lastAt: now, app: __APP_VERSION__, userAgent: navigator.userAgent, dpr: window.devicePixelRatio, crumbs: [] };
    push({ kind: 'start' });
    timer = setInterval(snapshot, SNAPSHOT_MS);
    document.addEventListener('contextlost', () => canvasesLost('contextlost event'), true);
    window.addEventListener('error', (e) => push({ kind: 'js-error', message: String(e.message).slice(0, 400), at: `${e.filename ?? ''}:${e.lineno ?? ''}:${e.colno ?? ''}`, stack: String((e.error as Error | undefined)?.stack ?? '').slice(0, 1500) }));
    window.addEventListener('unhandledrejection', (e) => push({ kind: 'js-rejection', message: String((e.reason as Error | undefined)?.message ?? e.reason).slice(0, 400), stack: String((e.reason as Error | undefined)?.stack ?? '').slice(0, 1500) }));
    document.addEventListener('visibilitychange', () => push({ kind: document.visibilityState }));
    listeners.forEach((l) => l());
  },
  /** A value shown in every later snapshot (zoom, open note, ...). */
  set(key: string, value: unknown) {
    state[key] = value;
  },
  event(kind: string, data: Record<string, unknown> = {}) {
    push({ kind, ...data });
  },
  /** The app hit an error it recovered from: this session is the crash report right away. */
  fail(reason: string, data: Record<string, unknown> = {}) {
    push({ kind: 'error', reason, ...data });
    if (session) store.crash = { ...session, crumbs: session.crumbs.slice(), detectedAt: Date.now(), reason };
    save();
    listeners.forEach((l) => l());
  },
  get lastCrash() {
    return store.crash ?? null;
  },
  report() {
    return { format: 'opennote-crash-report', version: 1, crash: store.crash ?? null, previous: store.previous ?? null, current: session };
  },
  clear() {
    delete store.crash;
    save();
    listeners.forEach((l) => l());
  },
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
  /** Uploads the report to the PC (POST <server>/opennote/diagnostics). */
  async sendToPc(settings: AppSettings): Promise<string> {
    const url = resolveChatUrl(settings.vlmEndpoint).replace(/\/v1\/chat\/completions$/, '') + '/opennote/diagnostics';
    const res = await httpRequest({ url, method: 'POST', body: this.report(), timeoutMs: 30000, headers: serverHeaders(settings) });
    const refused = authError(res);
    if (refused) throw new Error(refused);
    if (res.status === 404) throw new Error('This server address does not accept reports. Use “Share file” instead.');
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status} from ${url}: ${res.text.slice(0, 200)}`);
    return typeof res.data === 'object' && res.data?.saved ? String(res.data.saved) : 'sent';
  },
};

void timer;
