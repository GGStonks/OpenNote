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
    OpenNoteNative?: { platform: 'ios'; version: string };
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

export async function httpRequest(opts: {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}): Promise<HttpResponse> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json', ...(opts.headers ?? {}) };
  const timeoutMs = opts.timeoutMs ?? 30000;
  const bodyText = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  if (bodyText !== undefined) headers['Content-Type'] = 'application/json';

  const kind = platformKind();

  if (kind === 'ios') {
    const res = await window.webkit!.messageHandlers!.opennote!.postMessage({
      cmd: 'http',
      url: opts.url,
      method,
      headers,
      body: bodyText ?? null,
      timeout: timeoutMs / 1000,
    });
    if (res?.error) throw new HttpError(String(res.error));
    const text = String(res?.body ?? '');
    return { status: Number(res?.status ?? 0), text, data: parseBody(text) };
  }

  if (kind === 'capacitor') {
    try {
      const res = await CapacitorHttp.request({
        url: opts.url,
        method,
        headers,
        data: opts.body,
        connectTimeout: Math.min(timeoutMs, 20000),
        readTimeout: timeoutMs,
        responseType: 'text',
      });
      const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      return { status: res.status, text, data: parseBody(text) };
    } catch (err: any) {
      throw new HttpError(err?.message ?? String(err));
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(opts.url, { method, headers, body: bodyText, signal: controller.signal });
    const text = await res.text();
    return { status: res.status, text, data: parseBody(text) };
  } catch (err: any) {
    if (err?.name === 'AbortError') throw new HttpError(`Timed out after ${Math.round(timeoutMs / 1000)} s`);
    throw new HttpError(err?.message ?? String(err));
  } finally {
    clearTimeout(timer);
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
