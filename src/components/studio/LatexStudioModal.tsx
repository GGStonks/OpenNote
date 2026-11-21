import React, { useEffect, useMemo, useState } from 'react';
import { X, Copy, Check, Sparkles, Loader2, AlertTriangle, RotateCcw } from 'lucide-react';
import { renderLatexContent } from '../../services/latexRender';
import { renderTikzPreview, renderTikzWithTeX } from '../../services/tikzEngine';
import { StudioButton } from './StudioButton';
import { StudioSheet } from './StudioSheet';

export interface LatexStudioModalState {
  latex: string;
  isTikz: boolean;
  origin: 'vlm' | 'edit' | 'new';
  subtitle?: string;
  warning?: string;
  canReplaceInk: boolean;
}

export interface LatexStudioModalProps {
  state: LatexStudioModalState | null;
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
      <div
        className="on-tikz on-tikz-preview text-gray-900 dark:text-gray-100 flex items-center justify-center min-h-[160px] max-h-[38dvh] overflow-auto bg-gray-50 dark:bg-ui-high/40 rounded-2xl p-4 border border-black/5 dark:border-white/5"
        dangerouslySetInnerHTML={{ __html: tex.svg ?? preview.svg }}
      />
      <div className="text-[11px] flex items-center gap-1.5 text-gray-500">
        {tex.busy ? (
          <>
            <Loader2 className="w-3.5 h-3.5 animate-spin text-studio-accent" />
            <span>Compiling with TeX (TikZJax)…</span>
          </>
        ) : tex.svg ? (
          <>
            <Check className="w-3.5 h-3.5 text-emerald-600" />
            <span>Rendered with TeX</span>
          </>
        ) : (
          <span className="text-amber-600 flex items-center gap-1">
            <AlertTriangle className="w-3.5 h-3.5" /> TeX: {tex.error}. Showing fast preview.
          </span>
        )}
      </div>
    </div>
  );
};

export const LatexStudioModal: React.FC<LatexStudioModalProps> = ({
  state,
  onClose,
  onInsert,
  onRetry,
}) => {
  const [code, setCode] = useState('');
  const [debounced, setDebounced] = useState('');
  const [isTikz, setIsTikz] = useState(false);
  const [replaceInk, setReplaceInk] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (state) {
      setCode(state.latex);
      setDebounced(state.latex);
      setIsTikz(state.isTikz);
      setReplaceInk(state.canReplaceInk);
    }
  }, [state]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(code), 250);
    return () => clearTimeout(t);
  }, [code]);

  const math = useMemo(() => (isTikz ? null : renderLatexContent(debounced)), [debounced, isTikz]);

  if (!state) return null;

  const copyCode = () => {
    navigator.clipboard?.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const title = isTikz ? 'TikZ Diagram' : 'LaTeX Math';

  return (
    <StudioSheet
      isOpen={!!state}
      onClose={onClose}
      title={title}
      icon={<Sparkles className="w-5 h-5 text-studio-accent" />}
      maxWidth="xl"
    >
      <div className="space-y-4">
        {state.warning && (
          <div className="p-3 rounded-2xl bg-amber-500/10 border border-amber-500/20 text-amber-700 dark:text-amber-300 text-xs flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>{state.warning}</span>
          </div>
        )}

        {/* Live Preview Card */}
        <div className="space-y-1.5">
          <span className="text-[11px] font-bold text-gray-400 uppercase tracking-wider block">
            Preview
          </span>
          {isTikz ? (
            <TikzLivePreview code={debounced} />
          ) : (
            <div className="min-h-[100px] max-h-[30dvh] overflow-auto p-4 bg-gray-50 dark:bg-ui-high/40 rounded-2xl border border-black/5 dark:border-white/5 flex items-center justify-center">
              {math?.html ? (
                <div
                  className="on-math text-base sm:text-lg text-gray-900 dark:text-gray-100"
                  dangerouslySetInnerHTML={{ __html: math.html }}
                />
              ) : (
                <span className="text-xs text-gray-400 italic">Formula preview</span>
              )}
            </div>
          )}
        </div>

        {/* Code Editor */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">
              LaTeX Code
            </span>
            <button
              type="button"
              onClick={copyCode}
              className="text-xs text-gray-500 hover:text-studio-accent flex items-center gap-1 font-medium"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copied ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
          <textarea
            value={code}
            onChange={(e) => setCode(e.target.value)}
            rows={isTikz ? 6 : 3}
            className="w-full p-3 font-mono text-xs rounded-2xl bg-gray-50 dark:bg-ui-high border border-black/5 dark:border-white/10 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-studio-accent/40 select-text"
          />
        </div>

        {/* Options & Action Footer */}
        <div className="pt-2 flex flex-col sm:flex-row items-center justify-between gap-3 border-t border-black/5 dark:border-white/5">
          {state.canReplaceInk ? (
            <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400 cursor-pointer">
              <input
                type="checkbox"
                className="accent-studio-accent rounded"
                checked={replaceInk}
                onChange={(e) => setReplaceInk(e.target.checked)}
              />
              <span>Replace handwritten strokes</span>
            </label>
          ) : (
            <div />
          )}

          <div className="flex items-center gap-2 w-full sm:w-auto">
            {onRetry && (
              <StudioButton size="sm" variant="secondary" onClick={onRetry} className="flex-1 sm:flex-none">
                <RotateCcw className="w-3.5 h-3.5 mr-1" />
                Retry
              </StudioButton>
            )}
            <StudioButton
              size="sm"
              variant="primary"
              onClick={() => onInsert(code, isTikz, replaceInk)}
              className="flex-1 sm:flex-none"
            >
              {state.origin === 'edit' ? 'Save Changes' : 'Insert on Page'}
            </StudioButton>
          </div>
        </div>
      </div>
    </StudioSheet>
  );
};
