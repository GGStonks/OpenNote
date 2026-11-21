import React, { useEffect, useRef, useState } from 'react';
import {
  Settings as SettingsIcon,
  Check,
  Loader2,
  Wifi,
  AlertCircle,
  Download,
  Upload,
  Cpu,
  Palette,
  PenTool,
  ShieldAlert,
} from 'lucide-react';
import { THEMES, THEME_IDS, applyTheme } from '../../theme';
import { penRecorder } from '../../ink/penRecorder';
import { crashLog } from '../../services/crashLog';
import { AppSettings, DEFAULT_SERVER, resolveChatUrl } from '../../settings';
import { testConnection } from '../../services/vlmService';
import { setVectorInk, vectorInkEnabled } from '../../ink/vectorInk';
import { ExportMode, PageRate, exportOffersBoth, platformKind, setPageRate, shareFile } from '../../platform';
import { StudioButton } from './StudioButton';
import { StudioSheet } from './StudioSheet';

export interface SettingsStudioModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  onSave: (s: AppSettings) => void;
  onBackup: (mode?: ExportMode) => void;
  onImport: (file: File) => void;
}

export const SettingsStudioModal: React.FC<SettingsStudioModalProps> = ({
  isOpen,
  onClose: close,
  settings,
  onSave,
  onBackup,
  onImport,
}) => {
  const importRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(settings);
  const [test, setTest] = useState<{ state: 'idle' | 'busy' | 'ok' | 'error'; msg?: string }>({
    state: 'idle',
  });
  const [rec, setRec] = useState({ on: penRecorder.enabled, count: penRecorder.count });
  const [recMsg, setRecMsg] = useState<{ ok: boolean; msg: string } | null>(null);
  const [crash, setCrash] = useState(crashLog.lastCrash);
  const [pageRate, setPageRateState] = useState<PageRate>(window.OpenNoteNative?.pageRate ?? 'auto');
  const [vectorInk, setVectorInkState] = useState(vectorInkEnabled);

  useEffect(() => crashLog.subscribe(() => setCrash(crashLog.lastCrash)), []);
  useEffect(() => penRecorder.subscribe(() => setRec({ on: penRecorder.enabled, count: penRecorder.count })), []);

  useEffect(() => {
    if (isOpen) {
      setDraft(settings);
      setTest({ state: 'idle' });
      setRecMsg(null);
    }
  }, [isOpen, settings]);

  if (!isOpen) return null;

  const handleClose = () => {
    applyTheme(settings.theme);
    close();
  };

  const set = (patch: Partial<AppSettings>) => setDraft((d) => ({ ...d, ...patch }));

  const handleSave = () => {
    onSave(draft);
    close();
  };

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
      setRecMsg({ ok: true, msg: `Saved on PC: ${await penRecorder.sendToPc(draft, platformKind())}` });
    } catch (err) {
      setRecMsg({ ok: false, msg: err instanceof Error ? err.message : String(err) });
    }
  };

  const shareRecording = async () => {
    try {
      const data = JSON.stringify(penRecorder.snapshot(platformKind()));
      await shareFile(
        `pen-recording-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
        new Blob([data], { type: 'application/json' })
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/cancel/i.test(msg)) setRecMsg({ ok: false, msg });
    }
  };

  const field =
    'w-full p-2.5 bg-gray-50 dark:bg-ui-high border border-black/5 dark:border-white/10 rounded-xl font-mono text-xs focus:ring-2 focus:ring-studio-accent/40 focus:outline-none text-gray-900 dark:text-gray-100 select-text';

  const sectionLabel =
    'text-[11px] font-bold text-gray-400 uppercase tracking-wider block mb-2';

  const Toggle: React.FC<{
    checked: boolean;
    onChange: (v: boolean) => void;
    title: string;
    sub?: string;
  }> = ({ checked, onChange, title, sub }) => (
    <label className="flex items-start justify-between gap-3 py-2 cursor-pointer group">
      <div>
        <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{title}</div>
        {sub && <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{sub}</div>}
      </div>
      <input
        type="checkbox"
        className="mt-1 w-4 h-4 rounded accent-studio-accent"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );

  return (
    <StudioSheet
      isOpen={isOpen}
      onClose={handleClose}
      title="Studio Settings"
      icon={<SettingsIcon className="w-5 h-5 text-studio-accent" />}
      maxWidth="lg"
    >
      <div className="space-y-6">
        {/* Appearance & Themes */}
        <section>
          <span className={sectionLabel}>Theme Archetypes</span>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            {THEME_IDS.map((id) => {
              const t = THEMES[id];
              const on = draft.theme === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    set({ theme: id });
                    applyTheme(id);
                  }}
                  className={`rounded-2xl p-2 border-2 text-left transition ${
                    on
                      ? 'border-studio-accent bg-studio-accent-subtle shadow-sm'
                      : 'border-transparent hover:border-black/10 dark:hover:border-white/10'
                  }`}
                  title={t.label}
                >
                  <div
                    className="h-10 rounded-xl overflow-hidden flex ring-1 ring-black/10 mb-1.5"
                    style={{ backgroundColor: t.preview[0] }}
                  >
                    <div className="w-1/3 h-full" style={{ backgroundColor: t.preview[1] }} />
                    <div className="flex-1 p-1 space-y-1">
                      <div
                        className="h-1 rounded-full w-3/4"
                        style={{ backgroundColor: t.preview[2], opacity: 0.8 }}
                      />
                      <div
                        className="h-1 rounded-full w-1/2"
                        style={{ backgroundColor: t.preview[2], opacity: 0.4 }}
                      />
                    </div>
                  </div>
                  <div className="text-xs font-semibold text-center truncate">{t.label}</div>
                </button>
              );
            })}
          </div>
        </section>

        {/* Input & Ergonomics */}
        <section className="pt-4 border-t border-black/5 dark:border-white/5 space-y-1">
          <span className={sectionLabel}>Pencil & Input Ergonomics</span>
          <Toggle
            title="Palm Rejection (Stylus Only)"
            sub="Fingers only scroll and pinch; drawing is restricted to Apple Pencil / S-Pen."
            checked={draft.stylusOnly}
            onChange={(v) => set({ stylusOnly: v })}
          />
          <Toggle
            title="Hold to Snap Shapes"
            sub="Rest stylus 0.45s after drawing to automatically snap to regular geometric shapes."
            checked={draft.holdToSnap}
            onChange={(v) => set({ holdToSnap: v })}
          />
          <Toggle
            title="Two-Finger Undo / Three-Finger Redo"
            sub="Quick tap gestures for undo and redo anywhere on canvas."
            checked={draft.fingerTapUndo}
            onChange={(v) => set({ fingerTapUndo: v })}
          />
          <Toggle
            title="Apple Pencil Double-Tap Switch"
            sub="Double-tapping Pencil side barrel toggles between Pen and Eraser."
            checked={draft.pencilDoubleTapEraser}
            onChange={(v) => set({ pencilDoubleTapEraser: v })}
          />
        </section>

        {/* AI Transcription Server */}
        <section className="pt-4 border-t border-black/5 dark:border-white/5 space-y-3">
          <span className={sectionLabel}>AI Transcription Service (Qwen3-VL)</span>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Server Endpoint</label>
            <input
              type="text"
              value={draft.vlmEndpoint}
              onChange={(e) => set({ vlmEndpoint: e.target.value })}
              className={field}
              placeholder={DEFAULT_SERVER}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Device API Key</label>
              <input
                type="password"
                value={draft.apiKey}
                onChange={(e) => set({ apiKey: e.target.value })}
                className={field}
                placeholder="Device key"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Device Name</label>
              <input
                type="text"
                value={draft.deviceName}
                onChange={(e) => set({ deviceName: e.target.value })}
                className={field}
                placeholder="Optional device label"
              />
            </div>
          </div>

          <div className="flex items-center justify-between pt-1">
            <StudioButton size="sm" variant="secondary" onClick={runTest} disabled={test.state === 'busy'}>
              {test.state === 'busy' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />
              ) : (
                <Wifi className="w-3.5 h-3.5 mr-1 text-studio-accent" />
              )}
              <span>Test Connection</span>
            </StudioButton>

            {test.msg && (
              <span
                className={`text-xs ${
                  test.state === 'ok' ? 'text-emerald-600 font-semibold' : 'text-red-500'
                }`}
              >
                {test.msg}
              </span>
            )}
          </div>
        </section>

        {/* Diagnostics & Backup */}
        <section className="pt-4 border-t border-black/5 dark:border-white/5 space-y-3">
          <span className={sectionLabel}>Data & Backups</span>
          <div className="flex gap-2">
            <StudioButton
              size="sm"
              variant="secondary"
              onClick={() => onBackup()}
              className="flex-1"
            >
              <Download className="w-3.5 h-3.5 mr-1" /> Backup Library
            </StudioButton>
            <StudioButton
              size="sm"
              variant="secondary"
              onClick={() => importRef.current?.click()}
              className="flex-1"
            >
              <Upload className="w-3.5 h-3.5 mr-1" /> Restore Archive
            </StudioButton>
          </div>
          <input
            ref={importRef}
            type="file"
            accept=".opennote,.json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onImport(f);
              e.target.value = '';
            }}
          />
        </section>

        {/* Footer actions */}
        <div className="pt-4 border-t border-black/5 dark:border-white/5 flex items-center justify-between">
          <span className="text-xs text-gray-400 font-mono">OpenNote v{__APP_VERSION__}</span>
          <div className="flex items-center gap-2">
            <StudioButton size="sm" variant="ghost" onClick={handleClose}>
              Cancel
            </StudioButton>
            <StudioButton size="sm" variant="primary" onClick={handleSave}>
              Save Changes
            </StudioButton>
          </div>
        </div>
      </div>
    </StudioSheet>
  );
};
