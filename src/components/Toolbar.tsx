import React, { useState } from 'react';
import {
  Undo2, Redo2, Edit3, Highlighter, Eraser, Scissors, Type,
  Mic, MicOff, Share, Settings, Grid, Sparkles, ChevronLeft,
  Plus, Hand, PenLine
} from 'lucide-react';
import { ToolType, PaperStyle, PaperColor } from '../types';

interface ToolbarProps {
  activeTool: ToolType;
  setActiveTool: (tool: ToolType) => void;
  penColor: string;
  setPenColor: (color: string) => void;
  penWidth: number;
  setPenWidth: (width: number) => void;
  highlighterColor: string;
  setHighlighterColor: (color: string) => void;
  stylusOnlyMode: boolean;
  setStylusOnlyMode: (val: boolean) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  title: string;
  setTitle: (t: string) => void;
  paperStyle: PaperStyle;
  setPaperStyle: (s: PaperStyle) => void;
  paperColor: PaperColor;
  setPaperColor: (c: PaperColor) => void;
  onBackToLibrary: () => void;
  onConvertFullPageToLatex: () => void;
  onOpenExport: () => void;
  onOpenSettings: () => void;
  onAddPage: () => void;
  currentPage: number;
  totalPages: number;
}

const PEN_COLORS = [
  '#000000', '#1A73E8', '#D93025', '#188038', '#F2994A', '#9B51E0',
  '#4A5568', '#00C48C'
];

const HIGHLIGHTER_COLORS = [
  '#FDE047', '#86EFAC', '#93C5FD', '#F472B6', '#C084FC', '#FDBA74'
];

