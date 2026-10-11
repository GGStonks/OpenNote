import { platformKind } from './platform';
import { PenStyle, EraserMode } from './types';

export interface AppSettings {
  /** Server base URL or full chat-completions URL; normalised by resolveChatUrl(). */
  vlmEndpoint: string;
  modelName: string;
  apiKey: string;
  /** Request timeout. A cold Qwen3-VL start through the switchboard can take ~30-60 s. */
  vlmTimeoutSec: number;
  stylusOnly: boolean;
  penStyle: PenStyle;
  eraserMode: EraserMode;
  /** Draw-and-hold shape snapping (Notability behaviour). */
  holdToSnap: boolean;
  /** Apple Pencil double-tap toggles pen/eraser. */
  pencilDoubleTapEraser: boolean;
}

const KEY = 'opennote_settings_v2';

function defaultEndpoint(): string {
  // In the Vite dev server the /v1 path is proxied to 127.0.0.1:9191.
  if (platformKind() === 'web' && location.port === '5173') return '/v1/chat/completions';
  return 'http://100.77.212.97:9191';
}

export function defaultSettings(): AppSettings {
  return {
    vlmEndpoint: defaultEndpoint(),
    modelName: 'qwen3-vl',
    apiKey: 'sk-dummy',
    vlmTimeoutSec: 180,
    stylusOnly: true,
    penStyle: 'fountain',
    eraserMode: 'stroke',
    holdToSnap: true,
    pencilDoubleTapEraser: true,
  };
}

export function loadSettings(): AppSettings {
  const defaults = defaultSettings();
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...defaults, ...JSON.parse(raw) };
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
    if (platformKind() !== 'web') e = 'http://100.77.212.97:9191' + e;
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
