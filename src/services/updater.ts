/**
 * App updates from OpenNote's GitHub releases.
 *
 * At start (unless switched off in Settings) the latest release is looked up; when it is newer
 * than the running version the user is asked, and on yes the package for this platform is
 * downloaded in the background:
 *  - Android: the release's .apk, opened in the system installer (OpenNoteUpdatePlugin);
 *  - iOS: the release's .ipa, offered in the share sheet (an app cannot install an app on iOS: the
 *    user opens it in the installer they sideload with), ios-native/OpenNoteShell.m.
 * Downloads go to an update folder of the app's own temporary files, deleted at every start (so
 * once the updated app runs, the package is gone) and, on iOS, as soon as the share sheet closes.
 */
import { Capacitor } from '@capacitor/core';
import { httpRequest, platformKind } from '../platform';

const REPO = 'GGStonks/OpenNote';

export interface AppRelease {
  version: string;
  tag: string;
  url: string;
  asset: { name: string; url: string; size: number };
}

interface UpdatePlugin {
  download(opts: { url: string; fileName: string }): Promise<{ path: string }>;
  install(opts: { path: string }): Promise<void>;
  cleanup(): Promise<void>;
  addListener(event: 'progress', fn: (p: { received: number; total: number }) => void): Promise<{ remove: () => Promise<void> }>;
}

type Target = 'android' | 'ios';

function target(): Target | null {
  if (platformKind() === 'ios') return 'ios';
  if (platformKind() === 'capacitor' && Capacitor.getPlatform() === 'android') return 'android';
  return null;
}

/** The app can update itself (the apps; not the browser). */
export function canUpdate(): boolean {
  return target() !== null;
}

async function plugin(): Promise<UpdatePlugin> {
  const { registerPlugin } = await import('@capacitor/core');
  return registerPlugin<UpdatePlugin>('OpenNoteUpdate');
}

/** -1, 0, 1: version a older than, equal to, newer than b ("v2.1.5", "2.1.5"). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.replace(/^v/i, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const x = parse(a), y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** The latest release, when it is newer than the running app and has a package for this platform. */
export async function findUpdate(current = __APP_VERSION__): Promise<AppRelease | null> {
  const t = target();
  if (!t) return null;
  const res = await httpRequest({
    url: `https://api.github.com/repos/${REPO}/releases/latest`,
    headers: { Accept: 'application/vnd.github+json' },
    timeoutMs: 15000,
  });
  if (res.status !== 200 || !res.data || typeof res.data !== 'object') return null;
  const rel = res.data as { tag_name?: string; html_url?: string; draft?: boolean; prerelease?: boolean; assets?: { name: string; browser_download_url: string; size: number }[] };
  if (!rel.tag_name || rel.draft || rel.prerelease) return null;
  if (compareVersions(rel.tag_name, current) <= 0) return null;
  const ext = t === 'android' ? '.apk' : '.ipa';
  const asset = (rel.assets ?? []).find((a) => a.name.toLowerCase().endsWith(ext));
  if (!asset) return null;
  return {
    version: rel.tag_name.replace(/^v/i, ''),
    tag: rel.tag_name,
    url: rel.html_url ?? `https://github.com/${REPO}/releases`,
    asset: { name: asset.name, url: asset.browser_download_url, size: asset.size },
  };
}

/**
 * Downloads the release's package in the background (progress 0..1, or null when the size is
 * unknown) and returns its path in the update folder.
 */
export async function downloadUpdate(rel: AppRelease, onProgress: (p: number | null) => void): Promise<string> {
  const t = target();
  const fileName = `OpenNote-${rel.version}${t === 'android' ? '.apk' : '.ipa'}`;
  if (t === 'android') {
    const p = await plugin();
    const sub = await p.addListener('progress', ({ received, total }) => onProgress(total > 0 ? received / total : null));
    try {
      return (await p.download({ url: rel.asset.url, fileName })).path;
    } finally {
      void sub.remove();
    }
  }
  if (t === 'ios') {
    const w = window as unknown as { __opennoteUpdateProgress?: (r: number, total: number) => void };
    w.__opennoteUpdateProgress = (r, total) => onProgress(total > 0 ? r / total : null);
    try {
      const res = await window.webkit!.messageHandlers!.opennote!.postMessage({ cmd: 'updateDownload', url: rel.asset.url, fileName });
      if (res?.error) throw new Error(String(res.error));
      return String(res.path);
    } finally {
      delete w.__opennoteUpdateProgress;
    }
  }
  throw new Error('Updates are only available in the app');
}

/**
 * Hands the downloaded package over: Android's installer, or iOS's share sheet (the download is
 * deleted when it closes). Rejects with code 'permission' when Android first needs the user to
 * allow installs from OpenNote (its settings page has been opened).
 */
export async function installUpdate(path: string): Promise<void> {
  const t = target();
  if (t === 'android') return (await plugin()).install({ path });
  if (t === 'ios') {
    const res = await window.webkit!.messageHandlers!.opennote!.postMessage({ cmd: 'updateShare', path });
    if (res?.error && res.error !== 'cancelled') throw new Error(String(res.error));
  }
}

/** Deletes the update folder (called at every start). */
export async function cleanupUpdates(): Promise<void> {
  const t = target();
  try {
    if (t === 'android') await (await plugin()).cleanup();
    else if (t === 'ios') await window.webkit!.messageHandlers!.opennote!.postMessage({ cmd: 'updateCleanup' });
  } catch {
    /* nothing to clean */
  }
}