export const Toolbar: React.FC<ToolbarProps> = ({
  activeTool,
  setActiveTool,
  penColor,
  setPenColor,
  penWidth,
  setPenWidth,
  highlighterColor,
  setHighlighterColor,
  stylusOnlyMode,
  setStylusOnlyMode,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  title,
  setTitle,
  paperStyle,
  setPaperStyle,
  paperColor,
  setPaperColor,
  onBackToLibrary,
  onConvertFullPageToLatex,
  onOpenExport,
  onOpenSettings,
  onAddPage,
  currentPage,
  totalPages,
}) => {
  const [showPenMenu, setShowPenMenu] = useState(false);
  const [showHighlighterMenu, setShowHighlighterMenu] = useState(false);
  const [showPaperMenu, setShowPaperMenu] = useState(false);
  const [isRecording, setIsRecording] = useState(false);

  return (
    <header className="h-14 bg-white/95 dark:bg-[#1C1C1E]/95 backdrop-blur-md border-b border-gray-200 dark:border-gray-800 flex items-center justify-between px-3 z-30 select-none shadow-xs transition-colors">
      {/* Left: Back to Library ("< Notes") / Title / Undo / Redo */}
      <div className="flex items-center space-x-2">
        <button
          onClick={onBackToLibrary}
          className="flex items-center space-x-1 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 px-2 py-1 rounded-xl text-xs font-semibold transition"
          title="Back to all notes"
        >
          <ChevronLeft className="w-4 h-4" />
          <span>Notes</span>
        </button>

        <div className="h-4 w-[1px] bg-gray-300 dark:bg-gray-700 mx-0.5" />

        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="font-semibold text-sm bg-transparent border-none focus:outline-none focus:ring-1 focus:ring-blue-500 rounded px-1.5 py-0.5 max-w-[140px] sm:max-w-xs text-gray-900 dark:text-gray-100 truncate"
        />

        <div className="h-4 w-[1px] bg-gray-300 dark:bg-gray-700 mx-0.5" />

        <button
          onClick={onUndo}
          disabled={!canUndo}
          className={`p-1.5 rounded-lg transition ${
            canUndo
              ? 'text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800'
              : 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
          }`}
          title="Undo (Ctrl+Z)"
        >
          <Undo2 className="w-4 h-4" />
        </button>

        <button
          onClick={onRedo}
          disabled={!canRedo}
          className={`p-1.5 rounded-lg transition ${
            canRedo
              ? 'text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800'
              : 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
          }`}
          title="Redo (Ctrl+Y)"
        >
          <Redo2 className="w-4 h-4" />
        </button>
      </div>

      {/* Center: The Iconic Notability Tool Shelf */}
      <div className="flex items-center bg-gray-100 dark:bg-[#2C2C2E] p-1 rounded-2xl shadow-inner border border-gray-200/50 dark:border-gray-700/50 space-x-1">
        {/* Text Tool */}
        <button
          onClick={() => {
            setActiveTool('text');
            setShowPenMenu(false);
            setShowHighlighterMenu(false);
          }}
          className={`p-2 rounded-xl transition ${
            activeTool === 'text'
              ? 'bg-white dark:bg-[#3A3A3C] text-blue-600 dark:text-blue-400 shadow-xs'
              : 'text-gray-600 dark:text-gray-300 hover:bg-gray-200/50 dark:hover:bg-gray-700/50'
          }`}
          title="Text Tool"
        >
          <Type className="w-4 h-4" />
        </button>

        {/* Pen Tool */}
        <div className="relative">
          <button
            onClick={() => {
              if (activeTool === 'pen') {
                setShowPenMenu(!showPenMenu);
              } else {
                setActiveTool('pen');
                setShowPenMenu(false);
              }
              setShowHighlighterMenu(false);
            }}
            className={`p-2 rounded-xl flex items-center space-x-1 transition ${
              activeTool === 'pen'
                ? 'bg-white dark:bg-[#3A3A3C] text-blue-600 dark:text-blue-400 shadow-xs'
                : 'text-gray-600 dark:text-gray-300 hover:bg-gray-200/50 dark:hover:bg-gray-700/50'
            }`}
            title="Pen Tool (Click again for colors/size)"
          >
            <Edit3 className="w-4 h-4" />
            <span
              className="w-2.5 h-2.5 rounded-full border border-gray-300"
              style={{ backgroundColor: penColor }}
            />
          </button>

          {showPenMenu && (
            <div className="absolute top-12 left-0 bg-white dark:bg-[#2C2C2E] rounded-2xl p-3 shadow-xl border border-gray-200 dark:border-gray-700 z-50 w-56 animate-in fade-in duration-100">
              <div className="text-[10px] font-bold text-gray-400 uppercase mb-2">STROKE WIDTH</div>
              <div className="flex justify-between items-center mb-3 px-1">
                {[1.5, 3, 5, 8].map((w) => (
                  <button
                    key={w}
                    onClick={() => setPenWidth(w)}
                    className={`w-8 h-8 rounded-full flex items-center justify-center border ${
                      penWidth === w ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30' : 'border-transparent'
                    }`}
                  >
                    <div
                      className="rounded-full bg-gray-900 dark:bg-gray-100"
                      style={{ width: `${w * 1.8}px`, height: `${w * 1.8}px` }}
                    />
                  </button>
                ))}
              </div>

              <div className="text-[10px] font-bold text-gray-400 uppercase mb-2">COLOR PALETTE</div>
              <div className="grid grid-cols-4 gap-2">
                {PEN_COLORS.map((col) => (
                  <button
                    key={col}
                    onClick={() => {
                      setPenColor(col);
                      setShowPenMenu(false);
                    }}
                    className={`w-7 h-7 rounded-full border-2 transition ${
                      penColor === col ? 'border-blue-500 scale-110' : 'border-transparent'
                    }`}
                    style={{ backgroundColor: col }}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Highlighter Tool */}
        <div className="relative">
          <button
            onClick={() => {
              if (activeTool === 'highlighter') {
                setShowHighlighterMenu(!showHighlighterMenu);
              } else {
                setActiveTool('highlighter');
                setShowHighlighterMenu(false);
              }
              setShowPenMenu(false);
            }}
            className={`p-2 rounded-xl flex items-center space-x-1 transition ${
              activeTool === 'highlighter'
                ? 'bg-white dark:bg-[#3A3A3C] text-blue-600 dark:text-blue-400 shadow-xs'
                : 'text-gray-600 dark:text-gray-300 hover:bg-gray-200/50 dark:hover:bg-gray-700/50'
            }`}
            title="Highlighter"
          >
            <Highlighter className="w-4 h-4" />
            <span
              className="w-2.5 h-2.5 rounded-full border border-gray-300"
              style={{ backgroundColor: highlighterColor }}
            />
          </button>

          {showHighlighterMenu && (
            <div className="absolute top-12 left-0 bg-white dark:bg-[#2C2C2E] rounded-2xl p-3 shadow-xl border border-gray-200 dark:border-gray-700 z-50 w-48 animate-in fade-in duration-100">
              <div className="text-[10px] font-bold text-gray-400 uppercase mb-2">HIGHLIGHTER COLOR</div>
              <div className="grid grid-cols-3 gap-2">
                {HIGHLIGHTER_COLORS.map((col) => (
                  <button
                    key={col}
                    onClick={() => {
                      setHighlighterColor(col);
                      setShowHighlighterMenu(false);
                    }}
                    className={`w-8 h-8 rounded-full border-2 transition ${
                      highlighterColor === col ? 'border-blue-500 scale-110' : 'border-transparent'
                    }`}
                    style={{ backgroundColor: col }}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Eraser Tool */}
        <button
          onClick={() => {
            setActiveTool('eraser');
            setShowPenMenu(false);
            setShowHighlighterMenu(false);
          }}
          className={`p-2 rounded-xl transition ${
            activeTool === 'eraser'
              ? 'bg-white dark:bg-[#3A3A3C] text-blue-600 dark:text-blue-400 shadow-xs'
              : 'text-gray-600 dark:text-gray-300 hover:bg-gray-200/50 dark:hover:bg-gray-700/50'
          }`}
          title="Stroke Eraser"
        >
          <Eraser className="w-4 h-4" />
        </button>

        {/* Lasso Tool */}
        <button
          onClick={() => {
            setActiveTool('lasso');
            setShowPenMenu(false);
            setShowHighlighterMenu(false);
          }}
          className={`p-2 rounded-xl transition ${
            activeTool === 'lasso'
              ? 'bg-white dark:bg-[#3A3A3C] text-blue-600 dark:text-blue-400 shadow-xs'
              : 'text-gray-600 dark:text-gray-300 hover:bg-gray-200/50 dark:hover:bg-gray-700/50'
          }`}
          title="Lasso Selection & LaTeX/TikZ OCR"
        >
          <Scissors className="w-4 h-4" />
        </button>

        {/* Audio Recording */}
        <button
          onClick={() => setIsRecording(!isRecording)}
          className={`px-2.5 py-1.5 rounded-xl flex items-center space-x-1.5 transition text-xs font-medium ${
            isRecording
              ? 'bg-red-500 text-white animate-pulse'
              : 'text-gray-600 dark:text-gray-300 hover:bg-gray-200/50 dark:hover:bg-gray-700/50'
          }`}
          title="Audio Sync Recording"
        >
          {isRecording ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
          <span className="hidden sm:inline">{isRecording ? '00:14' : 'Audio'}</span>
        </button>
      </div>

      {/* Right: Palm Rejection Toggle, Notes2LaTeX, Templates, Pages, Export */}
      <div className="flex items-center space-x-2">
        {/* Palm Rejection / Stylus-Only Mode Toggle */}
        <button
          onClick={() => setStylusOnlyMode(!stylusOnlyMode)}
          className={`flex items-center space-x-1.5 px-2.5 py-1.5 rounded-xl text-xs font-semibold transition border ${
            stylusOnlyMode
              ? 'bg-blue-50 dark:bg-blue-900/40 border-blue-400 text-blue-600 dark:text-blue-300'
              : 'bg-gray-100 dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400'
          }`}
          title={stylusOnlyMode ? 'Stylus Only Mode (Palm Rejection Active)' : 'Hand + Stylus Mode (Write with finger enabled)'}
        >
          {stylusOnlyMode ? <PenLine className="w-3.5 h-3.5 text-blue-500" /> : <Hand className="w-3.5 h-3.5 text-gray-400" />}
          <span className="hidden lg:inline">{stylusOnlyMode ? 'Stylus Only' : 'Finger Writing'}</span>
        </button>

        {/* Convert Full Page Button */}
        <button
          onClick={onConvertFullPageToLatex}
          className="flex items-center space-x-1.5 bg-gradient-to-r from-blue-600 to-indigo-600 text-white px-3 py-1.5 rounded-xl text-xs font-semibold shadow-xs hover:opacity-90 transition active:scale-95"
          title="Convert entire note to LaTeX"
        >
          <Sparkles className="w-3.5 h-3.5" />
          <span className="hidden md:inline">Notes2LaTeX</span>
        </button>

        {/* Paper Template Selector */}
        <div className="relative">
          <button
            onClick={() => setShowPaperMenu(!showPaperMenu)}
            className="p-2 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition"
            title="Paper Templates"
          >
            <Grid className="w-4 h-4" />
          </button>

          {showPaperMenu && (
            <div className="absolute top-12 right-0 bg-white dark:bg-[#2C2C2E] rounded-2xl p-3 shadow-xl border border-gray-200 dark:border-gray-700 z-50 w-52 animate-in fade-in duration-100">
              <div className="text-[10px] font-bold text-gray-400 uppercase mb-2">PAPER PATTERN</div>
              <div className="grid grid-cols-2 gap-2 mb-3">
                {(['blank', 'ruled', 'grid', 'dots'] as PaperStyle[]).map((style) => (
                  <button
                    key={style}
                    onClick={() => {
                      setPaperStyle(style);
                      setShowPaperMenu(false);
                    }}
                    className={`px-2 py-1.5 rounded-lg text-xs capitalize border ${
                      paperStyle === style ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30 text-blue-600' : 'border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300'
                    }`}
                  >
                    {style}
                  </button>
                ))}
              </div>

              <div className="text-[10px] font-bold text-gray-400 uppercase mb-2">PAPER THEME</div>
              <div className="flex space-x-2">
                {[
                  { id: 'white', color: '#FFFFFF', name: 'White' },
                  { id: 'cream', color: '#FDFBF7', name: 'Cream' },
                  { id: 'yellow', color: '#FEF9C3', name: 'Pastel' },
                  { id: 'dark', color: '#18181B', name: 'Dark' },
                ].map((item) => (
                  <button
                    key={item.id}
                    onClick={() => {
                      setPaperColor(item.id as PaperColor);
                      setShowPaperMenu(false);
                    }}
                    className={`w-7 h-7 rounded-full border-2 ${
                      paperColor === item.id ? 'border-blue-500 scale-110' : 'border-gray-300'
                    }`}
                    style={{ backgroundColor: item.color }}
                    title={item.name}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Page Nav */}
        <div className="flex items-center text-xs font-medium text-gray-500 bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded-lg">
          <span>{currentPage}/{totalPages}</span>
          <button
            onClick={onAddPage}
            className="ml-1.5 text-gray-700 dark:text-gray-200 hover:text-blue-600"
            title="Add Page"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Export / Share */}
        <button
          onClick={onOpenExport}
          className="p-2 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition"
          title="Export Note (PDF, LaTeX, TikZ)"
        >
          <Share className="w-4 h-4" />
        </button>

        {/* Settings */}
        <button
          onClick={onOpenSettings}
          className="p-2 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition"
          title="Settings"
        >
          <Settings className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
};
