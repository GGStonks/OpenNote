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
      /** WebKit's "near 60 fps" page rendering is lifted in this run (decided at start-up from pageRate). */
      fullFrameRate?: boolean;
      /** The page frame rate setting (Settings > Diagnostics, setPageRate; applies at the next start). */
      pageRate?: PageRate;
      /** Lifting the cap left the page under 50 fps on this device ("auto" keeps the cap since). */
      unlockFailed?: boolean;
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
  pdfPage(opts: { name: string; widthPx: number; heightPx: number; transparent?: boolean }): Promise<{ base64: string }>;
}

/**
 * The app can make a PDF itself, each page at its own size (Android: the WebView's PDF renderer
 * run per page, OpenNotePrintPlugin.pdfPage). Elsewhere PDF goes through the print dialog.
 */
/** The UI benchmark (bench/ui.mjs --only pdfexport) stands in for Android's page printer and the save dialog. */
interface BenchExport {
  __opennoteBenchPrint?: (name: string, widthPx: number, heightPx: number) => Promise<string>;
  __opennoteBenchSave?: (name: string, base64: string) => Promise<void>;
}
const bench = () => window as unknown as BenchExport;

export function canMakePdf(): boolean {
  return (platformKind() === 'capacitor' && Capacitor.getPlatform() === 'android') || !!bench().__opennoteBenchPrint;
}

/** The print layout as currently shown, as a one-page PDF of exactly widthPx x heightPx (CSS px). */
/** `transparent`: printed see-through where the page has no content (a PDF page goes under it). */
export async function pdfOfPrintLayout(name: string, widthPx: number, heightPx: number, transparent = false): Promise<Uint8Array> {
  const stand = bench().__opennoteBenchPrint;
  const { registerPlugin } = await import('@capacitor/core');
  const { base64 } = stand ? { base64: await stand(name, widthPx, heightPx) } : await registerPlugin<PrintPlugin>('OpenNotePrint').pdfPage({ name, widthPx, heightPx, transparent });
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

/** Exports: 'save' asks where to save each file (the system's save dialog), 'share' opens the share sheet. */
export type ExportMode = 'save' | 'share';

/**
 * The export menus offer both for every file ("Save to…" and "Share") in the apps (iOS and
 * Android), where sending a note to Drive, Mail or a chat is as common as keeping it in a folder;
 * a setting choosing one for all exports was in the way. Browsers save.
 */
export function exportOffersBoth(): boolean {
  const kind = platformKind();
  return kind === 'ios' || (kind === 'capacitor' && Capacitor.getPlatform() === 'android');
}

interface SavePlugin {
  stage(o: { id: string; chunk: string; first: boolean }): Promise<void>;
  save(o: { filename: string; mimeType: string; staged: string }): Promise<{ cancelled?: boolean; name?: string; folder?: string }>;
}
let savePlugin: SavePlugin | null = null;

/** Bytes per staged chunk: a multiple of 3, so each chunk is base64 on its own (no padding inside). */
const STAGE_CHUNK = 3 * 256 * 1024;

/**
 * Exports a file where the user chooses: the system's save dialog for each file (iOS: Files' folder
 * picker; Android: the system's "save to" picker; browsers: their save dialog or the downloads), so
 * it is clear where it went. Returns where it was saved, for a confirmation, or null when the user
 * cancelled. `mode` 'share' opens the share sheet instead (shareFile; the apps' export menus ask
 * for each file, exportOffersBoth).
 */
export async function exportFile(filename: string, blob: Blob, mode: ExportMode = 'save'): Promise<string | null> {
  const safeName = filename.replace(/[\\/:*?"<>|]+/g, '_');
  const save = bench().__opennoteBenchSave;
  if (save) {
    await save(safeName, await blobToBase64(blob));
    return `Saved “${safeName}”.`;
  }
  if (mode === 'share') {
    await shareFile(safeName, blob);
    return null;
  }
  const kind = platformKind();
  const mimeType = blob.type || 'application/octet-stream';
  if (kind === 'ios') {
    const res = await window.webkit!.messageHandlers!.opennote!.postMessage({ cmd: 'saveFile', filename: safeName, mimeType, base64: await blobToBase64(blob) });
    if (res?.error) throw new Error(String(res.error));
    if (res?.cancelled) return null;
    return `Saved “${res?.name ?? safeName}” in ${res?.folder ? `“${res.folder}”` : 'the folder you chose'}.`;
  }
  if (kind === 'capacitor') {
    if (!savePlugin) {
      const { registerPlugin } = await import('@capacitor/core');
      savePlugin = registerPlugin<SavePlugin>('OpenNoteSave');
    }
    // The file is handed over in chunks first and the picker gets only its id: with the file in the
    // call that opens the picker, Android had to keep it in the app's saved state when the picker
    // sent the app to the background, and a large export (megabytes) crashed the app, leaving the
    // chosen file empty (OpenNoteSavePlugin).
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    for (let at = 0; at === 0 || at < blob.size; at += STAGE_CHUNK) {
      await savePlugin.stage({ id, chunk: await blobToBase64(blob.slice(at, at + STAGE_CHUNK)), first: at === 0 });
    }
    const res = await savePlugin.save({ filename: safeName, mimeType, staged: id });
    if (res?.cancelled) return null;
    return `Saved “${res?.name ?? safeName}”${res?.folder ? ` in “${res.folder}”` : ' in the folder you chose'}.`;
  }
  // Browsers: their save dialog where there is one, else the downloads.
  const picker = (window as unknown as { showSaveFilePicker?: (o: { suggestedName: string }) => Promise<{ name: string; createWritable(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void> }> }> }).showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker({ suggestedName: safeName });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      return `Saved “${handle.name}”.`;
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return null;
      throw err;
    }
  }
  await shareFile(safeName, blob);
  return `Saved “${safeName}” in the browser's downloads.`;
}

/**
 * iOS shell: the page's frame rate from the next start. 'auto': the display's (WebKit's "near 60 fps"
 * cap lifted) where it is faster than 60 Hz and that worked; '60': the cap; 'max': always lifted.
 */
export type PageRate = 'auto' | '60' | 'max';

export async function setPageRate(rate: PageRate): Promise<void> {
  if (platformKind() !== 'ios') return;
  await window.webkit!.messageHandlers!.opennote!.postMessage({ cmd: 'setPageRate', rate });
  window.OpenNoteNative!.pageRate = rate;
}

/**
 * The UI theme's background for the shells' launch screens (shown before the page runs, from the
 * next start): an OLED Black app started on a light grey screen.
 */
export async function setLaunchTheme(id: string, background: string, dark: boolean): Promise<void> {
  const kind = platformKind();
  if (kind === 'ios') {
    await window.webkit!.messageHandlers!.opennote!.postMessage({ cmd: 'setLaunchTheme', background });
  } else if (kind === 'capacitor') {
    const { registerPlugin } = await import('@capacitor/core');
    await registerPlugin<{ setTheme(o: { id: string; background: string; dark: boolean }): Promise<void> }>('OpenNoteLaunch').setTheme({ id, background, dark });
  }
}

/** iOS shell: the page measured under 50 fps with the cap lifted; 'auto' keeps it from the next start. */
export async function pageUnlockFailed(): Promise<void> {
  if (platformKind() !== 'ios') return;
  await window.webkit!.messageHandlers!.opennote!.postMessage({ cmd: 'pageUnlockFailed' });
  window.OpenNoteNative!.unlockFailed = true;
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
