import React from 'react';
import { X, FileText, Image as ImageIcon, FileCode, Printer, Download } from 'lucide-react';
import { NoteDocument } from '../types';
import { compileTikzToSvg } from '../services/tikzService';

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  document: NoteDocument;
}

export const ExportModal: React.FC<ExportModalProps> = ({
  isOpen,
  onClose,
  document: doc,
}) => {
  if (!isOpen) return null;

  // Export as .tex with amsmath & tikz packages
  const handleExportTex = () => {
    let texContent = `\\documentclass{article}
\\usepackage[utf8]{inputenc}
\\usepackage{amsmath,amssymb,amsfonts,amsthm}
\\usepackage{tikz}
\\usepackage{geometry}
\\geometry{a4paper, margin=1in}

\\title{${doc.title}}
\\author{OpenNote}
\\date{\\today}

\\begin{document}
\\maketitle

`;

    doc.pages.forEach((p, idx) => {
      texContent += `% ==========================================\n`;
      texContent += `% --- Page ${idx + 1} ---\n`;
      texContent += `% ==========================================\n\n`;

      if (p.latexBlocks.length > 0) {
        p.latexBlocks.forEach((b) => {
          if (b.isTikz || b.latexCode.includes('tikzpicture')) {
            texContent += `% TikZ Diagram\n\\begin{center}\n${b.latexCode.trim()}\n\\end{center}\n\n`;
          } else {
            const raw = b.latexCode.replace(/<[^>]*>/g, '').trim();
            texContent += `\\[\n${raw}\n\\]\n\n`;
          }
        });
      } else {
        texContent += `% [Handwritten ink strokes on page ${idx + 1}]\n\n`;
      }
    });

    texContent += `\\end{document}\n`;

    const blob = new Blob([texContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = window.document.createElement('a');
    link.href = url;
    link.download = `${doc.title.replace(/\s+/g, '_')}.tex`;
    link.click();
    URL.revokeObjectURL(url);
    onClose();
  };

  // Export as Vector SVG Document
  const handleExportSvg = () => {
    let svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 816 ${doc.pages.length * 1056}" width="816" height="${doc.pages.length * 1056}">
  <style>
    .page-bg { fill: ${doc.paperColor === 'dark' ? '#18181B' : '#FFFFFF'}; }
    .ink { stroke-linecap: round; stroke-linejoin: round; }
  </style>
`;

    doc.pages.forEach((p, idx) => {
      const yOffset = idx * 1056;
      svgContent += `  <!-- Page ${idx + 1} -->\n`;
      svgContent += `  <rect x="0" y="${yOffset}" width="816" height="1056" class="page-bg" />\n`;

      // Render strokes
      p.strokes.forEach(s => {
        if (s.points.length < 2) return;
        const pts = s.points.map(pt => `${pt.x},${pt.y + yOffset}`).join(' ');
        const strokeW = s.tool === 'highlighter' ? s.width * 5 : s.width;
        const opacity = s.tool === 'highlighter' ? 0.35 : (s.opacity || 1);
        const dash = s.lineStyle === 'dashed' ? 'stroke-dasharray="10,6"' : (s.lineStyle === 'dotted' ? 'stroke-dasharray="3,6"' : '');
        svgContent += `  <polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="${strokeW}" stroke-opacity="${opacity}" ${dash} class="ink" />\n`;
      });

      // Render TikZ vector blocks
      p.latexBlocks.forEach(b => {
        if (b.isTikz) {
          const blockSvg = compileTikzToSvg(b.latexCode, b.width, b.height);
          svgContent += `  <g transform="translate(${b.x}, ${b.y + yOffset})">\n    ${blockSvg}\n  </g>\n`;
        }
      });
    });

    svgContent += `</svg>`;

    const blob = new Blob([svgContent], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = window.document.createElement('a');
    link.href = url;
    link.download = `${doc.title.replace(/\s+/g, '_')}.svg`;
    link.click();
    URL.revokeObjectURL(url);
    onClose();
  };

  // Export as Markdown
  const handleExportMarkdown = () => {
    let mdContent = `# ${doc.title}\n\n*Generated with OpenNote on ${new Date(doc.createdAt).toLocaleDateString()}*\n\n`;

    doc.pages.forEach((p, idx) => {
      mdContent += `## Page ${idx + 1}\n\n`;
      p.latexBlocks.forEach((b) => {
        if (b.isTikz || b.latexCode.includes('tikzpicture')) {
          mdContent += `\`\`\`latex\n${b.latexCode.trim()}\n\`\`\`\n\n`;
        } else {
          const raw = b.latexCode.replace(/<[^>]*>/g, '').trim();
          mdContent += `$$\n${raw}\n$$\n\n`;
        }
      });
    });

    const blob = new Blob([mdContent], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = window.document.createElement('a');
    link.href = url;
    link.download = `${doc.title.replace(/\s+/g, '_')}.md`;
    link.click();
    URL.revokeObjectURL(url);
    onClose();
  };

  // Export as Print / PDF
  const handlePrintPDF = () => {
    window.print();
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-[#1C1C1E] rounded-3xl max-w-md w-full shadow-2xl border border-gray-200 dark:border-gray-800 overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between">
          <h3 className="font-bold text-base text-gray-900 dark:text-gray-100">Export Note</h3>
          <button onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-600 rounded-full">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-3">
          <button
            onClick={handlePrintPDF}
            className="w-full flex items-center p-3.5 rounded-2xl border border-gray-200 dark:border-gray-700 hover:border-blue-500 hover:bg-blue-50/50 dark:hover:bg-blue-900/20 transition group text-left"
          >
            <div className="p-2.5 bg-red-100 dark:bg-red-900/40 text-red-600 rounded-xl mr-3 group-hover:scale-105 transition">
              <Printer className="w-5 h-5" />
            </div>
            <div>
              <div className="font-semibold text-sm text-gray-900 dark:text-gray-100">Export as PDF (Print)</div>
              <div className="text-xs text-gray-500">Vector high-DPI document with all handwriting</div>
            </div>
          </button>

          <button
            onClick={handleExportSvg}
            className="w-full flex items-center p-3.5 rounded-2xl border border-gray-200 dark:border-gray-700 hover:border-emerald-500 hover:bg-emerald-50/50 dark:hover:bg-emerald-900/20 transition group text-left"
          >
            <div className="p-2.5 bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600 rounded-xl mr-3 group-hover:scale-105 transition">
              <Download className="w-5 h-5" />
            </div>
            <div>
              <div className="font-semibold text-sm text-gray-900 dark:text-gray-100">Export Vector SVG (.svg)</div>
              <div className="text-xs text-gray-500">Lossless resolution-independent vector image</div>
            </div>
          </button>

          <button
            onClick={handleExportTex}
            className="w-full flex items-center p-3.5 rounded-2xl border border-gray-200 dark:border-gray-700 hover:border-indigo-500 hover:bg-indigo-50/50 dark:hover:bg-indigo-900/20 transition group text-left"
          >
            <div className="p-2.5 bg-indigo-100 dark:bg-indigo-900/40 text-indigo-600 rounded-xl mr-3 group-hover:scale-105 transition">
              <FileCode className="w-5 h-5" />
            </div>
            <div>
              <div className="font-semibold text-sm text-gray-900 dark:text-gray-100">Export LaTeX (.tex) with TikZ</div>
              <div className="text-xs text-gray-500">Compilable document with AMS-LaTeX & TikZ diagrams</div>
            </div>
          </button>

          <button
            onClick={handleExportMarkdown}
            className="w-full flex items-center p-3.5 rounded-2xl border border-gray-200 dark:border-gray-700 hover:border-blue-500 hover:bg-blue-50/50 dark:hover:bg-blue-900/20 transition group text-left"
          >
            <div className="p-2.5 bg-blue-100 dark:bg-blue-900/40 text-blue-600 rounded-xl mr-3 group-hover:scale-105 transition">
              <FileText className="w-5 h-5" />
            </div>
            <div>
              <div className="font-semibold text-sm text-gray-900 dark:text-gray-100">Export Markdown (.md)</div>
              <div className="text-xs text-gray-500">Obsidian, Notion, and GitHub compatible</div>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
};
