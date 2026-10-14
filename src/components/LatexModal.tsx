import React, { useEffect, useMemo, useState } from 'react';
import { X, Copy, Check, Sparkles, Share2, Loader2, AlertTriangle, RotateCcw } from 'lucide-react';
import { renderLatexContent } from '../services/latexRender';
import { renderTikzPreview, renderTikzWithTeX } from '../services/tikzEngine';

export interface LatexModalState {
  latex: string;
  isTikz: boolean;
  /** 'vlm' = transcription to review, 'edit' = editing an existing block, 'new' = manual insert. */
  origin: 'vlm' | 'edit' | 'new';
  subtitle?: string;
  warning?: string;
  canReplaceInk: boolean;
}

interface LatexModalProps {
  state: LatexModalState | null;
  onClose: () => void;
  onInsert: (latex: string, isTikz: boolean, replaceInk: boolean) => void;
  onRetry?: () => void;
}

const TikzLivePreview: React.FC<{ code: string }> = ({ code }) => {
  const preview = useMemo(() => renderTikzPreview(code), [code]);
  const [tex, setTex] = useState<{ svg?: string; error?: string; busy: boolean }>({ busy: true });

  useEffect(() => {
    let cancelled = false;
    setTex({ busy: true });
    const t = setTimeout(() => {
      renderTikzWithTeX(code)
        .then((svg) => !cancelled && setTex({ svg, busy: false }))
        .catch((err) => !cancelled && setTex({ error: err instanceof Error ? err.message : String(err), busy: false }));
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [code]);

  return (
    <div className="space-y-2">
      <div className="on-tikz on-tikz-preview text-gray-900 dark:text-gray-100 flex items-center justify-center min-h-[160px] max-h-[46vh] overflow-auto" dangerouslySetInnerHTML={{ __html: tex.svg ?? preview.svg }} />
      <div className="text-[11px] flex items-center gap-1.5 text-gray-500">
        {tex.busy ? (
          <>
            <Loader2 className="w-3 h-3 animate-spin" /> Compiling with TeX (TikZJax)… showing quick preview
          </>
        ) : tex.svg ? (
          <>
            <Check className="w-3 h-3 text-green-600" /> Rendered by TeX
          </>
        ) : (
          <span className="text-amber-700 flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" /> TeX: {tex.error}. Showing approximate preview.
          </span>
        )}
        {!tex.svg && preview.warnings.length > 0 && <span className="text-gray-400">· {preview.warnings[0]}</span>}
      </div>
    </div>
  );
};

export const LatexModal: React.FC<LatexModalProps> = ({ state, onClose, onInsert, onRetry }) => {
  const [code, setCode] = useState('');
  const [debounced, setDebounced] = useState('');
  const [isTikz, setIsTikz] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (state) {
      setCode(state.latex);
      setDebounced(state.latex);
      setIsTikz(state.isTikz);
    }
  }, [state]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(code), 250);
    return () => clearTimeout(t);
  }, [code]);

  const math = useMemo(() => (isTikz ? null : renderLatexContent(debounced)), [debounced, isTikz]);

  if (!state) return null;

  const copy = () => {
    navigator.clipboard?.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const primary = state.origin === 'edit' ? 'Save' : 'Insert';

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[60] flex items-end sm:items-center justify-center sm:p-4" data-no-pan>
      <div className="bg-white dark:bg-ui-panel w-full sm:max-w-2xl rounded-t-3xl sm:rounded-3xl shadow-2xl border border-gray-200 dark:border-gray-800 overflow-hidden max-h-[92vh] flex flex-col pb-[env(safe-area-inset-bottom)]">
        <div className="px-5 py-3.5 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <div className={`p-2 rounded-xl ${isTikz ? 'bg-green-50 text-green-600 dark:bg-green-900/40' : 'bg-blue-50 text-blue-600 dark:bg-blue-900/40'}`}>
              {isTikz ? <Share2 className="w-5 h-5" /> : <Sparkles className="w-5 h-5" />}
            </div>
            <div className="min-w-0">
              <h3 className="font-bold text-sm text-gray-900 dark:text-gray-100">
                {state.origin === 'vlm' ? (isTikz ? 'Diagram → TikZ' : 'Handwriting → LaTeX') : isTikz ? 'TikZ diagram' : 'LaTeX'}
              </h3>
              {state.subtitle && <p className="text-xs text-gray-500 truncate">{state.subtitle}</p>}
            </div>
          </div>
          <div className="flex items-center gap-1">
            {state.origin === 'new' && (
              <div className="flex text-xs bg-gray-100 dark:bg-gray-800 rounded-lg p-0.5 mr-1">
                <button className={`px-2 py-1 rounded-md ${!isTikz ? 'bg-white dark:bg-gray-700 shadow-sm' : ''}`} onClick={() => setIsTikz(false)}>Math</button>
                <button className={`px-2 py-1 rounded-md ${isTikz ? 'bg-white dark:bg-gray-700 shadow-sm' : ''}`} onClick={() => setIsTikz(true)}>TikZ</button>
              </div>
            )}
            <button onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-600 rounded-full">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          {state.warning && (
            <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 flex gap-2">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              <span>{state.warning}</span>
            </div>
          )}
          <div className="p-4 bg-gray-50 dark:bg-ui-raised rounded-2xl border border-gray-200 dark:border-gray-700 overflow-auto">
            {isTikz ? (
              <TikzLivePreview code={debounced} />
            ) : (
              <>
                <div className="on-math text-gray-900 dark:text-gray-100 text-[22px] min-h-[64px] flex flex-col justify-center" dangerouslySetInnerHTML={{ __html: math?.html ?? '' }} />
                {math?.error && <div className="mt-2 text-[11px] text-red-600 font-mono">{math.error}</div>}
              </>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">{isTikz ? 'TikZ source' : 'LaTeX source'}</label>
              <button onClick={copy} className="text-xs text-blue-600 dark:text-blue-400 flex items-center gap-1">
                {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <textarea
              value={code}
              onChange={(e) => setCode(e.target.value)}
              rows={isTikz ? 10 : 5}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              className="w-full p-3 bg-gray-50 dark:bg-ui-raised border border-gray-200 dark:border-gray-700 rounded-xl font-mono text-xs focus:ring-2 focus:ring-blue-500 focus:outline-none text-gray-800 dark:text-gray-200 select-text"
              style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
            />
          </div>
        </div>

        <div className="px-5 py-3.5 bg-gray-50 dark:bg-ui-raised/50 border-t border-gray-100 dark:border-gray-800 flex flex-wrap justify-end gap-2">
          {onRetry && state.origin === 'vlm' && (
            <button onClick={onRetry} className="mr-auto px-3 py-2 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-200/60 rounded-xl flex items-center gap-1.5">
              <RotateCcw className="w-4 h-4" /> Retry
            </button>
          )}
          <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-200/60 rounded-xl">
            Cancel
          </button>
          {state.canReplaceInk && (
            <button onClick={() => onInsert(code, isTikz, true)} className="px-4 py-2 text-sm font-semibold rounded-xl border border-blue-600 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/30">
              Replace ink
            </button>
          )}
          <button onClick={() => onInsert(code, isTikz, false)} disabled={!code.trim()} className="px-5 py-2 bg-blue-600 text-white text-sm font-semibold rounded-xl shadow hover:bg-blue-700 disabled:opacity-40">
            {primary}
          </button>
        </div>
      </div>
    </div>
  );
};
