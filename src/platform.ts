import { Capacitor, CapacitorHttp } from '@capacitor/core';

/**
 * Platform bridge.
 *
 * - Android (and iOS when built with Xcode + Capacitor): CapacitorHttp for native HTTP,
 *   Filesystem + Share for exports, OpenNotePrint (Android) for PDF.
 * - iOS IPA built on Linux: OpenNote's native WKWebView shell (ios-native/), which exposes a
 *   `window.webkit.messageHandlers.opennote` reply handler for HTTP and sharing.
 * - Browser / dev server: fetch + anchor downloads.
 *
 * Native HTTP matters for the VLM: the app is served from https://localhost (Android),
 * capacitor://localhost or opennote://app (iOS), and a plain-http LAN/Tailscale endpoint from that origin is blocked as
 * mixed content / by CORS inside the WebView. Going through the native networking stack avoids both.
 */

interface IosBridge {
  postMessage(msg: unknown): Promise<any>;
}

declare global {
  interface Window {
    OpenNoteNative?: {
      platform: 'ios';
      version: string;
      /** WebKit's "near 60 fps" page rendering is lifted in this run (page120 was set at start-up). */
      fullFrameRate?: boolean;
      /** The setting for that (Settings > Diagnostics, setPage120): it applies at the next start. */
      page120?: boolean;
      /** The display's maximum refresh rate (Hz). */
      maxFps?: number;
      /** Low Power Mode, and the thermal state (0 nominal … 3 critical), kept current by the shell. */
      lowPower?: boolean;
      thermal?: number;
    };
    webkit?: { messageHandlers?: { opennote?: IosBridge } };
  }
}

/** 'ios' = OpenNote's own WKWebView shell; 'capacitor' = Capacitor runtime (Android, or iOS built with Xcode). */
export type PlatformKind = 'ios' | 'capacitor' | 'web';

export function platformKind(): PlatformKind {
  if (window.OpenNoteNative?.platform === 'ios' && window.webkit?.messageHandlers?.opennote) return 'ios';
  if (Capacitor.isNativePlatform()) return 'capacitor';
  return 'web';
}

export interface HttpResponse {
  status: number;
  data: any;
  text: string;
}

export class HttpError extends Error {
  constructor(message: string, public status?: number, public body?: string) {
    super(message);
  }
}

