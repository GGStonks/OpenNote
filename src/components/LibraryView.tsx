import React, { useState } from 'react';
import {
  FileText, Plus, Search, Folder, MoreVertical, Trash2, Edit2,
  Calendar, Layers, Sparkles, BookOpen, Clock, Settings as SettingsIcon,
  Grid as GridIcon, List as ListIcon, Check, Copy
} from 'lucide-react';
import { NoteDocument, Subject } from '../types';

interface LibraryViewProps {
  notes: NoteDocument[];
  subjects: Subject[];
  selectedSubjectId: string | null;
  onSelectSubject: (subjectId: string | null) => void;
  onOpenNote: (noteId: string) => void;
  onCreateNote: (subjectId?: string) => void;
  onDeleteNote: (noteId: string) => void;
  onDuplicateNote: (noteId: string) => void;
  onRenameNote: (noteId: string, newTitle: string) => void;
  onCreateSubject: (name: string, color: string) => void;
  onOpenSettings: () => void;
}

export const LibraryView: React.FC<LibraryViewProps> = ({
  notes,
  subjects,
  selectedSubjectId,
  onSelectSubject,
  onOpenNote,
  onCreateNote,
  onDeleteNote,
  onDuplicateNote,
  onRenameNote,
  onCreateSubject,
  onOpenSettings,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [newSubjectName, setNewSubjectName] = useState('');
  const [isAddingSubject, setIsAddingSubject] = useState(false);
  const [activeMenuNoteId, setActiveMenuNoteId] = useState<string | null>(null);
  const [renamingNoteId, setRenamingNoteId] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState('');

  // Filter notes by search and subject
  const filteredNotes = notes.filter((n) => {
    const matchesSearch = n.title.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesSubject =
      selectedSubjectId === null ||
      (selectedSubjectId === 'all' ? true : n.subjectId === selectedSubjectId);
    return matchesSearch && matchesSubject;
  });

  const currentSubject = subjects.find((s) => s.id === selectedSubjectId);
  const subjectTitle =
    selectedSubjectId === null || selectedSubjectId === 'all'
      ? 'All Notes'
      : currentSubject?.name || 'Notes';

  const handleAddSubject = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSubjectName.trim()) return;
    const colors = ['#1A73E8', '#10B981', '#9333EA', '#F59E0B', '#EF4444', '#EC4899'];
    const chosenColor = colors[Math.floor(Math.random() * colors.length)];
    onCreateSubject(newSubjectName.trim(), chosenColor);
    setNewSubjectName('');
    setIsAddingSubject(false);
  };

  const handleStartRename = (note: NoteDocument) => {
    setRenamingNoteId(note.id);
    setRenameTitle(note.title);
    setActiveMenuNoteId(null);
  };

  const handleSaveRename = (id: string) => {
    if (renameTitle.trim()) {
      onRenameNote(id, renameTitle.trim());
    }
    setRenamingNoteId(null);
  };

  return (
    <div className="h-full flex bg-[#F2F2F7] dark:bg-[#121214] text-gray-900 dark:text-gray-100 select-none overflow-hidden">
      {/* Left Sidebar (The Classic Notability Dark/Navy Shelf) */}
      <aside className="w-64 md:w-72 bg-[#E5E5EA]/70 dark:bg-[#1C1C1E] border-r border-gray-300 dark:border-gray-800 flex flex-col p-4 flex-shrink-0">
        {/* App Title & Logo */}
        <div className="flex items-center justify-between mb-5 px-2">
          <div className="flex items-center space-x-2.5">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-blue-600 to-indigo-500 flex items-center justify-center text-white shadow-md font-bold text-lg">
              O
            </div>
            <span className="font-bold text-lg tracking-tight text-gray-900 dark:text-gray-100">
              OpenNote
            </span>
          </div>
          <button
            onClick={onOpenSettings}
            className="p-1.5 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 rounded-lg transition"
            title="Settings"
          >
            <SettingsIcon className="w-4 h-4" />
          </button>
        </div>

        {/* Search Bar */}
        <div className="relative mb-5">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-2.5" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search notes..."
            className="w-full bg-white dark:bg-[#2C2C2E] border border-gray-200 dark:border-gray-700 rounded-xl pl-9 pr-3 py-1.5 text-xs text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 shadow-xs"
          />
        </div>

        {/* Standard Folders */}
        <div className="space-y-1 mb-6">
          <button
            onClick={() => onSelectSubject(null)}
            className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs font-semibold transition ${
              selectedSubjectId === null || selectedSubjectId === 'all'
                ? 'bg-blue-600 text-white shadow-xs'
                : 'text-gray-700 dark:text-gray-300 hover:bg-gray-200/60 dark:hover:bg-gray-800'
            }`}
          >
            <div className="flex items-center space-x-2.5">
              <BookOpen className="w-4 h-4" />
              <span>All Notes</span>
            </div>
            <span className="text-[11px] opacity-80">{notes.length}</span>
          </button>
        </div>

        {/* Subjects / Dividers Section */}
        <div className="flex-1 overflow-y-auto space-y-1 pr-1">
          <div className="flex items-center justify-between px-2 mb-2 text-[11px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider">
            <span>SUBJECTS</span>
            <button
              onClick={() => setIsAddingSubject(true)}
              className="hover:text-blue-600 transition"
              title="Add Subject"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>

          {isAddingSubject && (
            <form onSubmit={handleAddSubject} className="mb-2 px-1">
              <input
                type="text"
                autoFocus
                value={newSubjectName}
                onChange={(e) => setNewSubjectName(e.target.value)}
                placeholder="Subject name..."
                onBlur={() => setIsAddingSubject(false)}
                className="w-full text-xs p-1.5 bg-white dark:bg-[#2C2C2E] border border-blue-500 rounded-lg text-gray-900 dark:text-gray-100 focus:outline-none"
              />
            </form>
          )}

          {subjects.map((subj) => {
            const count = notes.filter((n) => n.subjectId === subj.id).length;
            const isSelected = selectedSubjectId === subj.id;
            return (
              <button
                key={subj.id}
                onClick={() => onSelectSubject(subj.id)}
                className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs font-medium transition ${
                  isSelected
                    ? 'bg-white dark:bg-[#2C2C2E] text-blue-600 dark:text-blue-400 shadow-xs font-semibold'
                    : 'text-gray-700 dark:text-gray-300 hover:bg-gray-200/50 dark:hover:bg-gray-800'
                }`}
              >
                <div className="flex items-center space-x-2.5 truncate">
                  <span
                    className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                    style={{ backgroundColor: subj.color }}
                  />
                  <span className="truncate">{subj.name}</span>
                </div>
                <span className="text-[11px] text-gray-400 ml-2">{count}</span>
              </button>
            );
          })}
        </div>

        {/* Offline Badge & New Note Footer Action */}
        <div className="pt-3 border-t border-gray-300/60 dark:border-gray-800 text-[11px] text-gray-400 flex items-center justify-between">
          <span className="flex items-center space-x-1">
            <span className="w-2 h-2 rounded-full bg-green-500"></span>
            <span>Offline Ready</span>
          </span>
          <span>v1.0.0</span>
        </div>
      </aside>

      {/* Main Note Grid / List */}
      <main className="flex-1 flex flex-col overflow-hidden bg-white dark:bg-[#1C1C1E]">
        {/* Header Bar */}
        <header className="h-16 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between px-6 flex-shrink-0">
          <div className="flex items-center space-x-3">
            <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">{subjectTitle}</h1>
            <span className="text-xs font-semibold bg-gray-100 dark:bg-gray-800 text-gray-500 px-2 py-0.5 rounded-full">
              {filteredNotes.length} notes
            </span>
          </div>

          <div className="flex items-center space-x-3">
            {/* View Mode Toggle */}
            <div className="flex items-center bg-gray-100 dark:bg-[#2C2C2E] p-1 rounded-xl">
              <button
                onClick={() => setViewMode('grid')}
                className={`p-1.5 rounded-lg ${
                  viewMode === 'grid'
                    ? 'bg-white dark:bg-[#3A3A3C] text-blue-600 shadow-xs'
                    : 'text-gray-400 hover:text-gray-600'
                }`}
              >
                <GridIcon className="w-4 h-4" />
              </button>
              <button
                onClick={() => setViewMode('list')}
                className={`p-1.5 rounded-lg ${
                  viewMode === 'list'
                    ? 'bg-white dark:bg-[#3A3A3C] text-blue-600 shadow-xs'
                    : 'text-gray-400 hover:text-gray-600'
                }`}
              >
                <ListIcon className="w-4 h-4" />
              </button>
            </div>

            {/* + New Note Button (The Iconic Notability Action Button) */}
            <button
              onClick={() => onCreateNote(selectedSubjectId || undefined)}
              className="flex items-center space-x-2 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white px-4 py-2 rounded-xl text-xs font-semibold shadow-md active:scale-95 transition"
            >
              <Plus className="w-4 h-4" />
              <span>New Note</span>
            </button>
          </div>
        </header>

        {/* Note Cards Container */}
        <div className="flex-1 overflow-y-auto p-6">
          {filteredNotes.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-gray-400">
              <FileText className="w-12 h-12 stroke-[1.2] mb-3 text-gray-300 dark:text-gray-600" />
              <div className="font-semibold text-sm">No notes found</div>
              <p className="text-xs mt-1 text-gray-400">
                Click "+ New Note" above to start handwriting and LaTeXing!
              </p>
            </div>
          ) : viewMode === 'grid' ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
              {filteredNotes.map((note) => {
                const noteSubject = subjects.find((s) => s.id === note.subjectId);
                const hasStrokes = note.pages.some((p) => p.strokes.length > 0);
                const hasLatex = note.pages.some((p) => p.latexBlocks.length > 0);

                return (
                  <div
                    key={note.id}
                    onClick={() => onOpenNote(note.id)}
                    className="group relative bg-[#F9F9FB] dark:bg-[#2C2C2E] border border-gray-200 dark:border-gray-700/60 rounded-2xl overflow-hidden hover:shadow-lg transition cursor-pointer flex flex-col"
                  >
                    {/* Note Thumbnail Preview */}
                    <div className="h-44 bg-white dark:bg-[#18181B] border-b border-gray-100 dark:border-gray-800 p-4 relative flex flex-col justify-between overflow-hidden">
                      {/* Paper Pattern Hint */}
                      <div className="absolute inset-0 opacity-20 pointer-events-none">
                        {note.paperStyle === 'ruled' && (
                          <div
                            className="w-full h-full"
                            style={{
                              backgroundImage:
                                'linear-gradient(rgba(59, 130, 246, 0.3) 1px, transparent 1px)',
                              backgroundSize: '100% 20px',
                            }}
                          />
                        )}
                        {note.paperStyle === 'grid' && (
                          <div
                            className="w-full h-full"
                            style={{
                              backgroundImage:
                                'radial-gradient(circle, #94A3B8 1px, transparent 1px)',
                              backgroundSize: '16px 16px',
                            }}
                          />
                        )}
                      </div>

                      {/* Header Badge */}
                      <div className="flex items-center justify-between z-10">
                        {noteSubject && (
                          <span
                            className="text-[10px] font-semibold px-2 py-0.5 rounded-full text-white"
                            style={{ backgroundColor: noteSubject.color }}
                          >
                            {noteSubject.name}
                          </span>
                        )}
                        <span className="text-[10px] text-gray-400 font-medium ml-auto">
                          {note.pages.length} {note.pages.length === 1 ? 'page' : 'pages'}
                        </span>
                      </div>

                      {/* Preview Highlights */}
                      <div className="z-10 my-auto text-center">
                        {hasLatex && (
                          <div className="inline-flex items-center space-x-1 text-[11px] font-mono text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30 px-2.5 py-1 rounded-lg">
                            <Sparkles className="w-3 h-3" />
                            <span>LaTeX Math Embedded</span>
                          </div>
                        )}
                      </div>

                      <div className="text-[10px] text-gray-400 z-10 flex justify-between">
                        <span>{new Date(note.updatedAt).toLocaleDateString()}</span>
                        <span>{hasStrokes ? 'Handwritten' : 'Empty'}</span>
                      </div>
                    </div>

                    {/* Note Card Footer */}
                    <div className="p-3.5 flex items-center justify-between">
                      <div className="flex-1 min-w-0 mr-2">
                        {renamingNoteId === note.id ? (
                          <input
                            type="text"
                            autoFocus
                            value={renameTitle}
                            onChange={(e) => setRenameTitle(e.target.value)}
                            onBlur={() => handleSaveRename(note.id)}
                            onKeyDown={(e) => e.key === 'Enter' && handleSaveRename(note.id)}
                            onClick={(e) => e.stopPropagation()}
                            className="w-full text-xs font-semibold p-1 bg-white dark:bg-[#3A3A3C] border border-blue-500 rounded"
                          />
                        ) : (
                          <div className="font-semibold text-xs text-gray-900 dark:text-gray-100 truncate">
                            {note.title}
                          </div>
                        )}
                        <div className="text-[10px] text-gray-400 mt-0.5 flex items-center space-x-1">
                          <Clock className="w-2.5 h-2.5" />
                          <span>{new Date(note.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                        </div>
                      </div>

                      {/* Context Menu Button */}
                      <div className="relative" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() =>
                            setActiveMenuNoteId(activeMenuNoteId === note.id ? null : note.id)
                          }
                          className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700"
                        >
                          <MoreVertical className="w-4 h-4" />
                        </button>

                        {activeMenuNoteId === note.id && (
                          <div className="absolute right-0 bottom-8 bg-white dark:bg-[#2C2C2E] border border-gray-200 dark:border-gray-700 rounded-xl shadow-xl py-1 w-36 z-30 text-xs">
                            <button
                              onClick={() => handleStartRename(note)}
                              className="w-full px-3 py-1.5 flex items-center space-x-2 hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200"
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                              <span>Rename</span>
                            </button>
                            <button
                              onClick={() => {
                                onDuplicateNote(note.id);
                                setActiveMenuNoteId(null);
                              }}
                              className="w-full px-3 py-1.5 flex items-center space-x-2 hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200"
                            >
                              <Copy className="w-3.5 h-3.5" />
                              <span>Duplicate</span>
                            </button>
                            <button
                              onClick={() => {
                                onDeleteNote(note.id);
                                setActiveMenuNoteId(null);
                              }}
                              className="w-full px-3 py-1.5 flex items-center space-x-2 hover:bg-red-50 dark:hover:bg-red-900/30 text-red-600"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                              <span>Delete</span>
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            /* List View */
            <div className="divide-y divide-gray-100 dark:divide-gray-800">
              {filteredNotes.map((note) => (
                <div
                  key={note.id}
                  onClick={() => onOpenNote(note.id)}
                  className="py-3 px-4 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-[#2C2C2E] rounded-xl cursor-pointer transition"
                >
                  <div className="flex items-center space-x-3 truncate">
                    <FileText className="w-5 h-5 text-blue-600 flex-shrink-0" />
                    <div className="truncate">
                      <div className="font-semibold text-xs text-gray-900 dark:text-gray-100 truncate">
                        {note.title}
                      </div>
                      <div className="text-[10px] text-gray-400">
                        {new Date(note.updatedAt).toLocaleDateString()} · {note.pages.length} pages
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteNote(note.id);
                    }}
                    className="p-1.5 text-gray-400 hover:text-red-600 rounded-lg"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
};
