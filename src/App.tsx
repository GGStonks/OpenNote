import React, { useState, useEffect } from 'react';
import { Toolbar } from './components/Toolbar';
import { CanvasPage } from './components/CanvasPage';
import { LibraryView } from './components/LibraryView';
import { LatexModal } from './components/LatexModal';
import { ExportModal } from './components/ExportModal';
import { SettingsModal } from './components/SettingsModal';
import {
  ToolType, PaperStyle, PaperColor, NoteDocument, NotePage, Stroke, LatexBlock, Subject
} from './types';
import { convertHandwritingToLatex } from './services/latexService';
import {
  getAllNotes, getNoteById, saveNote, deleteNote, getAllSubjects, saveSubjects, DEFAULT_SUBJECTS
} from './storage/db';
import { Loader2 } from 'lucide-react';

export const App: React.FC = () => {
  // Navigation View: 'library' (Home screen) vs 'editor' (Note canvas)
  const [currentView, setCurrentView] = useState<'library' | 'editor'>('library');

  // Multi-Note State
  const [notes, setNotes] = useState<NoteDocument[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>(DEFAULT_SUBJECTS);
  const [selectedSubjectId, setSelectedSubjectId] = useState<string | null>(null);
  const [currentNote, setCurrentNote] = useState<NoteDocument | null>(null);

  // Undo / Redo History Stack for Current Note
  const [history, setHistory] = useState<NoteDocument[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);

  // Active Tool Configuration
  const [activeTool, setActiveTool] = useState<ToolType>('pen');
  const [penColor, setPenColor] = useState<string>('#000000');
  const [penWidth, setPenWidth] = useState<number>(3);
  const [highlighterColor, setHighlighterColor] = useState<string>('#FDE047');

  // Palm Rejection / Stylus-Only Mode
  const [stylusOnlyMode, setStylusOnlyMode] = useState<boolean>(() => {
    const saved = localStorage.getItem('opennote_stylus_only');
    return saved !== null ? saved === 'true' : true;
  });

  // Modals
  const [isLatexModalOpen, setIsLatexModalOpen] = useState(false);
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);

  // VLM Settings & State
  const [vlmEndpoint, setVlmEndpoint] = useState('/v1/chat/completions');
  const [modelName, setModelName] = useState('qwen3-vl');
  const [isConverting, setIsConverting] = useState(false);
  const [conversionResult, setConversionResult] = useState<{
    latex: string;
    isTikz: boolean;
    source: 'vlm' | 'fallback';
    targetPageId?: string;
    targetBounds?: { x: number; y: number; width: number; height: number };
  } | null>(null);

  // Load Notes & Subjects on startup
  useEffect(() => {
    async function loadData() {
      const loadedNotes = await getAllNotes();
      const loadedSubjects = await getAllSubjects();
      setNotes(loadedNotes);
      setSubjects(loadedSubjects);
    }
    loadData();
  }, []);

  // Save Palm Rejection setting
  useEffect(() => {
    localStorage.setItem('opennote_stylus_only', String(stylusOnlyMode));
  }, [stylusOnlyMode]);

  // Push to Undo/Redo and Auto-Save to IndexedDB
  const updateCurrentNote = (updater: (prev: NoteDocument) => NoteDocument) => {
    if (!currentNote) return;
    const updated = updater(currentNote);
    setCurrentNote(updated);

    // Save to undo history
    const updatedHistory = history.slice(0, historyIndex + 1);
    updatedHistory.push(JSON.parse(JSON.stringify(updated)));
    setHistory(updatedHistory);
    setHistoryIndex(updatedHistory.length - 1);

    // Persist to offline DB
    saveNote(updated);

    // Update list in state
    setNotes(prev => prev.map(n => n.id === updated.id ? updated : n));
  };

  const handleUndo = () => {
    if (historyIndex > 0) {
      const prev = history[historyIndex - 1];
      const cloned = JSON.parse(JSON.stringify(prev));
      setCurrentNote(cloned);
      setHistoryIndex(historyIndex - 1);
      saveNote(cloned);
      setNotes(n => n.map(item => item.id === cloned.id ? cloned : item));
    }
  };

  const handleRedo = () => {
    if (historyIndex < history.length - 1) {
      const next = history[historyIndex + 1];
      const cloned = JSON.parse(JSON.stringify(next));
      setCurrentNote(cloned);
      setHistoryIndex(historyIndex + 1);
      saveNote(cloned);
      setNotes(n => n.map(item => item.id === cloned.id ? cloned : item));
    }
  };

  // Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (currentView !== 'editor') return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
        e.preventDefault();
        handleRedo();
      } else if (e.key === '1') setActiveTool('pen');
      else if (e.key === '2') setActiveTool('highlighter');
      else if (e.key === '3') setActiveTool('eraser');
      else if (e.key === '4') setActiveTool('lasso');
      else if (e.key === '5') setActiveTool('text');
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [historyIndex, history, currentView]);

  // Open Note from Library
  const handleOpenNote = (noteId: string) => {
    const found = notes.find(n => n.id === noteId);
    if (found) {
      setCurrentNote(found);
      setHistory([JSON.parse(JSON.stringify(found))]);
      setHistoryIndex(0);
      setCurrentView('editor');
    }
  };

  // Create New Note
  const handleCreateNote = async (subjectId?: string) => {
    const newNote: NoteDocument = {
      id: `note_${Date.now()}`,
      title: `Note - ${new Date().toLocaleDateString()}`,
      subjectId: subjectId || selectedSubjectId || undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      paperStyle: 'ruled',
      paperColor: 'white',
      pages: [
        {
          id: `page_${Date.now()}`,
          pageNumber: 1,
          strokes: [],
          latexBlocks: []
        }
      ]
    };
    await saveNote(newNote);
    setNotes(prev => [newNote, ...prev]);
    setCurrentNote(newNote);
    setHistory([JSON.parse(JSON.stringify(newNote))]);
    setHistoryIndex(0);
    setCurrentView('editor');
  };

  // Delete Note
  const handleDeleteNote = async (noteId: string) => {
    await deleteNote(noteId);
    setNotes(prev => prev.filter(n => n.id !== noteId));
    if (currentNote?.id === noteId) {
      setCurrentNote(null);
      setCurrentView('library');
    }
  };

  // Duplicate Note
  const handleDuplicateNote = async (noteId: string) => {
    const src = notes.find(n => n.id === noteId);
    if (!src) return;
    const duplicated: NoteDocument = {
      ...JSON.parse(JSON.stringify(src)),
      id: `note_${Date.now()}`,
      title: `${src.title} (Copy)`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await saveNote(duplicated);
    setNotes(prev => [duplicated, ...prev]);
  };

  // Rename Note
  const handleRenameNote = async (noteId: string, newTitle: string) => {
    const target = notes.find(n => n.id === noteId);
    if (!target) return;
    const updated = { ...target, title: newTitle, updatedAt: Date.now() };
    await saveNote(updated);
    setNotes(prev => prev.map(n => n.id === noteId ? updated : n));
    if (currentNote?.id === noteId) {
      setCurrentNote(updated);
    }
  };

  // Create Subject
  const handleCreateSubject = async (name: string, color: string) => {
    const newSubj: Subject = {
      id: `subj_${Date.now()}`,
      name,
      color
    };
    const updated = [...subjects, newSubj];
    setSubjects(updated);
    await saveSubjects(updated);
  };

  // Stroke Operations
  const handleAddStroke = (pageId: string, stroke: Stroke) => {
    updateCurrentNote(prev => ({
      ...prev,
      pages: prev.pages.map(p => p.id === pageId ? { ...p, strokes: [...p.strokes, stroke] } : p)
    }));
  };

  const handleDeleteStroke = (pageId: string, strokeId: string) => {
    updateCurrentNote(prev => ({
      ...prev,
      pages: prev.pages.map(p =>
        p.id === pageId ? { ...p, strokes: p.strokes.filter(s => s.id !== strokeId) } : p
      )
    }));
  };

  const handleUpdateStrokes = (pageId: string, updatedStrokes: Stroke[]) => {
    updateCurrentNote(prev => ({
      ...prev,
      pages: prev.pages.map(p =>
        p.id === pageId ? { ...p, strokes: updatedStrokes } : p
      )
    }));
  };

  // LaTeX & TikZ Block Operations
  const handleAddLatexBlock = (pageId: string, block: LatexBlock) => {
    updateCurrentNote(prev => ({
      ...prev,
      pages: prev.pages.map(p =>
        p.id === pageId ? { ...p, latexBlocks: [...p.latexBlocks, block] } : p
      )
    }));
  };
  const handleUpdateLatexBlock = (pageId: string, block: LatexBlock) => {
    updateCurrentNote(prev => ({
      ...prev,
      pages: prev.pages.map(p =>
        p.id === pageId
          ? { ...p, latexBlocks: p.latexBlocks.map(b => b.id === block.id ? block : b) }
          : p
      )
    }));
  };

  const handleDeleteLatexBlock = (pageId: string, blockId: string) => {
    updateCurrentNote(prev => ({
      ...prev,
      pages: prev.pages.map(p =>
        p.id === pageId
          ? { ...p, latexBlocks: p.latexBlocks.filter(b => b.id !== blockId) }
          : p
      )
    }));
  };

  // Add Page
  const handleAddPage = () => {
    updateCurrentNote(prev => {
      const newPageNumber = prev.pages.length + 1;
      const newPage: NotePage = {
        id: `page_${Date.now()}`,
        pageNumber: newPageNumber,
        strokes: [],
        latexBlocks: []
      };
      return { ...prev, pages: [...prev.pages, newPage] };
    });
  };

  // Notes2LaTeX OCR / TikZ Trigger
  const handleRegionLatexConvert = async (
    pageId: string,
    croppedImageBase64: string,
    bounds: { x: number; y: number; width: number; height: number },
    mode: 'math' | 'tikz' = 'math'
  ) => {
    setIsConverting(true);
    try {
      const result = await convertHandwritingToLatex(croppedImageBase64, mode, vlmEndpoint, modelName);
      setConversionResult({
        latex: result.latex,
        isTikz: result.isTikz,
        source: result.source,
        targetPageId: pageId,
        targetBounds: bounds
      });
      setIsLatexModalOpen(true);
    } catch (err) {
      console.error('Failed to convert handwriting/diagram:', err);
    } finally {
      setIsConverting(false);
    }
  };

  // Full Page Convert
  const handleConvertFullPage = () => {
    if (!currentNote || currentNote.pages.length === 0) return;
    const page = currentNote.pages[0];
    const dummyBounds = { x: 120, y: 150, width: 360, height: 80 };
    handleRegionLatexConvert(page.id, '', dummyBounds, 'math');
  };

  // Insert Generated Math / TikZ Vector Block into Canvas
  const handleInsertLatexIntoCanvas = (code: string, isTikz: boolean) => {
    if (!conversionResult?.targetPageId) return;

    const pageId = conversionResult.targetPageId;
    const bounds = conversionResult.targetBounds || { x: 120, y: 150, width: 300, height: 80 };

    const newBlock: LatexBlock = {
      id: `latex_${Date.now()}`,
      x: bounds.x,
      y: bounds.y,
      width: Math.max(280, bounds.width),
      height: Math.max(70, bounds.height),
      latexCode: code,
      isTikz: isTikz,
      createdAt: Date.now()
    };

    updateCurrentNote(prev => ({
      ...prev,
      pages: prev.pages.map(p =>
        p.id === pageId ? { ...p, latexBlocks: [...p.latexBlocks, newBlock] } : p
      )
    }));
  };

  return (
    <div className="h-full flex flex-col bg-[#E5E5EA] dark:bg-[#121214] text-gray-900 dark:text-gray-100 overflow-hidden font-sans">
      {currentView === 'library' || !currentNote ? (
        /* The Complete Notability Home Screen */
        <LibraryView
          notes={notes}
          subjects={subjects}
          selectedSubjectId={selectedSubjectId}
          onSelectSubject={setSelectedSubjectId}
          onOpenNote={handleOpenNote}
          onCreateNote={handleCreateNote}
          onDeleteNote={handleDeleteNote}
          onDuplicateNote={handleDuplicateNote}
          onRenameNote={handleRenameNote}
          onCreateSubject={handleCreateSubject}
          onOpenSettings={() => setIsSettingsModalOpen(true)}
        />
      ) : (
        /* The Full Note Editor View */
        <div className="h-full flex flex-col overflow-hidden">
          {/* Notability Top Toolbar */}
          <Toolbar
            activeTool={activeTool}
            setActiveTool={setActiveTool}
            penColor={penColor}
            setPenColor={setPenColor}
            penWidth={penWidth}
            setPenWidth={setPenWidth}
            highlighterColor={highlighterColor}
            setHighlighterColor={setHighlighterColor}
            stylusOnlyMode={stylusOnlyMode}
            setStylusOnlyMode={setStylusOnlyMode}
            canUndo={historyIndex > 0}
            canRedo={historyIndex < history.length - 1}
            onUndo={handleUndo}
            onRedo={handleRedo}
            title={currentNote.title}
            setTitle={(t) => updateCurrentNote(p => ({ ...p, title: t }))}
            paperStyle={currentNote.paperStyle}
            setPaperStyle={(s) => updateCurrentNote(p => ({ ...p, paperStyle: s }))}
            paperColor={currentNote.paperColor}
            setPaperColor={(c) => updateCurrentNote(p => ({ ...p, paperColor: c }))}
            onBackToLibrary={() => setCurrentView('library')}
            onConvertFullPageToLatex={handleConvertFullPage}
            onOpenExport={() => setIsExportModalOpen(true)}
            onOpenSettings={() => setIsSettingsModalOpen(true)}
            onAddPage={handleAddPage}
            currentPage={1}
            totalPages={currentNote.pages.length}
          />

          {/* Continuous Multi-Page Vertical Scroll Canvas */}
          <main className="flex-1 overflow-y-auto overflow-x-hidden p-6 flex flex-col items-center">
            {currentNote.pages.map((page) => (
              <CanvasPage
                key={page.id}
                pageId={page.id}
                pageNumber={page.pageNumber}
                strokes={page.strokes}
                latexBlocks={page.latexBlocks}
                activeTool={activeTool}
                penColor={penColor}
                penWidth={penWidth}
                highlighterColor={highlighterColor}
                paperStyle={currentNote.paperStyle}
                paperColor={currentNote.paperColor}
                stylusOnlyMode={stylusOnlyMode}
                onAddStroke={(stroke) => handleAddStroke(page.id, stroke)}
                onDeleteStroke={(strokeId) => handleDeleteStroke(page.id, strokeId)}
                onUpdateStrokes={(updated) => handleUpdateStrokes(page.id, updated)}
                onAddLatexBlock={(block) => handleAddLatexBlock(page.id, block)}
                onUpdateLatexBlock={(block) => handleUpdateLatexBlock(page.id, block)}
                onDeleteLatexBlock={(blockId) => handleDeleteLatexBlock(page.id, blockId)}
                onTriggerRegionLatexConvert={(img, bounds, mode) =>
                  handleRegionLatexConvert(page.id, img, bounds, mode)
                }
              />
            ))}

            {/* Add Page Footer Button */}
            <button
              onClick={handleAddPage}
              className="mb-12 px-6 py-2.5 bg-white dark:bg-[#1C1C1E] border border-gray-300 dark:border-gray-700 rounded-full text-xs font-semibold shadow-xs hover:shadow-md transition text-gray-700 dark:text-gray-300 hover:text-blue-600"
            >
              + Add New Page
            </button>
          </main>
        </div>
      )}

      {/* Converting / Loading Spinner Overlay */}
      {isConverting && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-xs z-50 flex flex-col items-center justify-center text-white">
          <div className="bg-white/95 dark:bg-[#1C1C1E]/95 p-6 rounded-3xl shadow-2xl flex flex-col items-center text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-gray-800">
            <Loader2 className="w-8 h-8 text-blue-600 animate-spin mb-3" />
            <div className="font-bold text-sm">Transcribing with Qwen3-VL...</div>
            <div className="text-xs text-gray-400 mt-1">Generating compiled LaTeX & TikZ vectors</div>
          </div>
        </div>
      )}

      {/* Modals */}
      <LatexModal
        isOpen={isLatexModalOpen}
        onClose={() => setIsLatexModalOpen(false)}
        initialLatex={conversionResult?.latex || ''}
        isTikz={conversionResult?.isTikz || false}
        source={conversionResult?.source || 'vlm'}
        onInsertIntoCanvas={handleInsertLatexIntoCanvas}
      />

      {currentNote && (
        <ExportModal
          isOpen={isExportModalOpen}
          onClose={() => setIsExportModalOpen(false)}
          document={currentNote}
        />
      )}

      <SettingsModal
        isOpen={isSettingsModalOpen}
        onClose={() => setIsSettingsModalOpen(false)}
        vlmEndpoint={vlmEndpoint}
        setVlmEndpoint={setVlmEndpoint}
        modelName={modelName}
        setModelName={setModelName}
      />
    </div>
  );
};
