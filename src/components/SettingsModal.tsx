import React, { useEffect, useState } from 'react';
import { X, Server, Check, Loader2, Wifi, AlertCircle } from 'lucide-react';
import { AppSettings, resolveChatUrl } from '../settings';
import { testConnection } from '../services/vlmService';
import { platformKind } from '../platform';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  onSave: (s: AppSettings) => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose, settings, onSave }) => {
  const [draft, setDraft] = useState(settings);
  const [test, setTest] = useState<{ state: 'idle' | 'busy' | 'ok' | 'error'; msg?: string }>({ state: 'idle' });

  useEffect(() => {
    if (isOpen) {
      setDraft(settings);
      setTest({ state: 'idle' });
    }
  }, [isOpen, settings]);

  if (!isOpen) return null;
  const set = (patch: Partial<AppSettings>) => setDraft((d) => ({ ...d, ...patch }));

  const runTest = async () => {
    setTest({ state: 'busy' });
    try {
      setTest({ state: 'ok', msg: await testConnection(draft) });
    } catch (err) {
      setTest({ state: 'error', msg: err instanceof Error ? err.message : String(err) });
    }
  };

  const field = 'w-full p-2.5 bg-gray-50 dark:bg-[#2C2C2E] border border-gray-200 dark:border-gray-700 rounded-xl font-mono text-xs focus:ring-2 focus:ring-blue-500 focus:outline-none text-gray-800 dark:text-gray-200 select-text';
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
      <div className="bg-white dark:bg-[#1C1C1E] rounded-t-3xl sm:rounded-3xl w-full sm:max-w-lg shadow-2xl border border-gray-200 dark:border-gray-800 overflow-hidden max-h-[92vh] flex flex-col pb-[env(safe-area-inset-bottom)]">
        <div className="px-5 py-3.5 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-2 bg-blue-50 dark:bg-blue-900/40 text-blue-600 rounded-xl">
              <Server className="w-5 h-5" />
            </div>
            <h3 className="font-bold text-base text-gray-900 dark:text-gray-100">Settings</h3>
          </div>
          <button onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-600 rounded-full">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          <section className="space-y-3">
            <div>
              <label className={label}>Qwen3-VL server</label>
              <input className={field} value={draft.vlmEndpoint} onChange={(e) => set({ vlmEndpoint: e.target.value })} placeholder="http://100.77.212.97:9191" autoCapitalize="off" autoCorrect="off" />
              <p className="text-[11px] text-gray-400 mt-1">
                Base URL of the llama.cpp / switchboard server (port 9191). Requests go to <code className="font-mono">{resolveChatUrl(draft.vlmEndpoint)}</code>.
                {platformKind() !== 'web' && ' Use the PC’s LAN or Tailscale IP — “localhost” is the phone itself.'}
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
              <label className={label}>API key (optional)</label>
              <input className={field} value={draft.apiKey} onChange={(e) => set({ apiKey: e.target.value })} autoCapitalize="off" />
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
            <Toggle checked={draft.holdToSnap} onChange={(v) => set({ holdToSnap: v })} title="Draw and hold to snap shapes" sub="Lines, arrows, circles, ellipses, rectangles, triangles, polygons" />
            <Toggle checked={draft.pencilDoubleTapEraser} onChange={(v) => set({ pencilDoubleTapEraser: v })} title="Apple Pencil double-tap switches to eraser" />
          </section>
        </div>

        <div className="px-5 py-3.5 bg-gray-50 dark:bg-[#2C2C2E]/50 border-t border-gray-100 dark:border-gray-800 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 dark:text-gray-300 rounded-xl">
            Cancel
          </button>
          <button
            onClick={() => {
              onSave(draft);
              onClose();
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
