import { httpRequest } from '../platform';
import { AppSettings, resolveChatUrl } from '../settings';

/**
 * Pen recording (Settings > Diagnostics): keeps the raw input of the last strokes — every sample
 * exactly as it reached the ink engine, plus when it arrived — so the engine can be measured and
 * tuned on real handwriting (`npm run bench:pen -- <recording.json>`). Off by default; recordings
 * stay in memory until shared, sent to the PC or cleared.
 */

/** One sample: page x, y (px), t (ms from the stroke's first sample), force 0..1 (0 = lifting),
 *  arrival (ms on the same clock as t: when the app received it), altitude, azimuth (rad). */
export type RecordedSample = [number, number, number, number, number, number, number];

export interface RecordedStroke {
  tool: string;
  penStyle?: string;
  width: number;
  /** 'native' = the iOS shell's 240 Hz samples, 'web' = pointer events. */
  source: 'native' | 'web';
  pointerType: string;
  zoom: number;
  recordedAt: number;
  samples: RecordedSample[];
  /** When the live ink was repainted (ms on the stroke's clock): the real display rate. */
  frames?: number[];
}

export interface PenRecording {
  format: 'opennote-pen-recording';
  version: 1;
  app: string;
  platform: string;
  userAgent: string;
  devicePixelRatio: number;
  /** iOS shell: WebKit's 60 fps cap for page rendering was switched off. */
  fullFrameRate?: boolean;
  screen: { width: number; height: number };
  exportedAt: number;
  strokes: RecordedStroke[];
}

const KEY = 'opennote_pen_recording';
const MAX_STROKES = 400;
const strokes: RecordedStroke[] = [];
const listeners = new Set<() => void>();
let enabled = (() => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
})();

const notify = () => listeners.forEach((fn) => fn());

export const penRecorder = {
  get enabled(): boolean {
    return enabled;
  },
  setEnabled(on: boolean) {
    enabled = on;
    try {
      localStorage.setItem(KEY, on ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
    notify();
  },
  get count(): number {
    return strokes.length;
  },
  add(s: RecordedStroke) {
    if (!enabled || s.samples.length === 0) return;
    strokes.push(s);
    if (strokes.length > MAX_STROKES) strokes.shift();
    notify();
  },
  clear() {
    strokes.length = 0;
    notify();
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  snapshot(platform: string): PenRecording {
    return {
      format: 'opennote-pen-recording',
      version: 1,
      app: window.OpenNoteNative?.version ?? 'web',
      platform,
      userAgent: navigator.userAgent,
      devicePixelRatio: window.devicePixelRatio,
      fullFrameRate: (window.OpenNoteNative as { fullFrameRate?: boolean } | undefined)?.fullFrameRate,
      screen: { width: screen.width, height: screen.height },
      exportedAt: Date.now(),
      strokes: strokes.slice(),
    };
  },
  /** Uploads the recording to the switchboard on the PC (POST <server>/opennote/pen-recordings). */
  async sendToPc(settings: AppSettings, platform: string): Promise<string> {
    const url = resolveChatUrl(settings.vlmEndpoint).replace(/\/v1\/chat\/completions$/, '') + '/opennote/pen-recordings';
    const res = await httpRequest({ url, method: 'POST', body: this.snapshot(platform), timeoutMs: 30000 });
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status} from ${url}: ${res.text.slice(0, 200)}`);
    return typeof res.data === 'object' && res.data?.saved ? String(res.data.saved) : 'sent';
  },
};
