import React, { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, Lock, X } from 'lucide-react';

export interface DialogOptions {
  kind: 'alert' | 'confirm' | 'prompt';
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  destructive?: boolean;
  defaultValue?: string;
  placeholder?: string;
  password?: boolean;
  resolve: (value: any) => void;
}

type DialogListener = (dialog: DialogOptions | null) => void;

let currentDialog: DialogOptions | null = null;
const listeners = new Set<DialogListener>();

function notify() {
  listeners.forEach((l) => l(currentDialog));
}

export const dialog = {
  alert(message: string, title?: string, confirmText = 'OK'): Promise<void> {
    return new Promise((resolve) => {
      currentDialog = {
        kind: 'alert',
        title,
        message,
        confirmText,
        resolve: () => {
          currentDialog = null;
          notify();
          resolve();
        },
      };
      notify();
    });
  },

  confirm(
    message: string,
    title = 'Confirm',
    opts?: { confirmText?: string; cancelText?: string; destructive?: boolean }
  ): Promise<boolean> {
    return new Promise((resolve) => {
      currentDialog = {
        kind: 'confirm',
        title,
        message,
        confirmText: opts?.confirmText ?? 'Confirm',
        cancelText: opts?.cancelText ?? 'Cancel',
        destructive: opts?.destructive ?? false,
        resolve: (val: boolean) => {
          currentDialog = null;
          notify();
          resolve(val);
        },
      };
      notify();
    });
  },

  prompt(
    message: string,
    defaultValue = '',
    opts?: { title?: string; placeholder?: string; password?: boolean; confirmText?: string; cancelText?: string }
  ): Promise<string | null> {
    return new Promise((resolve) => {
      currentDialog = {
        kind: 'prompt',
        title: opts?.title ?? 'Enter Input',
        message,
        defaultValue,
        placeholder: opts?.placeholder ?? '',
        password: opts?.password ?? false,
        confirmText: opts?.confirmText ?? 'OK',
        cancelText: opts?.cancelText ?? 'Cancel',
        resolve: (val: string | null) => {
          currentDialog = null;
          notify();
          resolve(val);
        },
      };
      notify();
    });
  },

  close() {
    if (currentDialog) {
      currentDialog.resolve(currentDialog.kind === 'confirm' ? false : null);
      currentDialog = null;
      notify();
    }
  },
};

export const DialogContainer: React.FC = () => {
  const [active, setActive] = useState<DialogOptions | null>(currentDialog);
  const [inputVal, setInputVal] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    listeners.add(setActive);
    return () => {
      listeners.delete(setActive);
    };
  }, []);

  useEffect(() => {
    if (active && active.kind === 'prompt') {
      setInputVal(active.defaultValue ?? '');
      setShowPassword(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        dialog.close();
      } else if (e.key === 'Enter' && active.kind !== 'prompt') {
        e.preventDefault();
        active.resolve(true);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [active]);

  if (!active) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (active.kind === 'prompt') {
      active.resolve(inputVal);
    } else {
      active.resolve(true);
    }
  };

  return (
    <div
      data-viewport-hole
      className="fixed inset-0 z-[10000] bg-black/40 backdrop-blur-sm flex items-center justify-center p-4 select-none"
      onClick={() => dialog.close()}
      data-no-pan
    >
      <div
        className="glass-pill rounded-3xl w-full max-w-sm p-6 pop-enter flex flex-col gap-4 text-gray-900 dark:text-gray-100 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-2">
          {active.title && (
            <h3 className="font-semibold text-base sm:text-lg tracking-tight leading-snug flex items-center gap-2">
              {active.password && <Lock className="w-5 h-5 text-blue-500 flex-shrink-0" strokeWidth={1.75} />}
              {active.title}
            </h3>
          )}
          <button
            onClick={() => dialog.close()}
            className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 rounded-full transition ml-auto"
          >
            <X className="w-5 h-5" strokeWidth={1.75} />
          </button>
        </div>

        <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed whitespace-pre-wrap">
          {active.message}
        </p>

        {active.kind === 'prompt' && (
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <div className="relative">
              <input
                ref={inputRef}
                type={active.password && !showPassword ? 'password' : 'text'}
                value={inputVal}
                onChange={(e) => setInputVal(e.target.value)}
                placeholder={active.placeholder}
                className="w-full px-3.5 py-2.5 rounded-xl border border-gray-300 dark:border-gray-700 bg-white dark:bg-ui-raised text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 select-text pr-10"
              />
              {active.password && (
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" strokeWidth={1.75} /> : <Eye className="w-4 h-4" strokeWidth={1.75} />}
                </button>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 mt-2">
              <button
                type="button"
                onClick={() => dialog.close()}
                className="px-4 py-2 rounded-xl text-sm font-semibold text-gray-600 dark:text-gray-300 hover:bg-black/5 dark:hover:bg-white/10 active:scale-95 transition"
              >
                {active.cancelText ?? 'Cancel'}
              </button>
              <button
                type="submit"
                className="px-4 py-2 rounded-xl text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 active:scale-95 shadow-md shadow-blue-600/25 transition"
              >
                {active.confirmText ?? 'OK'}
              </button>
            </div>
          </form>
        )}

        {active.kind === 'confirm' && (
          <div className="flex items-center justify-end gap-2 mt-2">
            <button
              onClick={() => {
                active.resolve(false);
              }}
              className="px-4 py-2 rounded-xl text-sm font-semibold text-gray-600 dark:text-gray-300 hover:bg-black/5 dark:hover:bg-white/10 active:scale-95 transition"
            >
              {active.cancelText ?? 'Cancel'}
            </button>
            <button
              onClick={() => {
                active.resolve(true);
              }}
              className={`px-4 py-2 rounded-xl text-sm font-semibold text-white active:scale-95 transition shadow-md ${
                active.destructive
                  ? 'bg-red-600 hover:bg-red-700 shadow-red-600/25'
                  : 'bg-blue-600 hover:bg-blue-700 shadow-blue-600/25'
              }`}
            >
              {active.confirmText ?? 'Confirm'}
            </button>
          </div>
        )}

        {active.kind === 'alert' && (
          <div className="flex items-center justify-end gap-2 mt-2">
            <button
              onClick={() => {
                active.resolve(undefined);
              }}
              className="px-5 py-2 rounded-xl text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 active:scale-95 shadow-md shadow-blue-600/25 transition"
            >
              {active.confirmText ?? 'OK'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
