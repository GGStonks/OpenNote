import React, { useState } from 'react';
import { X, Copy, Check, Sparkles, PlusCircle, Share2 } from 'lucide-react';
import { renderLatexToHtml, renderTikzPreview } from '../services/latexService';

interface LatexModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialLatex: string;
  isTikz: boolean;
  source: 'vlm' | 'fallback';
  onInsertIntoCanvas: (latex: string, isTikz: boolean) => void;
}

export const LatexModal: React.FC<LatexModalProps> = ({
  isOpen,
  onClose,
  initialLatex,
  isTikz,
  source,
  onInsertIntoCanvas,
}) => {
  const [latexCode, setLatexCode] = useState(initialLatex);
  const [copied, setCopied] = useState(false);

  React.useEffect(() => {
    setLatexCode(initialLatex);
  }, [initialLatex]);

  if (!isOpen) return null;

  const renderedHtml = isTikz ? renderTikzPreview(latexCode) : renderLatexToHtml(latexCode);

  const handleCopy = () => {
    navigator.clipboard.writeText(latexCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleInsert = () => {
    onInsertIntoCanvas(latexCode, isTikz);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-[#1C1C1E] rounded-3xl max-w-xl w-full shadow-2xl border border-gray-200 dark:border-gray-800 overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <div className={`p-2 rounded-xl ${isTikz ? 'bg-green-50 dark:bg-green-900/40 text-green-600' : 'bg-blue-50 dark:bg-blue-900/40 text-blue-600'}`}>
              {isTikz ? <Share2 className="w-5 h-5" /> : <Sparkles className="w-5 h-5" />}
            </div>
            <div>
              <h3 className="font-bold text-base text-gray-900 dark:text-gray-100">
                {isTikz ? 'Handwritten Diagram to TikZ' : 'Handwritten Math to LaTeX'}
              </h3>
              <p className="text-xs text-gray-500">
                {source === 'vlm' ? 'Transcribed by local Qwen3-VL VLM' : 'Interactive Math/TikZ Engine'}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-600 rounded-full">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4">
          {/* Live Preview Box */}
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider block mb-2">
              {isTikz ? 'TikZ Diagram Output' : 'Rendered Vector Math Formula'}
            </label>
            <div className="p-5 bg-gray-50 dark:bg-[#2C2C2E] rounded-2xl border border-gray-200 dark:border-gray-700 flex items-center justify-center min-h-[100px] overflow-x-auto text-xl text-gray-900 dark:text-gray-100">
              <div dangerouslySetInnerHTML={{ __html: renderedHtml }} />
            </div>
          </div>

          {/* LaTeX / TikZ Source Code */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                {isTikz ? 'TikZ Source Code' : 'LaTeX Source Code'}
              </label>
              <button
                onClick={handleCopy}
                className="text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center space-x-1"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied ? 'Copied' : 'Copy Code'}</span>
              </button>
            </div>
            <textarea
              value={latexCode}
              onChange={(e) => setLatexCode(e.target.value)}
              rows={isTikz ? 6 : 3}
              className="w-full p-3 bg-gray-50 dark:bg-[#2C2C2E] border border-gray-200 dark:border-gray-700 rounded-xl font-mono text-xs focus:ring-2 focus:ring-blue-500 focus:outline-none text-gray-800 dark:text-gray-200"
            />
          </div>
        </div>

        {/* Footer Actions */}
        <div className="px-6 py-4 bg-gray-50 dark:bg-[#2C2C2E]/50 border-t border-gray-100 dark:border-gray-800 flex justify-end space-x-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-200/60 rounded-xl"
          >
            Cancel
          </button>
          <button
            onClick={handleInsert}
            className="px-5 py-2 bg-gradient-to-r from-blue-600 to-indigo-600 text-white text-sm font-semibold rounded-xl shadow-md hover:opacity-95 transition flex items-center space-x-1.5"
          >
            <PlusCircle className="w-4 h-4" />
            <span>Insert Into Note</span>
          </button>
        </div>
      </div>
    </div>
  );
};
