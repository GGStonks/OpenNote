import React, { useRef, useState } from 'react';
import {
  ChevronLeft,
  Undo2,
  Redo2,
  Sparkles,
  LayoutTemplate,
  PanelLeft,
  MoreHorizontal,
  Share,
  Settings,
  Image as ImageIcon,
  Sigma,
  FileText,
  ClipboardPaste,
  Bookmark,
  Copy,
  Trash2,
  Monitor,
} from 'lucide-react';
import { StudioButton } from './StudioButton';
import { StudioPopover } from './StudioPopover';
import { PaperPicker, PaperValues } from '../PaperPicker';
import { SetupPatch } from '../../editor/pageSetup';

export interface EditorMastheadProps {
  title: string;
  setTitle: (t: string) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onBack: () => void;
  paper: PaperValues;
  setPaper: (patch: SetupPatch) => void;
  pagesOpen: boolean;
  onTogglePages: () => void;
  onConvertPage: () => void;
  onExport: () => void;
  onSettings: () => void;
  onDuplicatePage: () => void;
  pageBookmarked: boolean;
  onToggleBookmark: () => void;
  onDeletePage: () => void;
  onInsertLatex: () => void;
  onInsertImage: (file: File) => void;
  onInsertPdf: (file: File) => void;
  onPaste?: () => void;
  currentPage: number;
  totalPages: number;
  audioSlot: React.ReactNode;
  onOpenMirror?: () => void;
  isMirrorActive?: boolean;
}

