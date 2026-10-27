import React, { useEffect, useRef, useState } from 'react';
import { Download, Loader2, X, AlertCircle } from 'lucide-react';
import { AppRelease, UpdateProgress, canUpdate, cleanupUpdates, downloadUpdate, findUpdate, installUpdate } from '../services/updater';
import { platformKind } from '../platform';
import { useBack } from '../services/backStack';

type Phase =
  | { kind: 'idle' }
  | { kind: 'offer'; rel: AppRelease }
  | { kind: 'downloading'; rel: AppRelease; progress: UpdateProgress }
  | { kind: 'ready'; rel: AppRelease; path: string; note?: string }
  | { kind: 'error'; rel: AppRelease; message: string };

/**
 * The update check at start (services/updater.ts): cleans the update folder, then, when enabled in
 * Settings, looks for a newer release and asks the user. "Update" downloads it in the background (a
 * small card shows the progress; the app stays usable) and then opens the installer (Android) or
 * the share sheet (iOS).
 */
export const UpdatePrompt: React.FC<{ enabled: boolean }> = ({ enabled }) => {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const checked = useRef(false);

  useEffect(() => {
    if (!canUpdate()) return;
    // Packages of an earlier update (installed now, or abandoned) are deleted at every start.
    void cleanupUpdates();
  }, []);

  useEffect(() => {
    if (!enabled || checked.current || !canUpdate()) return;
    checked.current = true;
    // A little after start, so opening the library is not slowed down.
    const t = setTimeout(() => {
      findUpdate()
        .then((rel) => rel && setPhase({ kind: 'offer', rel }))
        .catch(() => undefined); // offline, rate-limited: try again next start
    }, 2500);
    return () => clearTimeout(t);
  }, [enabled]);

  const install = async (rel: AppRelease, path: string) => {
    try {
      await installUpdate(path);
      setPhase({ kind: 'idle' });
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (e.code === 'permission') setPhase({ kind: 'ready', rel, path, note: 'Allow OpenNote to install apps in the settings that opened, then tap Install.' });
      else setPhase({ kind: 'error', rel, message: e.message ?? String(err) });
    }
  };

  const start = async (rel: AppRelease) => {
    setPhase({ kind: 'downloading', rel, progress: { received: 0, total: rel.asset.size || 0 } });
    try {
      const path = await downloadUpdate(rel, (p) => setPhase((cur) => (cur.kind === 'downloading' ? { ...cur, progress: p } : cur)));
      setPhase({ kind: 'ready', rel, path });
      await install(rel, path);
    } catch (err) {
      setPhase({ kind: 'error', rel, message: err instanceof Error ? err.message : String(err) });
      void cleanupUpdates();
    }
  };

  // Back dismisses the offer as a tap beside it does; a download under way is left alone.
  useBack(phase.kind !== 'idle' && phase.kind !== 'downloading', () => setPhase({ kind: 'idle' }));
  if (phase.kind === 'idle') return null;
  const ios = platformKind() === 'ios';

  if (phase.kind === 'offer') {
    const mb = phase.rel.asset.size ? ` (${(phase.rel.asset.size / 1048576).toFixed(1)} MB)` : '';
    return (
      <div className="fixed inset-0 z-[900] bg-black/40 flex items-center justify-center p-4" onClick={() => setPhase({ kind: 'idle' })}>
        <div className="bg-white dark:bg-ui-raised rounded-2xl shadow-2xl w-full max-w-sm p-5" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-xl bg-blue-100 dark:bg-blue-900/40 text-blue-600 flex items-center justify-center flex-shrink-0">
              <Download className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <div className="font-semibold text-gray-900 dark:text-gray-100">OpenNote {phase.rel.version} is available</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">You have {__APP_VERSION__}</div>
            </div>
          </div>
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
            {ios
              ? `Download the update${mb} in the background? When it is ready, open it in the app you install OpenNote with.`
              : `Download and install the update${mb}? It downloads in the background while you keep working.`}
          </p>
          <div className="flex justify-end gap-2">
            <button onClick={() => setPhase({ kind: 'idle' })} className="px-4 py-2 rounded-xl text-sm font-semibold text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/10">
              Later
            </button>
            <button onClick={() => void start(phase.rel)} className="px-4 py-2 rounded-xl text-sm font-semibold bg-blue-600 text-white active:scale-95 transition">
              Update
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Downloading / ready / failed: a small card in a corner; the app stays usable.
  return (
    <div className="fixed z-[900] right-3 bottom-3 w-72 max-w-[calc(100vw-1.5rem)] bg-white dark:bg-ui-raised rounded-2xl shadow-2xl ring-1 ring-black/5 dark:ring-white/10 p-3 text-sm" style={{ marginBottom: 'var(--sa-bottom)' }}>
      <div className="flex items-start gap-2">
        {phase.kind === 'error' ? <AlertCircle className="w-4 h-4 mt-0.5 text-red-500 flex-shrink-0" /> : phase.kind === 'downloading' ? <Loader2 className="w-4 h-4 mt-0.5 animate-spin text-blue-600 flex-shrink-0" /> : <Download className="w-4 h-4 mt-0.5 text-blue-600 flex-shrink-0" />}
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-gray-900 dark:text-gray-100">
            {phase.kind === 'downloading' ? `Downloading OpenNote ${phase.rel.version}…` : phase.kind === 'ready' ? `OpenNote ${phase.rel.version} is ready` : 'Update failed'}
          </div>
          {phase.kind === 'downloading' && (() => {
            const { received, total } = phase.progress;
            const frac = total > 0 ? Math.min(1, received / total) : null;
            const mb = (b: number) => (b / 1048576).toFixed(1);
            return (
              <>
                <div className="mt-2 h-1.5 rounded-full bg-gray-200 dark:bg-white/10 overflow-hidden">
                  <div className={`h-full bg-blue-600 transition-[width] duration-300 ${frac === null ? 'w-1/3 animate-pulse' : ''}`} style={frac === null ? undefined : { width: `${Math.max(2, Math.round(frac * 100))}%` }} />
                </div>
                <div className="mt-1 text-xs tabular-nums text-gray-500 dark:text-gray-400">
                  {received === 0 ? 'Connecting…' : total > 0 ? `${mb(received)} of ${mb(total)} MB · ${Math.round(frac! * 100)}%` : `${mb(received)} MB`}
                </div>
              </>
            );
          })()}
          {phase.kind === 'ready' && phase.note && <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">{phase.note}</div>}
          {phase.kind === 'error' && <div className="text-xs text-gray-500 dark:text-gray-400 mt-1 break-words">{phase.message}</div>}
          {phase.kind === 'ready' && (
            <button onClick={() => void install(phase.rel, phase.path)} className="mt-2 px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 text-white">
              {ios ? 'Open' : 'Install'}
            </button>
          )}
        </div>
        {phase.kind !== 'downloading' && (
          <button
            onClick={() => {
              setPhase({ kind: 'idle' });
              void cleanupUpdates();
            }}
            className="p-1 text-gray-400 hover:text-gray-600 rounded-lg"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
};