function parseBody(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Rejection of an httpRequest whose signal was aborted (e.g. the user tapped Cancel). */
export class HttpAbortError extends HttpError {
  constructor() {
    super('Cancelled');
    this.name = 'AbortError';
  }
}

let iosRequestSeq = 0;

/**
 * Rejects as soon as `signal` aborts, running `onAbort` to stop the underlying request. Closing
 * the connection is what makes llama-server stop generating; just ignoring the reply would leave
 * the GPU busy (and the next conversion queued) for up to the whole timeout.
 */
function abortable<T>(signal: AbortSignal | undefined, run: Promise<T>, onAbort: () => void): Promise<T> {
  if (!signal) return run;
  if (signal.aborted) {
    onAbort();
    return Promise.reject(new HttpAbortError());
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      onAbort();
      reject(new HttpAbortError());
    };
    signal.addEventListener('abort', abort, { once: true });
    run.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function httpRequest(opts: {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<HttpResponse> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json', ...(opts.headers ?? {}) };
  const timeoutMs = opts.timeoutMs ?? 30000;
  const bodyText = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  if (bodyText !== undefined) headers['Content-Type'] = 'application/json';

  const kind = platformKind();

  if (kind === 'ios') {
    const bridge = window.webkit!.messageHandlers!.opennote!;
    const id = `req${++iosRequestSeq}`;
    const sent = bridge.postMessage({
      cmd: 'http',
      id,
      url: opts.url,
      method,
      headers,
      body: bodyText ?? null,
      timeout: timeoutMs / 1000,
    });
    const res = await abortable(opts.signal, sent, () => void bridge.postMessage({ cmd: 'httpCancel', id }).catch(() => undefined));
    if (res?.error) throw new HttpError(String(res.error));
    const text = String(res?.body ?? '');
    return { status: Number(res?.status ?? 0), text, data: parseBody(text) };
  }

  if (kind === 'capacitor') {
    try {
      // CapacitorHttp cannot cancel a request: the reply is dropped, the request runs to the end.
      const res = await abortable(opts.signal, CapacitorHttp.request({
        url: opts.url,
        method,
        headers,
        data: opts.body,
        connectTimeout: Math.min(timeoutMs, 20000),
        readTimeout: timeoutMs,
        responseType: 'text',
      }), () => undefined);
      const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      return { status: res.status, text, data: parseBody(text) };
    } catch (err: any) {
      if (err instanceof HttpAbortError) throw err;
      throw new HttpError(err?.message ?? String(err));
    }
  }

  if (opts.signal?.aborted) throw new HttpAbortError();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const cancel = () => controller.abort();
  opts.signal?.addEventListener('abort', cancel, { once: true });
  try {
    const res = await fetch(opts.url, { method, headers, body: bodyText, signal: controller.signal });
    const text = await res.text();
    return { status: res.status, text, data: parseBody(text) };
  } catch (err: any) {
    if (opts.signal?.aborted) throw new HttpAbortError();
    if (err?.name === 'AbortError') throw new HttpError(`Timed out after ${Math.round(timeoutMs / 1000)} s`);
    throw new HttpError(err?.message ?? String(err));
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', cancel);
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function blobToBase64(blob: Blob): Promise<string> {
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

interface PrintPlugin {
  print(opts: { name: string }): Promise<void>;
  pdfPage(opts: { name: string; widthPx: number; heightPx: number }): Promise<{ base64: string }>;
}

/**
 * The app can make a PDF itself, each page at its own size (Android: the WebView's PDF renderer
 * run per page, OpenNotePrintPlugin.pdfPage). Elsewhere PDF goes through the print dialog.
 */
export function canMakePdf(): boolean {
  return platformKind() === 'capacitor' && Capacitor.getPlatform() === 'android';
}

/** The print layout as currently shown, as a one-page PDF of exactly widthPx x heightPx (CSS px). */
export async function pdfOfPrintLayout(name: string, widthPx: number, heightPx: number): Promise<Uint8Array> {
  const { registerPlugin } = await import('@capacitor/core');
  const { base64 } = await registerPlugin<PrintPlugin>('OpenNotePrint').pdfPage({ name, widthPx, heightPx });
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Prints the current WebView content (the editor switches to a print layout first). The system
 * print dialog offers "Save as PDF" on Android and "Save to Files" on iOS, giving a vector PDF.
 */
export async function printDocument(name: string): Promise<void> {
  const kind = platformKind();
  if (kind === 'ios') {
    const res = await window.webkit!.messageHandlers!.opennote!.postMessage({ cmd: 'print', name });
    if (res?.error) throw new Error(String(res.error));
    return;
  }
  if (kind === 'capacitor' && Capacitor.getPlatform() === 'android') {
    const { registerPlugin } = await import('@capacitor/core');
    await registerPlugin<PrintPlugin>('OpenNotePrint').print({ name });
    return;
  }
  window.print();
}

/** Saves/shares a generated file using the native share sheet when available. */
export async function shareFile(filename: string, blob: Blob): Promise<void> {
  const safeName = filename.replace(/[\\/:*?"<>|]+/g, '_');
  const kind = platformKind();

  if (kind === 'ios') {
    const res = await window.webkit!.messageHandlers!.opennote!.postMessage({
      cmd: 'share',
      filename: safeName,
      mimeType: blob.type || 'application/octet-stream',
      base64: await blobToBase64(blob),
    });
    if (res?.error) throw new Error(String(res.error));
    return;
  }

  if (kind === 'capacitor') {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const { Share } = await import('@capacitor/share');
    const written = await Filesystem.writeFile({
      path: `exports/${safeName}`,
      data: await blobToBase64(blob),
      directory: Directory.Cache,
      recursive: true,
    });
    await Share.share({ title: safeName, files: [written.uri], dialogTitle: 'Export from OpenNote' });
    return;
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = safeName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/**
 * iOS shell: lift WebKit's "near 60 fps" page rendering from the next start. Off by default: on a
 * 120 Hz iPad Pro it left the page drawing at 30 fps (Settings > Diagnostics > Frame-rate test).
 */
export async function setPage120(on: boolean): Promise<void> {
  if (platformKind() !== 'ios') return;
  await window.webkit!.messageHandlers!.opennote!.postMessage({ cmd: 'setPage120', on });
  window.OpenNoteNative!.page120 = on;
}

/**
 * Short haptic tick (snap feedback of the smart pen, as in PDEDraw). iOS: UIImpactFeedbackGenerator
 * through the native shell; Android/other: the Vibration API where available. Never awaited.
 */
export function haptic(style: 'snap' | 'light' | 'success' = 'snap'): void {
  try {
    if (platformKind() === 'ios') {
      void window.webkit!.messageHandlers!.opennote!.postMessage({ cmd: 'haptic', style }).catch(() => undefined);
    } else if (navigator.vibrate) {
      navigator.vibrate(style === 'success' ? [6, 40, 6] : style === 'snap' ? 9 : 5);
    }
  } catch {
    /* haptics are best effort */
  }
}
