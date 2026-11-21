import React, { useEffect, useRef, useState } from 'react';
import {
  Search, PenLine, Spline, Highlighter, Eraser, Lasso, Type, Hand, Pointer,
  FileDown, Plus, Moon, Sun, Monitor, Sparkles, Maximize, LayoutTemplate,
  Sigma, Image, ArrowRight, Eye,
} from 'lucide-react';
import { ToolType } from '../types';

export interface CommandItem {
  id: string;
  title: string;
  category: 'Tools' | 'Canvas' | 'Paper' | 'Actions';
  icon: React.ReactNode;
  shortcut?: string;
  action: () => void;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectTool: (tool: ToolType) => void;
  onAddPage: () => void;
  onZoomFit: () => void;
  onToggleTheme: () => void;
  isDarkTheme: boolean;
  onOpenMirror: () => void;
  onExportPdf: () => void;
  onConvertAi: () => void;
  onInsertLatex: () => void;
  onInsertImage: () => void;
  onToggleZen: () => void;
  onOpenPaper: () => void;
}

export const CommandPalette: React.FC<CommandPaletteProps> = (p) => {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands: CommandItem[] = [
    // Tools
    { id: 'tool-pen', title: 'Switch to Pen', category: 'Tools', icon: <PenLine className="w-4 h-4" strokeWidth={1.75} />, shortcut: '1', action: () => { p.onSelectTool('pen'); p.onClose(); } },
    { id: 'tool-shape', title: 'Switch to Smart Pen (Shapes)', category: 'Tools', icon: <Spline className="w-4 h-4" strokeWidth={1.75} />, shortcut: '7', action: () => { p.onSelectTool('shape'); p.onClose(); } },
    { id: 'tool-hl', title: 'Switch to Highlighter', category: 'Tools', icon: <Highlighter className="w-4 h-4" strokeWidth={1.75} />, shortcut: '2', action: () => { p.onSelectTool('highlighter'); p.onClose(); } },
    { id: 'tool-eraser', title: 'Switch to Eraser', category: 'Tools', icon: <Eraser className="w-4 h-4" strokeWidth={1.75} />, shortcut: '3', action: () => { p.onSelectTool('eraser'); p.onClose(); } },
    { id: 'tool-lasso', title: 'Switch to Lasso', category: 'Tools', icon: <Lasso className="w-4 h-4" strokeWidth={1.75} />, shortcut: '4', action: () => { p.onSelectTool('lasso'); p.onClose(); } },
    { id: 'tool-text', title: 'Switch to Text', category: 'Tools', icon: <Type className="w-4 h-4" strokeWidth={1.75} />, shortcut: '5', action: () => { p.onSelectTool('text'); p.onClose(); } },
    { id: 'tool-hand', title: 'Switch to Hand (Scroll)', category: 'Tools', icon: <Hand className="w-4 h-4" strokeWidth={1.75} />, shortcut: '6', action: () => { p.onSelectTool('hand'); p.onClose(); } },

    // Canvas
    { id: 'canvas-zoom-fit', title: 'Zoom to Fit Page', category: 'Canvas', icon: <Maximize className="w-4 h-4" strokeWidth={1.75} />, shortcut: '⌘0', action: () => { p.onZoomFit(); p.onClose(); } },
    { id: 'canvas-new-page', title: 'Add New Page', category: 'Canvas', icon: <Plus className="w-4 h-4" strokeWidth={1.75} />, shortcut: '⌘N', action: () => { p.onAddPage(); p.onClose(); } },
    { id: 'canvas-zen', title: 'Toggle Zen Mode (Focus)', category: 'Canvas', icon: <Eye className="w-4 h-4" strokeWidth={1.75} />, shortcut: 'Tab', action: () => { p.onToggleZen(); p.onClose(); } },

    // Paper & Theme
    { id: 'paper-settings', title: 'Change Paper Template & Grid', category: 'Paper', icon: <LayoutTemplate className="w-4 h-4" strokeWidth={1.75} />, action: () => { p.onOpenPaper(); p.onClose(); } },
    { id: 'toggle-theme', title: p.isDarkTheme ? 'Switch to Light Theme' : 'Switch to Dark Theme', category: 'Paper', icon: p.isDarkTheme ? <Sun className="w-4 h-4" strokeWidth={1.75} /> : <Moon className="w-4 h-4" strokeWidth={1.75} />, action: () => { p.onToggleTheme(); p.onClose(); } },

    // Actions
    { id: 'action-mirror', title: 'Cast Note to PC (Rust Mirror)', category: 'Actions', icon: <Monitor className="w-4 h-4" strokeWidth={1.75} />, action: () => { p.onOpenMirror(); p.onClose(); } },
    { id: 'action-export-pdf', title: 'Export Note as PDF', category: 'Actions', icon: <FileDown className="w-4 h-4" strokeWidth={1.75} />, shortcut: '⌘E', action: () => { p.onExportPdf(); p.onClose(); } },
    { id: 'action-ai', title: 'AI Transcribe Page → LaTeX / TikZ', category: 'Actions', icon: <Sparkles className="w-4 h-4 text-blue-500" strokeWidth={1.75} />, action: () => { p.onConvertAi(); p.onClose(); } },
    { id: 'action-insert-latex', title: 'Insert LaTeX / TikZ Block', category: 'Actions', icon: <Sigma className="w-4 h-4" strokeWidth={1.75} />, action: () => { p.onInsertLatex(); p.onClose(); } },
    { id: 'action-insert-img', title: 'Insert Image', category: 'Actions', icon: <Image className="w-4 h-4" strokeWidth={1.75} />, action: () => { p.onInsertImage(); p.onClose(); } },
  ];

  const filtered = commands.filter((cmd) => {
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return cmd.title.toLowerCase().includes(q) || cmd.category.toLowerCase().includes(q);
  });

  useEffect(() => {
    if (p.isOpen) {
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [p.isOpen]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => (i + 1) % Math.max(1, filtered.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => (i - 1 + filtered.length) % Math.max(1, filtered.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[selectedIndex]) {
        filtered[selectedIndex].action();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      p.onClose();
    }
  };

  if (!p.isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[10001] bg-black/45 backdrop-blur-md flex items-start justify-center pt-[15vh] px-4 select-none"
      onClick={p.onClose}
      data-no-pan
    >
      <div
        className="glass-pill rounded-3xl w-full max-w-lg overflow-hidden pop-enter flex flex-col shadow-2xl border border-gray-200/70 dark:border-white/10 text-gray-900 dark:text-gray-100"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Search header */}
        <div className="flex items-center gap-3 px-4 py-3.5 border-b border-gray-200/50 dark:border-white/10">
          <Search className="w-5 h-5 text-gray-400 flex-shrink-0" strokeWidth={1.75} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a command or search action (e.g. pen, export, dark, mirror)..."
            className="flex-1 bg-transparent text-sm sm:text-base outline-none text-gray-900 dark:text-gray-100 placeholder:text-gray-400 select-text"
          />
          <kbd className="hidden sm:inline-block px-2 py-0.5 text-[11px] font-mono font-medium rounded-md bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-white/10">
            ESC
          </kbd>
        </div>

        {/* Command list */}
        <div className="max-h-[50vh] overflow-y-auto p-2 no-scrollbar">
          {filtered.length === 0 ? (
            <div className="py-8 text-center text-sm text-gray-400">
              No matching commands
            </div>
          ) : (
            filtered.map((cmd, idx) => {
              const active = idx === selectedIndex;
              return (
                <button
                  key={cmd.id}
                  onClick={cmd.action}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-2xl text-sm font-medium transition-all text-left ${
                    active
                      ? 'bg-blue-600 text-white shadow-md shadow-blue-600/25'
                      : 'hover:bg-black/5 dark:hover:bg-white/10 text-gray-700 dark:text-gray-200'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className={`p-1.5 rounded-xl ${active ? 'bg-white/20 text-white' : 'bg-gray-100 dark:bg-white/5 text-gray-600 dark:text-gray-300'}`}>
                      {cmd.icon}
                    </span>
                    <span className="truncate">{cmd.title}</span>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {cmd.shortcut && (
                      <kbd className={`px-2 py-0.5 text-[11px] font-mono rounded-md border ${
                        active
                          ? 'bg-white/20 text-white border-white/20'
                          : 'bg-gray-100 dark:bg-white/5 text-gray-400 border-gray-200 dark:border-white/10'
                      }`}>
                        {cmd.shortcut}
                      </kbd>
                    )}
                    {active && <ArrowRight className="w-4 h-4 opacity-75" strokeWidth={1.75} />}
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
