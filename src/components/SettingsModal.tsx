import React, { useEffect, useRef, useState } from 'react';
import { canUpdate } from '../services/updater';
import { X, Settings as SettingsIcon, Check, Loader2, Wifi, AlertCircle, Download, Upload, FolderDown, Share2 } from 'lucide-react';
import { THEMES, THEME_IDS, applyTheme } from '../theme';
import { penRecorder } from '../ink/penRecorder';
import { crashLog } from '../services/crashLog';
import { frameProbe } from '../services/frameProbe';
import { AppSettings, DEFAULT_SERVER, resolveChatUrl } from '../settings';
import { testConnection } from '../services/vlmService';
import { autoDeviceName } from '../services/serverAuth';
import { setVectorInk, vectorInkEnabled } from '../ink/vectorInk';
import { ExportMode, PageRate, exportOffersBoth, platformKind, setPageRate, shareFile } from '../platform';
import { frameRate } from '../services/frameRate';
import { useBack } from '../services/backStack';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  onSave: (s: AppSettings) => void;
  /** Exports the whole library as one .opennote archive. */
  onBackup: (mode?: ExportMode) => void;
  /** Imports a .opennote archive or note. */
  onImport: (file: File) => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose: close, settings, onSave, onBackup, onImport }) => {
  const importRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(settings);
  const [test, setTest] = useState<{ state: 'idle' | 'busy' | 'ok' | 'error'; msg?: string }>({ state: 'idle' });
  const [rec, setRec] = useState({ on: penRecorder.enabled, count: penRecorder.count });
  const [recMsg, setRecMsg] = useState<{ ok: boolean; msg: string } | null>(null);
  const [crash, setCrash] = useState(crashLog.lastCrash);
  const probe = isOpen ? frameProbe.last : null;
  const [pageRate, setPageRateState] = useState<PageRate>(window.OpenNoteNative?.pageRate ?? 'auto');
  const [vectorInk, setVectorInkState] = useState(vectorInkEnabled);
  const [crashMsg, setCrashMsg] = useState<{ ok: boolean; msg: string } | null>(null);
  useEffect(() => crashLog.subscribe(() => setCrash(crashLog.lastCrash)), []);
  useEffect(() => penRecorder.subscribe(() => setRec({ on: penRecorder.enabled, count: penRecorder.count })), []);

  useEffect(() => {
    if (isOpen) {
      setDraft(settings);
      setTest({ state: 'idle' });
      setRecMsg(null);
    }
  }, [isOpen, settings]);

  useBack(isOpen, close);
  if (!isOpen) return null;
  // The theme is previewed as soon as it is picked; closing without saving puts the saved one back.
  const onClose = () => {
    applyTheme(settings.theme);
    close();
  };
  const set = (patch: Partial<AppSettings>) => setDraft((d) => ({ ...d, ...patch }));

  const runTest = async () => {
    setTest({ state: 'busy' });
    try {
      setTest({ state: 'ok', msg: await testConnection(draft) });
    } catch (err) {
      setTest({ state: 'error', msg: err instanceof Error ? err.message : String(err) });
    }
  };

  const sendRecording = async () => {
    setRecMsg({ ok: true, msg: 'Sending…' });
    try {
      setRecMsg({ ok: true, msg: `Saved on the PC: ${await penRecorder.sendToPc(draft, platformKind())}` });
    } catch (err) {
      setRecMsg({ ok: false, msg: err instanceof Error ? err.message : String(err) });
    }
  };

  const shareRecording = async () => {
    try {
      const data = JSON.stringify(penRecorder.snapshot(platformKind()));
      await shareFile(`pen-recording-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, new Blob([data], { type: 'application/json' }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/cancel/i.test(msg)) setRecMsg({ ok: false, msg });
    }
  };

  const field = 'w-full p-2.5 bg-gray-50 dark:bg-ui-raised border border-gray-200 dark:border-gray-700 rounded-xl font-mono text-xs focus:ring-2 focus:ring-blue-500 focus:outline-none text-gray-800 dark:text-gray-200 select-text';
  const label = 'text-[11px] font-semibold text-gray-500 uppercase tracking-wider block mb-1.5';
  const Toggle: React.FC<{ checked: boolean; onChange: (v: boolean) => void; title: string; sub?: string }> = ({ checked, onChange, title, sub }) => (
    <label className="flex items-start justify-between gap-3 py-1.5 cursor-pointer">
      <span>
        <span className="text-sm text-gray-800 dark:text-gray-200">{title}</span>
        {sub && <span className="block text-[11px] text-gray-400">{sub}</span>}
      </span>
      <input type="checkbox" className="mt-1 w-4 h-4" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[60] flex items-end sm:items-center justify-center sm:p-4" data-no-pan>
      <div className="bg-white dark:bg-ui-panel rounded-t-3xl sm:rounded-3xl w-full sm:max-w-lg shadow-2xl border border-gray-200 dark:border-gray-800 overflow-hidden max-h-[calc(100dvh-16px)] flex flex-col pb-[var(--sa-bottom)]">
        <div className="px-5 py-3.5 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-2 bg-blue-50 dark:bg-blue-900/40 text-blue-600 rounded-xl">
              <SettingsIcon className="w-5 h-5" />
            </div>
            <h3 className="font-bold text-base text-gray-900 dark:text-gray-100">Settings</h3>
          </div>
          <button onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-600 rounded-full">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          <section>
            <div className={label}>Appearance</div>
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
              {THEME_IDS.map((id) => {
                const t = THEMES[id];
                const on = draft.theme === id;
                return (
                  <button
                    key={id}
                    onClick={() => {
                      set({ theme: id });
                      applyTheme(id);
                    }}
                    className={`rounded-2xl p-1.5 border-2 text-left transition ${on ? 'border-blue-500' : 'border-transparent hover:border-gray-300 dark:hover:border-gray-600'}`}
                    title={t.label}
                  >
                    <div className="h-12 rounded-xl overflow-hidden flex ring-1 ring-black/10" style={{ backgroundColor: t.preview[0] }}>
                      <div className="w-1/3 h-full" style={{ backgroundColor: t.preview[1] }} />
                      <div className="flex-1 p-1.5 space-y-1">
                        <div className="h-1.5 rounded-full w-3/4" style={{ backgroundColor: t.preview[2], opacity: 0.8 }} />
                        <div className="h-1.5 rounded-full w-1/2" style={{ backgroundColor: t.preview[2], opacity: 0.35 }} />
                      </div>
                    </div>
                    <div className={`text-[11px] mt-1 text-center truncate ${on ? 'font-semibold text-blue-600 dark:text-blue-400' : 'text-gray-600 dark:text-gray-300'}`}>{t.label}</div>
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] text-gray-400 mt-1.5">Changes the whole interface. Note pages keep the paper colour chosen for them.</p>
          </section>

          <section className="space-y-3 border-t border-gray-100 dark:border-gray-800 pt-3">
            <div>
              <label className={label}>Qwen3-VL server</label>
              <input className={field} value={draft.vlmEndpoint} onChange={(e) => set({ vlmEndpoint: e.target.value })} placeholder={DEFAULT_SERVER} autoCapitalize="off" autoCorrect="off" />
              <p className="text-[11px] text-gray-400 mt-1">
                The default, <code className="font-mono break-all">{DEFAULT_SERVER}</code>, works from any device with internet access, no VPN needed. Requests go to <code className="font-mono break-all">{resolveChatUrl(draft.vlmEndpoint)}</code>.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={label}>Model</label>
                <input className={field} value={draft.modelName} onChange={(e) => set({ modelName: e.target.value })} autoCapitalize="off" />
              </div>
              <div>
                <label className={label}>Timeout (s)</label>
                <input className={field} type="number" min={20} max={900} value={draft.vlmTimeoutSec} onChange={(e) => set({ vlmTimeoutSec: Math.max(20, +e.target.value || 180) })} />
              </div>
            </div>
            <div>
              <label className={label}>API key</label>
              <input
                className={field}
                value={draft.apiKey}
                onChange={(e) => set({ apiKey: e.target.value.trim() })}
                placeholder="Key issued for this device"
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
              />
              <p className="text-[11px] text-gray-400 mt-1">Each device needs its own key from the server’s owner. Without one, Test connection asks the owner to approve this device.</p>
            </div>
            <div>
              <label className={label}>Device name</label>
              <input className={field} value={draft.deviceName} onChange={(e) => set({ deviceName: e.target.value })} placeholder={autoDeviceName()} maxLength={60} />
              <p className="text-[11px] text-gray-400 mt-1">How the server’s owner sees this device.</p>
            </div>
            <button onClick={runTest} disabled={test.state === 'busy'} className="flex items-center gap-2 text-sm font-semibold text-blue-600 dark:text-blue-400">
              {test.state === 'busy' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wifi className="w-4 h-4" />}
              Test connection
            </button>
            {test.msg && (
              <div className={`text-xs rounded-xl px-3 py-2 flex gap-2 ${test.state === 'ok' ? 'bg-green-50 text-green-800 dark:bg-green-900/30 dark:text-green-300' : 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300'}`}>
                {test.state === 'ok' ? <Check className="w-4 h-4 flex-shrink-0" /> : <AlertCircle className="w-4 h-4 flex-shrink-0" />}
                <span className="break-all">{test.msg}</span>
              </div>
            )}
          </section>

          <section className="border-t border-gray-100 dark:border-gray-800 pt-3">
            <div className={label}>Pencil & input</div>
            <Toggle checked={draft.stylusOnly} onChange={(v) => set({ stylusOnly: v })} title="Only the pencil draws" sub="Palm rejection: fingers scroll and zoom instead of drawing" />
            <Toggle checked={draft.holdToSnap} onChange={(v) => set({ holdToSnap: v })} title="Draw and hold to snap shapes" sub="Hold the pen still for a second at the end: lines, arrows, circles, ellipses, rectangles, triangles, polygons (keeping the pen's width)" />
            <Toggle checked={draft.pencilDoubleTapEraser} onChange={(v) => set({ pencilDoubleTapEraser: v })} title="Apple Pencil double-tap switches to eraser" />
            <Toggle checked={draft.fingerTapUndo} onChange={(v) => set({ fingerTapUndo: v })} title="Two-finger tap to undo" sub="Three-finger tap redoes" />
            <Toggle
              checked={vectorInk}
              onChange={(v) => {
                setVectorInkState(v);
                setVectorInk(v);
              }}
              title="Vector ink"
              sub="Finished ink drawn as vectors, sharp at every zoom (off: bitmaps). Applies when a note is opened."
            />
          </section>

          {canUpdate() && (
            <section className="border-t border-gray-100 dark:border-gray-800 pt-3">
              <div className={label}>Updates</div>
              <Toggle checked={draft.checkUpdates} onChange={(v) => set({ checkUpdates: v })} title="Check for updates at startup" sub={`Looks for a newer OpenNote release on GitHub (this is v${__APP_VERSION__})`} />
            </section>
          )}

          <section className="border-t border-gray-100 dark:border-gray-800 pt-3">
            <div className={label}>Library</div>
            <p className="text-[11px] text-gray-400 mb-2">A backup is one <code className="font-mono">.opennote</code> archive of every note, folder and tag. Importing adds its notes (notes with the same id are replaced).</p>
            <div className="flex flex-wrap gap-2">
              {/* In the apps, saved or shared as each export (exportOffersBoth). */}
              {exportOffersBoth() ? (
                <>
                  <button onClick={() => onBackup('save')} className="flex items-center gap-2 px-3 py-2 rounded-xl bg-gray-100 dark:bg-ui-raised text-sm font-semibold text-gray-800 dark:text-gray-100">
                    <FolderDown className="w-4 h-4" /> Save backup to…
                  </button>
                  <button onClick={() => onBackup('share')} className="flex items-center gap-2 px-3 py-2 rounded-xl bg-gray-100 dark:bg-ui-raised text-sm font-semibold text-gray-800 dark:text-gray-100">
                    <Share2 className="w-4 h-4" /> Share backup
                  </button>
                </>
              ) : (
                <button onClick={() => onBackup()} className="flex items-center gap-2 px-3 py-2 rounded-xl bg-gray-100 dark:bg-ui-raised text-sm font-semibold text-gray-800 dark:text-gray-100">
                  <Download className="w-4 h-4" /> Backup (export .opennote)
                </button>
              )}
              <button onClick={() => importRef.current?.click()} className="flex items-center gap-2 px-3 py-2 rounded-xl bg-gray-100 dark:bg-ui-raised text-sm font-semibold text-gray-800 dark:text-gray-100">
                <Upload className="w-4 h-4" /> Import .opennote
              </button>
              <input ref={importRef} type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onImport(f); e.target.value = ''; }} />
            </div>
          </section>

          <section className="border-t border-gray-100 dark:border-gray-800 pt-3">
            <div className={label}>Diagnostics</div>
            <Toggle
              checked={rec.on}
              onChange={(v) => penRecorder.setEnabled(v)}
              title="Record pen strokes"
              sub={`Raw Pencil samples of pen strokes, to tune the ink engine. ${rec.count} stroke${rec.count === 1 ? '' : 's'} recorded (kept until the app closes).`}
            />
            {rec.count > 0 && (
              <div className="flex flex-wrap gap-3 text-sm font-semibold text-blue-600 dark:text-blue-400 pt-1">
                <button onClick={sendRecording}>Send to PC</button>
                <button onClick={shareRecording}>Share file</button>
                <button onClick={() => penRecorder.clear()} className="text-red-500">Clear</button>
              </div>
            )}
            {recMsg && <p className={`text-xs mt-2 break-all ${recMsg.ok ? 'text-gray-500' : 'text-red-600'}`}>{recMsg.msg}</p>}
            <div className="mt-3 text-sm text-gray-800 dark:text-gray-200">Crash report</div>
            <p className="text-[11px] text-gray-400">
              {crash
                ? `The app ended unexpectedly on ${new Date(crash.lastAt).toLocaleString()} (${crash.reason}). The report holds what it was doing just before, to find the cause.`
                : 'No unexpected end recorded. The report still holds what the app did recently.'}
            </p>
            <div className="flex flex-wrap gap-3 text-sm font-semibold text-blue-600 dark:text-blue-400 pt-1">
              <button
                onClick={async () => {
                  setCrashMsg({ ok: true, msg: 'Sending…' });
                  try {
                    setCrashMsg({ ok: true, msg: `Saved on the PC: ${await crashLog.sendToPc(draft)}` });
                  } catch (err) {
                    setCrashMsg({ ok: false, msg: err instanceof Error ? err.message : String(err) });
                  }
                }}
              >
                Send to PC
              </button>
              <button
                onClick={async () => {
                  try {
                    await shareFile(`opennote-crash-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, new Blob([JSON.stringify(crashLog.report())], { type: 'application/json' }));
                  } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    if (!/cancel/i.test(msg)) setCrashMsg({ ok: false, msg });
                  }
                }}
              >
                Share file
              </button>
              {crash && <button onClick={() => crashLog.clear()} className="text-red-500">Clear</button>}
            </div>
            {crashMsg && <p className={`text-xs mt-2 break-all ${crashMsg.ok ? 'text-gray-500' : 'text-red-600'}`}>{crashMsg.msg}</p>}
            <div className="mt-3 flex items-center justify-between gap-3">
              <div>
                <div className="text-sm text-gray-800 dark:text-gray-200">Page frame rate</div>
                <p className="text-[11px] text-gray-400">
                  {`Now ${frameRate.measured ? Math.round(frameRate.hz) + ' fps' : 'not measured yet'}${window.OpenNoteNative?.maxFps ? `, display ${window.OpenNoteNative.maxFps} Hz` : ''}.`}
                  {platformKind() === 'ios' &&
                    ` Automatic uses the display's rate where it is faster than 60 Hz and the page keeps up${window.OpenNoteNative?.unlockFailed ? ' (it did not here: 60 Hz)' : ''}. Applies after restarting the app.`}
                </p>
              </div>
              {platformKind() === 'ios' && (
                <select
                  value={pageRate}
                  onChange={(e) => {
                    const v = e.target.value as PageRate;
                    setPageRateState(v);
                    void setPageRate(v).catch(() => undefined);
                  }}
                  className="text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-ui-raised px-2 py-1"
                >
                  <option value="auto">Automatic</option>
                  <option value="60">60 Hz</option>
                  <option value="max">Display maximum</option>
                </select>
              )}
            </div>
            <div className="mt-3 text-sm text-gray-800 dark:text-gray-200">Frame-rate test</div>
            <p className="text-[11px] text-gray-400">
              Measures how fast this device draws the open note, WebGL and canvas drawing (7 s; open a note first). The result goes into the crash report.
              {probe && ` Last: ${Object.entries(probe.phases).map(([k, v]) => `${k} ${v ? v.fps + ' fps' : '–'}`).join(', ')}.`}
            </p>
            <div className="flex flex-wrap gap-3 text-sm font-semibold text-blue-600 dark:text-blue-400 pt-1">
              <button
                onClick={() => {
                  onClose();
                  setTimeout(() => void frameProbe.run(), 500);
                }}
              >
                Run test
              </button>
            </div>
          </section>
        </div>

        <div className="px-5 py-3.5 bg-gray-50 dark:bg-ui-raised/50 border-t border-gray-100 dark:border-gray-800 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 dark:text-gray-300 rounded-xl">
            Cancel
          </button>
          <button
            onClick={() => {
              onSave(draft);
              close();
            }}
            className="px-5 py-2 bg-blue-600 text-white text-sm font-semibold rounded-xl shadow"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
};
