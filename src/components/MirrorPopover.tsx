import React, { useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Copy, Power, RefreshCw, Terminal } from 'lucide-react';
import { mirrorStart, mirrorStatus, mirrorStop, MirrorStatus } from '../services/rustCore';
import { toast } from './Toast';

/** The cast URL's QR code, encoded by Rust (remote_service.rs), drawn with its 4-module quiet zone. */
const CastQr: React.FC<{ qr: NonNullable<MirrorStatus['qr']> }> = ({ qr }) => (
  <svg viewBox={`-4 -4 ${qr.size + 8} ${qr.size + 8}`} className="w-full h-full" shapeRendering="crispEdges" role="img" aria-label="QR code of the cast address">
    <rect x={-4} y={-4} width={qr.size + 8} height={qr.size + 8} fill="#fff" />
    <path d={qr.d} fill="#000" />
  </svg>
);

export const MirrorPopover: React.FC<{
  onClose: () => void;
  cleanPresentation: boolean;
  onToggleCleanPresentation: (clean: boolean) => void;
}> = ({ onClose, cleanPresentation, onToggleCleanPresentation }) => {
  const [status, setStatus] = useState<MirrorStatus>({ active: false, clients: 0 });
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showTether, setShowTether] = useState(false);

  const refresh = async () => {
    try {
      const s = await mirrorStatus();
      setStatus(s);
    } catch {
      // offline
    }
  };

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 2000);
    return () => clearInterval(interval);
  }, []);

  const handleToggle = async () => {
    setLoading(true);
    try {
      if (status.active) {
        await mirrorStop();
        toast.info('PC mirroring stopped');
      } else {
        await mirrorStart();
        toast.success('PC mirroring started');
      }
      await refresh();
    } catch (err) {
      toast.error(`Mirror failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async () => {
    if (!status.url) return;
    try {
      await navigator.clipboard.writeText(status.url);
      setCopied(true);
      toast.success('Cast address copied');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Could not copy: type the address shown on the PC');
    }
  };
  const loopback = !!status.url && /\/\/127\.0\.0\.1[:/]/.test(status.url);

  const isLive = status.active;
  const port = status.port ?? 38400;
  const hasClients = (status.clients ?? 0) > 0;

  return (
    <div className="flex flex-col gap-4 text-gray-900 dark:text-gray-100 select-none">
      {/* Header with status pill */}
      <div className="flex items-center justify-between gap-3 pb-2 border-b border-gray-200/60 dark:border-white/10">
        <div className="flex items-center gap-2">
          <div className="relative flex items-center justify-center">
            {isLive ? (
              <>
                <span className={`w-3 h-3 rounded-full ${hasClients ? 'bg-emerald-500' : 'bg-amber-500'} animate-ping opacity-75 absolute`} />
                <span className={`w-2.5 h-2.5 rounded-full ${hasClients ? 'bg-emerald-500' : 'bg-amber-500'}`} />
              </>
            ) : (
              <span className="w-2.5 h-2.5 rounded-full bg-gray-400" />
            )}
          </div>
          <div>
            <h4 className="font-semibold text-sm leading-tight flex items-center gap-1.5">
              Cast Note to PC
            </h4>
            <span className="text-[11px] text-gray-500 dark:text-gray-400">
              {isLive
                ? hasClients
                  ? `Live • ${status.clients} PC${status.clients === 1 ? '' : 's'} connected`
                  : 'Ready • Waiting for PC connection'
                : 'Offline'}
            </span>
          </div>
        </div>

        <button
          onClick={handleToggle}
          disabled={loading}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold active:scale-95 transition-all shadow-sm ${
            isLive
              ? 'bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20 border border-red-500/30'
              : 'bg-blue-600 text-white hover:bg-blue-700 shadow-blue-600/25'
          }`}
        >
          {loading ? (
            <RefreshCw className="w-3.5 h-3.5 animate-spin" strokeWidth={1.75} />
          ) : (
            <Power className="w-3.5 h-3.5" strokeWidth={1.75} />
          )}
          {isLive ? 'Stop' : 'Start'}
        </button>
      </div>

      {isLive && (
        <>
          {/* QR Code and PIN card */}
          <div className="flex items-center gap-4 bg-gray-50 dark:bg-white/5 p-3 rounded-2xl border border-gray-200/50 dark:border-white/5">
            {status.qr && !loopback && (
              <div className="w-28 h-28 rounded-lg overflow-hidden flex-shrink-0">
                <CastQr qr={status.qr} />
              </div>
            )}
            <div className="flex-1 min-w-0 flex flex-col justify-center">
              <span className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">Access PIN</span>
              <span className="text-2xl font-mono font-bold tracking-widest text-blue-600 dark:text-blue-400 tabular-nums">
                {status.pin ?? '----'}
              </span>
              <span className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                Scan the code or open the address below on a PC on the same Wi-Fi.
              </span>
            </div>
          </div>
          {loopback && (
            <p className="text-xs rounded-xl px-3 py-2 bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
              This device has no Wi-Fi address right now: join the same Wi-Fi as the PC, then stop and start casting. Over a USB cable, use the steps below.
            </p>
          )}

          {/* Copy URL button */}
          <button
            onClick={handleCopy}
            className="w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl border border-gray-200/80 dark:border-white/10 bg-white/70 dark:bg-white/5 hover:bg-white dark:hover:bg-white/10 text-xs font-medium transition active:scale-98"
          >
            <span className="truncate flex-1 text-left text-gray-700 dark:text-gray-300 font-mono">
              {status.url}
            </span>
            <span className="flex items-center gap-1 text-blue-600 dark:text-blue-400 font-semibold ml-2 flex-shrink-0">
              {copied ? <Check className="w-3.5 h-3.5" strokeWidth={1.75} /> : <Copy className="w-3.5 h-3.5" strokeWidth={1.75} />}
              {copied ? 'Copied' : 'Copy'}
            </span>
          </button>
        </>
      )}

      {/* Options */}
      <div className="flex flex-col gap-2 pt-1 border-t border-gray-200/60 dark:border-white/10 text-xs">
        <label className="flex items-center justify-between cursor-pointer py-1 text-gray-700 dark:text-gray-300">
          <span>Clean Presentation (Hide UI chrome on PC)</span>
          <input
            type="checkbox"
            checked={cleanPresentation}
            onChange={(e) => onToggleCleanPresentation(e.target.checked)}
            className="w-4 h-4 accent-blue-600 rounded"
          />
        </label>

        {/* Collapsible USB Tethering hint */}
        <div className="mt-1">
          <button
            onClick={() => setShowTether(!showTether)}
            className="w-full flex items-center justify-between py-1 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 text-left font-medium"
          >
            <span className="flex items-center gap-1.5">
              <Terminal className="w-3.5 h-3.5" strokeWidth={1.75} /> USB Tethering (Zero Wi-Fi Latency)
            </span>
            {showTether ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>
          {showTether && (
            <div className="p-2.5 mt-1 rounded-xl bg-gray-100 dark:bg-ui-high text-[11px] font-mono leading-relaxed space-y-1">
              <div className="text-gray-400 font-sans font-semibold">Android (via USB cable):</div>
              <div className="text-blue-600 dark:text-blue-400 select-all">adb forward tcp:{port} tcp:{port}</div>
              <div className="text-gray-400 font-sans font-semibold mt-1.5">iOS (via USB cable):</div>
              <div className="text-blue-600 dark:text-blue-400 select-all">iproxy {port} {port}</div>
              <div className="text-gray-500 font-sans mt-1">Then open <b className="select-all">http://localhost:{port}/{status.pin ? `?pin=${status.pin}` : ''}</b> in your browser.</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
