import { HttpResponse, platformKind } from '../platform';
import { AppSettings } from '../settings';

/**
 * Access to the conversion server: every request carries this device's API key (Settings) and
 * identifies the device, so the server's owner can approve it. Keys are issued and checked only
 * by the server; the app just stores and sends the one it was given.
 */

const DEVICE_KEY = 'opennote_device_id';

let deviceId: string | null = null;

function getDeviceId(): string {
  if (deviceId) return deviceId;
  try {
    deviceId = localStorage.getItem(DEVICE_KEY);
  } catch {
    /* storage unavailable */
  }
  if (!deviceId || !/^[A-Za-z0-9-]{8,64}$/.test(deviceId)) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    deviceId = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    try {
      localStorage.setItem(DEVICE_KEY, deviceId);
    } catch {
      /* storage unavailable: a new id each launch */
    }
  }
  return deviceId;
}

/** A name for this device, shown to the server's owner, when Settings has none. */
export function autoDeviceName(): string {
  const ua = navigator.userAgent;
  const kind = platformKind();
  if (kind === 'ios') return /iPhone/.test(ua) ? 'iPhone' : 'iPad';
  if (kind === 'capacitor') {
    const model = /Android[^;)]*;\s*([^;)]+?)(?:\sBuild|\))/.exec(ua)?.[1];
    return model ? `Android (${model})` : 'Android device';
  }
  return 'Web browser';
}

/** Headers of every request to the conversion server. */
export function serverHeaders(settings: AppSettings): Record<string, string> {
  const name = (settings.deviceName.trim() || autoDeviceName()).replace(/[^\x20-\x7e]/g, '?').slice(0, 60);
  const headers: Record<string, string> = {
    'X-OpenNote-Device': getDeviceId(),
    'X-OpenNote-Device-Name': name,
    'X-OpenNote-Version': __APP_VERSION__,
  };
  const key = settings.apiKey.trim();
  if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
}

export interface KeyStatus {
  status: 'active' | 'denied' | 'limit_reached';
  name: string;
  used: number;
  limit: number | null;
}

/** The server's explanation of a refused request (not approved, disabled, over its limit, app too old), or null. */
export function authError(res: HttpResponse): string | null {
  if (![401, 403, 426, 429, 503].includes(res.status)) return null;
  const err = typeof res.data === 'object' ? res.data?.error : null;
  return err && typeof err.message === 'string' && typeof err.type === 'string' ? err.message : null;
}

export function describeKeyStatus(s: KeyStatus): string {
  const used = s.used.toLocaleString();
  return s.limit == null ? `Approved as “${s.name}”: ${used} tokens used, no limit.` : `Approved as “${s.name}”: ${used} of ${s.limit.toLocaleString()} tokens used.`;
}