export const EditorMasthead: React.FC<EditorMastheadProps> = (p) => {
  const [paperOpen, setPaperOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);

  return (
    <header
      data-cutout-clear
      data-cutout-bar
      className="relative z-30 bg-white/90 dark:bg-ui-panel/90 backdrop-blur-xl border-b border-black/5 dark:border-white/10 select-none pt-[var(--sa-top)] px-[calc(0.75rem+var(--sa-left))] pr-[calc(0.75rem+var(--sa-right))]"
    >
      <div className="flex items-center justify-between h-14 gap-2">
        {/* Left cluster: Back navigation, title, undo/redo */}
        <div className="flex items-center gap-1.5 sm:gap-2 min-w-0 flex-1">
          <StudioButton
            size="sm"
            variant="ghost"
            onClick={p.onBack}
            className="flex-shrink-0 text-studio-accent font-semibold px-2"
            title="Return to library"
          >
            <ChevronLeft className="w-5 h-5 -ml-1" />
            <span className="hidden sm:inline">Notes</span>
          </StudioButton>

          <StudioButton
            size="icon-sm"
            variant="ghost"
            active={p.pagesOpen}
            onClick={p.onTogglePages}
            className="flex-shrink-0"
            title="Toggle pages tray"
          >
            <PanelLeft className="w-4 h-4" />
          </StudioButton>

          <div className="flex-1 min-w-0 max-w-xs px-1">
            <input
              data-cutout-item
              value={p.title}
              onChange={(e) => p.setTitle(e.target.value)}
              placeholder="Note title"
              className="w-full bg-transparent font-serif font-bold text-base sm:text-lg text-gray-900 dark:text-gray-100 truncate focus:outline-none focus:ring-1 focus:ring-studio-accent/40 rounded px-1.5 py-0.5 select-text"
            />
          </div>

          <div className="flex items-center gap-0.5">
            <StudioButton
              size="icon-sm"
              variant="ghost"
              disabled={!p.canUndo}
              onClick={p.onUndo}
              title="Undo (2-finger tap)"
            >
              <Undo2 className="w-4 h-4" />
            </StudioButton>
            <StudioButton
              size="icon-sm"
              variant="ghost"
              disabled={!p.canRedo}
              onClick={p.onRedo}
              title="Redo (3-finger tap)"
            >
              <Redo2 className="w-4 h-4" />
            </StudioButton>
          </div>
        </div>

        {/* Center: Audio Recorder Slot */}
        <div className="hidden md:flex items-center justify-center flex-shrink-0">
          {p.audioSlot}
        </div>

        {/* Right cluster: AI Transcribe, Paper, More Studio Actions */}
        <div className="flex items-center gap-1 sm:gap-1.5 flex-shrink-0">
          <div className="md:hidden">{p.audioSlot}</div>

          <StudioButton
            size="sm"
            variant="primary"
            onClick={p.onConvertPage}
            className="hidden sm:inline-flex bg-gradient-to-r from-blue-600 to-indigo-600 shadow-md shadow-blue-600/25 text-xs font-semibold px-3"
            title="Transcribe current page with Qwen3-VL"
          >
            <Sparkles className="w-3.5 h-3.5 mr-1" />
            <span>AI LaTeX</span>
          </StudioButton>

          {/* Paper Settings */}
          <div className="relative">
            <StudioButton
              size="icon-sm"
              variant="ghost"
              active={paperOpen}
              onClick={() => {
                setMoreOpen(false);
                setPaperOpen((v) => !v);
              }}
              title="Page paper style & grid"
            >
              <LayoutTemplate className="w-4 h-4" />
            </StudioButton>

            <StudioPopover
              isOpen={paperOpen}
              onClose={() => setPaperOpen(false)}
              align="right"
              className="w-84"
            >
              <div className="text-xs text-gray-500 dark:text-gray-400 mb-2 leading-relaxed">
                Default paper for new pages and uncustomized pages.
              </div>
              <PaperPicker value={p.paper} onChange={p.setPaper} />
            </StudioPopover>
          </div>

          {/* Screen Cast / Mirror */}
          {p.onOpenMirror && (
            <StudioButton
              size="icon-sm"
              variant="ghost"
              active={p.isMirrorActive}
              onClick={p.onOpenMirror}
              className={p.isMirrorActive ? 'text-studio-accent animate-pulse' : ''}
              title={p.isMirrorActive ? 'Screen Cast Active' : 'Screen Cast to PC (Rust Mirror)'}
            >
              <Monitor className="w-4 h-4" />
            </StudioButton>
          )}

          {/* Export Studio */}
          <StudioButton
            size="icon-sm"
            variant="ghost"
            onClick={p.onExport}
            title="Export note"
          >
            <Share className="w-4 h-4" />
          </StudioButton>

          {/* Settings Modal Trigger */}
          <StudioButton
            size="icon-sm"
            variant="ghost"
            onClick={p.onSettings}
            title="Studio settings"
          >
            <Settings className="w-4 h-4" />
          </StudioButton>

          {/* Studio Overflow Menu */}
          <div className="relative">
            <StudioButton
              size="icon-sm"
              variant="ghost"
              active={moreOpen}
              onClick={() => {
                setPaperOpen(false);
                setMoreOpen((v) => !v);
              }}
              title="More actions"
            >
              <MoreHorizontal className="w-4 h-4" />
            </StudioButton>

            <StudioPopover
              isOpen={moreOpen}
              onClose={() => setMoreOpen(false)}
              align="right"
              className="w-64 p-2"
            >
              <div className="space-y-0.5 text-xs">
                <button
                  type="button"
                  onClick={() => {
                    setMoreOpen(false);
                    p.onConvertPage();
                  }}
                  className="sm:hidden w-full px-3 py-2.5 rounded-xl flex items-center gap-2.5 text-left hover:bg-black/5 dark:hover:bg-white/5 font-semibold text-studio-accent"
                >
                  <Sparkles className="w-4 h-4" /> Transcribe Page → LaTeX
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setMoreOpen(false);
                    p.onInsertLatex();
                  }}
                  className="w-full px-3 py-2 rounded-xl flex items-center gap-2.5 text-left hover:bg-black/5 dark:hover:bg-white/5 text-gray-700 dark:text-gray-200"
                >
                  <Sigma className="w-4 h-4 text-gray-400" /> Insert LaTeX / TikZ
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setMoreOpen(false);
                    imageInputRef.current?.click();
                  }}
                  className="w-full px-3 py-2 rounded-xl flex items-center gap-2.5 text-left hover:bg-black/5 dark:hover:bg-white/5 text-gray-700 dark:text-gray-200"
                >
                  <ImageIcon className="w-4 h-4 text-gray-400" /> Insert Image
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setMoreOpen(false);
                    pdfInputRef.current?.click();
                  }}
                  className="w-full px-3 py-2 rounded-xl flex items-center gap-2.5 text-left hover:bg-black/5 dark:hover:bg-white/5 text-gray-700 dark:text-gray-200"
                >
                  <FileText className="w-4 h-4 text-gray-400" /> Insert PDF after page
                </button>

                {p.onPaste && (
                  <button
                    type="button"
                    onClick={() => {
                      setMoreOpen(false);
                      p.onPaste?.();
                    }}
                    className="w-full px-3 py-2 rounded-xl flex items-center gap-2.5 text-left hover:bg-black/5 dark:hover:bg-white/5 text-gray-700 dark:text-gray-200"
                  >
                    <ClipboardPaste className="w-4 h-4 text-gray-400" /> Paste clipboard
                  </button>
                )}

                <div className="w-full h-px bg-black/5 dark:border-white/5 my-1" />

                <button
                  type="button"
                  onClick={() => {
                    setMoreOpen(false);
                    p.onToggleBookmark();
                  }}
                  className="w-full px-3 py-2 rounded-xl flex items-center gap-2.5 text-left hover:bg-black/5 dark:hover:bg-white/5 text-gray-700 dark:text-gray-200"
                >
                  <Bookmark
                    className="w-4 h-4 text-gray-400"
                    fill={p.pageBookmarked ? 'currentColor' : 'none'}
                  />
                  <span>{p.pageBookmarked ? 'Remove Bookmark' : 'Bookmark Page'}</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setMoreOpen(false);
                    p.onDuplicatePage();
                  }}
                  className="w-full px-3 py-2 rounded-xl flex items-center gap-2.5 text-left hover:bg-black/5 dark:hover:bg-white/5 text-gray-700 dark:text-gray-200"
                >
                  <Copy className="w-4 h-4 text-gray-400" /> Duplicate Page
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setMoreOpen(false);
                    p.onDeletePage();
                  }}
                  className="w-full px-3 py-2 rounded-xl flex items-center gap-2.5 text-left hover:bg-red-500/10 text-red-600 dark:text-red-400 font-medium"
                >
                  <Trash2 className="w-4 h-4" /> Delete Page
                </button>

                <div className="pt-1.5 px-3 text-[11px] text-gray-400 tabular-nums">
                  Page {p.currentPage} of {p.totalPages}
                </div>
              </div>
            </StudioPopover>
          </div>

          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) p.onInsertImage(f);
              e.target.value = '';
            }}
          />
          <input
            ref={pdfInputRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) p.onInsertPdf(f);
              e.target.value = '';
            }}
          />
        </div>
      </div>
    </header>
  );
};
