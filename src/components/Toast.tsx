import React, { useEffect, useState } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';

export type ToastType = 'info' | 'success' | 'warning' | 'error';

export interface ToastMessage {
  id: string;
  msg: string;
  type: ToastType;
  durationMs: number;
}

type ToastListener = (toasts: ToastMessage[]) => void;

let activeToasts: ToastMessage[] = [];
const listeners = new Set<ToastListener>();

function notify() {
  listeners.forEach((l) => l([...activeToasts]));
}

export const toast = {
  show(msg: string, type: ToastType = 'info', durationMs = 3500) {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const item: ToastMessage = { id, msg, type, durationMs };
    activeToasts = [...activeToasts, item];
    notify();

    setTimeout(() => {
      activeToasts = activeToasts.filter((t) => t.id !== id);
      notify();
    }, durationMs);
  },
  success(msg: string, durationMs?: number) {
    this.show(msg, 'success', durationMs);
  },
  error(msg: string, durationMs = 5000) {
    this.show(msg, 'error', durationMs);
  },
  info(msg: string, durationMs?: number) {
    this.show(msg, 'info', durationMs);
  },
  warning(msg: string, durationMs?: number) {
    this.show(msg, 'warning', durationMs);
  },
  dismiss(id: string) {
    activeToasts = activeToasts.filter((t) => t.id !== id);
    notify();
  },
};

export const ToastContainer: React.FC = () => {
  const [toasts, setToasts] = useState<ToastMessage[]>(activeToasts);

  useEffect(() => {
    listeners.add(setToasts);
    return () => {
      listeners.delete(setToasts);
    };
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed top-4 left-1/2 -translate-x-1/2 z-[9999] flex flex-col items-center gap-2 pointer-events-none max-w-[94vw] w-full sm:w-auto"
      style={{ paddingTop: 'var(--sa-top)' }}
      data-no-pan
    >
      {toasts.map((t) => {
        const isError = t.type === 'error';
        const isSuccess = t.type === 'success';
        const isWarning = t.type === 'warning';

        return (
          <div
            key={t.id}
            onClick={() => toast.dismiss(t.id)}
            className={`pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-2xl cursor-pointer select-none pop-enter shadow-xl border text-sm font-medium transition-all active:scale-95 ${
              isError
                ? 'bg-red-600/90 text-white border-red-500/50 backdrop-blur-xl'
                : isSuccess
                ? 'bg-emerald-600/90 text-white border-emerald-500/50 backdrop-blur-xl'
                : isWarning
                ? 'bg-amber-600/90 text-white border-amber-500/50 backdrop-blur-xl'
                : 'glass-pill text-gray-900 dark:text-gray-100'
            }`}
          >
            {isError && <AlertCircle className="w-5 h-5 flex-shrink-0" strokeWidth={1.75} />}
            {isSuccess && <CheckCircle2 className="w-5 h-5 flex-shrink-0" strokeWidth={1.75} />}
            {isWarning && <AlertTriangle className="w-5 h-5 flex-shrink-0" strokeWidth={1.75} />}
            {!isError && !isSuccess && !isWarning && <Info className="w-5 h-5 flex-shrink-0 text-blue-500" strokeWidth={1.75} />}
            <span className="truncate max-w-[320px] sm:max-w-md whitespace-pre-wrap">{t.msg}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                toast.dismiss(t.id);
              }}
              className="p-1 rounded-lg opacity-60 hover:opacity-100 transition-opacity ml-1"
            >
              <X className="w-4 h-4" strokeWidth={1.75} />
            </button>
          </div>
        );
      })}
    </div>
  );
};
