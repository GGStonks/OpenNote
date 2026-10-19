import { platformKind } from './platform';
import { PenStyle, EraserMode } from './types';
import { UiTheme } from './theme';

export interface AppSettings {
  /** Server base URL or full chat-completions URL; normalised by resolveChatUrl(). */
  vlmEndpoint: string;
  modelName: string;
  /** This device's key for the conversion server, issued by its owner (services/serverAuth.ts). */
  apiKey: string;
  /** Name of this device as the server's owner sees it; empty = autoDeviceName(). */
  deviceName: string;
  /** Request timeout. A cold Qwen3-VL start through the switchboard can take ~30-60 s. */
  vlmTimeoutSec: number;
  stylusOnly: boolean;
  penStyle: PenStyle;
  eraserMode: EraserMode;
  /** Draw-and-hold shape snapping (Notability behaviour). */
  holdToSnap: boolean;
  /** Apple Pencil double-tap toggles pen/eraser. */
  pencilDoubleTapEraser: boolean;
  /** Notability gestures: two-finger tap undoes, three-finger tap redoes. */
  fingerTapUndo: boolean;
  /** Theme of the interface (never of the note pages, see theme.ts). */
  theme: UiTheme;
  /** At start, look for a newer release on GitHub and offer to update (services/updater.ts). */
  checkUpdates: boolean;
}

const KEY = 'opennote_settings_v2';

/** The conversion server, reachable from any device with internet access. */
export const DEFAULT_SERVER = 'https://darksoul.tailf66262.ts.net:10000';
/** The default before v2.2.1 (Tailscale only): moved to DEFAULT_SERVER unless it was changed. */
const OLD_DEFAULT_SERVER = 'http://100.77.212.97:9191';

function defaultEndpoint(): string {
  // In the Vite dev server the /v1 path is proxied to 127.0.0.1:9191.
  if (platformKind() === 'web' && location.port === '5173') return '/v1/chat/completions';
  return DEFAULT_SERVER;
}

export function defaultSettings(): AppSettings {
  return {
    vlmEndpoint: defaultEndpoint(),
    modelName: 'qwen3-vl',
    apiKey: '',
    deviceName: '',
    vlmTimeoutSec: 180,
    stylusOnly: true,
    penStyle: 'fountain',
    eraserMode: 'stroke',
    holdToSnap: true,
    pencilDoubleTapEraser: true,
    fingerTapUndo: true,
    theme: 'light',
    checkUpdates: true,
  };
}

export function loadSettings(): AppSettings {
  const defaults = defaultSettings();
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s: AppSettings = { ...defaults, ...JSON.parse(raw) };
      // The old placeholder key; the server now issues real ones.
      if (s.apiKey === 'sk-dummy') s.apiKey = '';
      if (s.vlmEndpoint.trim().replace(/\/+$/, '') === OLD_DEFAULT_SERVER) s.vlmEndpoint = DEFAULT_SERVER;
      return s;
    }
    // Migrate the single v1.0 setting.
    const stylus = localStorage.getItem('opennote_stylus_only');
    if (stylus !== null) defaults.stylusOnly = stylus === 'true';
  } catch {
    /* storage unavailable */
  }
  return defaults;
}

export function saveSettings(s: AppSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}

/**
 * Accepts "host:port", "http://host:port", ".../v1", or a full ".../v1/chat/completions" URL
 * and returns the chat-completions URL. Relative URLs only work in the dev server (proxy).
 */
export function resolveChatUrl(endpoint: string): string {
  let e = endpoint.trim();
  if (!e) e = defaultEndpoint();
  if (e.startsWith('/')) {
    if (platformKind() !== 'web') e = DEFAULT_SERVER + e;
    else return e.includes('/chat/completions') ? e : e.replace(/\/+$/, '') + '/v1/chat/completions';
  }
  if (!/^https?:\/\//i.test(e)) e = 'http://' + e;
  e = e.replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(e)) return e;
  if (/\/v1$/.test(e)) return e + '/chat/completions';
  return e + '/v1/chat/completions';
}

export function resolveModelsUrl(endpoint: string): string {
  return resolveChatUrl(endpoint).replace(/\/chat\/completions$/, '/models');
}
