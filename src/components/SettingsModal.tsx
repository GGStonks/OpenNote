import React, { useState } from 'react';
import { X, Server, Tablet, Check } from 'lucide-react';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  vlmEndpoint: string;
  setVlmEndpoint: (ep: string) => void;
  modelName: string;
  setModelName: (m: string) => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  vlmEndpoint,
  setVlmEndpoint,
  modelName,
  setModelName,
}) => {
  const [tempEndpoint, setTempEndpoint] = useState(vlmEndpoint);
  const [tempModel, setTempModel] = useState(modelName);
  const [saved, setSaved] = useState(false);

  if (!isOpen) return null;

  const handleSave = () => {
    setVlmEndpoint(tempEndpoint);
    setModelName(tempModel);
    setSaved(true);
    setTimeout(() => {
      setSaved(false);
      onClose();
    }, 800);
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-[#1C1C1E] rounded-3xl max-w-lg w-full shadow-2xl border border-gray-200 dark:border-gray-800 overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <div className="p-2 bg-blue-50 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 rounded-xl">
              <Server className="w-5 h-5" />
            </div>
            <h3 className="font-bold text-base text-gray-900 dark:text-gray-100">Settings & Connectivity</h3>
          </div>
          <button onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-600 rounded-full">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          {/* VLM Server Configuration */}
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider block mb-1.5">
              Local VLM Server (Qwen3-VL / Llama.cpp)
            </label>
            <input
              type="text"
              value={tempEndpoint}
              onChange={(e) => setTempEndpoint(e.target.value)}
              className="w-full p-2.5 bg-gray-50 dark:bg-[#2C2C2E] border border-gray-200 dark:border-gray-700 rounded-xl font-mono text-xs focus:ring-2 focus:ring-blue-500 focus:outline-none text-gray-800 dark:text-gray-200"
              placeholder="http://localhost:9191/v1/chat/completions"
            />
            <p className="text-[11px] text-gray-400 mt-1">
              Tip: If accessing from your iPad, replace <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">localhost</code> with your Linux machine's local IP or Tailscale IP (e.g. <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">http://192.168.1.X:9191/v1/chat/completions</code>).
            </p>
          </div>

          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider block mb-1.5">
              Model Identifier
            </label>
            <input
              type="text"
              value={tempModel}
              onChange={(e) => setTempModel(e.target.value)}
              className="w-full p-2.5 bg-gray-50 dark:bg-[#2C2C2E] border border-gray-200 dark:border-gray-700 rounded-xl font-mono text-xs focus:ring-2 focus:ring-blue-500 focus:outline-none text-gray-800 dark:text-gray-200"
              placeholder="qwen3-vl"
            />
          </div>

          {/* iPad / Tablet Instructions */}
          <div className="p-4 bg-blue-50/70 dark:bg-blue-900/20 rounded-2xl border border-blue-100 dark:border-blue-800/50">
            <div className="flex items-center space-x-2 text-blue-700 dark:text-blue-300 font-semibold text-xs mb-1.5">
              <Tablet className="w-4 h-4" />
              <span>Full-Screen iPad PWA Setup</span>
            </div>
            <p className="text-xs text-blue-900/80 dark:text-blue-200/80 leading-relaxed">
              Open Safari on your iPad, navigate to this server (e.g. <code className="font-mono bg-blue-100/60 dark:bg-blue-800/40 px-1 rounded">http://&lt;your-ip&gt;:5173</code>), tap the <strong>Share</strong> button, and tap <strong>"Add to Home Screen"</strong>. It launches in 100% full-screen without Safari browser bars, with native Apple Pencil pressure sensitivity and 120Hz ProMotion response!
            </p>
          </div>
        </div>

        <div className="px-6 py-4 bg-gray-50 dark:bg-[#2C2C2E]/50 border-t border-gray-100 dark:border-gray-800 flex justify-end space-x-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-200/60 rounded-xl"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-5 py-2 bg-blue-600 text-white text-sm font-semibold rounded-xl shadow hover:bg-blue-700 transition flex items-center space-x-1.5"
          >
            {saved ? <Check className="w-4 h-4" /> : null}
            <span>{saved ? 'Saved!' : 'Save Settings'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
