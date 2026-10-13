import { splitSurface } from '../editor/surface';
import React, { useState } from 'react';
import { X, FileText, FileCode, Printer, Download, Save } from 'lucide-react';
import { NoteDocument, PAGE_HEIGHT, PAGE_WIDTH } from '../types';
import { strokeToSvg } from '../ink/strokeRenderer';
import { latexForDocument, renderLatexContent, escapeHtml } from '../services/latexRender';
import { prepareTikz, renderTikzPreview } from '../services/tikzEngine';
import { convertStrokesToTikz } from '../services/shapeRecognition';
import { PAPER_COLORS } from './CanvasPage';
import { textHeight } from '../editor/selection';
import { shareFile } from '../platform';

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  document: NoteDocument;
  onPdf: () => void;
  onError: (msg: string) => void;
}

function baseName(doc: NoteDocument): string {
  return (doc.title || 'OpenNote').replace(/[^\p{L}\p{N}\-_ ]+/gu, '').trim().replace(/\s+/g, '_') || 'OpenNote';
}

type Item = { y: number; tex: string; md: string };

export function buildLatex(doc: NoteDocument, includeInk: boolean): string {
  const libs = new Set<string>(['arrows.meta']);
  const pkgs = new Set<string>();
  const body: string[] = [];
  splitSurface(doc.pages[0]).forEach((p, i) => {
    const items: Item[] = [];
    for (const t of p.textBlocks ?? []) items.push({ y: t.y, tex: t.text.replace(/([#%&_{}$])/g, '\\$1') + '\n', md: t.text + '\n' });
    for (const b of p.latexBlocks) {
      if (b.isTikz) {
        const prep = prepareTikz(b.latexCode);
        prep.libraries.forEach((l) => libs.add(l));
        Object.keys(prep.packages).forEach((k) => pkgs.add(k));
        items.push({ y: b.y, tex: `\\begin{center}\n${prep.picture}\n\\end{center}\n`, md: '```latex\n' + prep.picture + '\n```\n' });
      } else {
        const tex = latexForDocument(b.latexCode);
        items.push({ y: b.y, tex: tex + '\n', md: tex.replace(/^\\\[\n?|\n?\\\]$/g, '$$$$') + '\n' });
      }
    }
    const ink = p.strokes.filter((s) => s.tool === 'pen');
    if (includeInk && ink.length) {
      let minY = Infinity;
      ink.forEach((s) => s.points.forEach((pt) => (minY = Math.min(minY, pt.y))));
      const prep = prepareTikz(convertStrokesToTikz(ink));
      prep.libraries.forEach((l) => libs.add(l));
      items.push({ y: minY, tex: `% Handwriting on page ${i + 1} (vectorised)\n\\begin{center}\n\\resizebox{\\linewidth}{!}{%\n${prep.picture}}\n\\end{center}\n`, md: '' });
    }
    items.sort((a, b) => a.y - b.y);
    body.push(`% ----- Page ${i + 1} -----\n` + items.map((it) => it.tex).join('\n'));
  });
  const preamble = [
    '\\documentclass[11pt]{article}',
    '\\usepackage[utf8]{inputenc}',
    '\\usepackage[margin=2.5cm]{geometry}',
    '\\usepackage{amsmath,amssymb,amsfonts,amsthm,graphicx,xcolor}',
    '\\usepackage{tikz}',
    ...[...pkgs].map((p) => `\\usepackage{${p}}`),
    pkgs.has('pgfplots') ? '\\pgfplotsset{compat=1.18}' : '',
    `\\usetikzlibrary{${[...libs].join(',')}}`,
    '',
    `\\title{${doc.title.replace(/([#%&_{}$])/g, '\\$1')}}`,
    '\\date{}',
    '\\begin{document}',
    '\\maketitle',
    '',
  ].filter((l) => l !== null);
  return preamble.join('\n') + body.join('\n\\newpage\n') + '\n\\end{document}\n';
}

function buildMarkdown(doc: NoteDocument): string {
  let md = `# ${doc.title}\n\n`;
  splitSurface(doc.pages[0]).forEach((p, i) => {
    const items: Item[] = [];
    for (const t of p.textBlocks ?? []) items.push({ y: t.y, tex: '', md: t.text + '\n' });
    for (const b of p.latexBlocks) {
      if (b.isTikz) items.push({ y: b.y, tex: '', md: '```latex\n' + prepareTikz(b.latexCode).picture + '\n```\n' });
      else {
        const tex = latexForDocument(b.latexCode);
        const m = /^\\\[\n?([\s\S]*?)\n?\\\]$/.exec(tex);
        items.push({ y: b.y, tex: '', md: m ? `$$\n${m[1]}\n$$\n` : tex.replace(/\\\[([\s\S]*?)\\\]/g, '$$$$$1$$$$') + '\n' });
      }
    }
    if (!items.length) return;
    items.sort((a, b) => a.y - b.y);
    md += `## Page ${i + 1}\n\n` + items.map((it) => it.md).join('\n') + '\n';
  });
  return md;
}

/** Wraps an SVG element in a rotation about (cx, cy) when the item is turned. */
const turn = (el: string, deg: number | undefined, cx: number, cy: number) => (deg ? `<g transform="rotate(${deg} ${cx.toFixed(2)} ${cy.toFixed(2)})">${el}</g>` : el);

function buildSvg(doc: NoteDocument): string {
  const H = PAGE_HEIGHT, W = PAGE_WIDTH, gap = 24;
  const pages = splitSurface(doc.pages[0]);
  const total = pages.length * (H + gap) - gap;
  const ink = doc.paperColor === 'dark' ? '#F3F4F6' : '#111827';
  let out = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xhtml="http://www.w3.org/1999/xhtml" viewBox="0 0 ${W} ${total}" width="${W}" height="${total}">\n`;
  pages.forEach((p, i) => {
    const dy = i * (H + gap);
    out += `<g id="page-${i + 1}">\n<rect x="0" y="${dy}" width="${W}" height="${H}" fill="${PAPER_COLORS[doc.paperColor]}"/>\n`;
    for (const im of p.imageBlocks ?? []) out += turn(`<image href="${im.dataUrl}" x="${im.x}" y="${im.y + dy}" width="${im.width}" height="${im.height}"/>`, im.rotation, im.x + im.width / 2, im.y + dy + im.height / 2) + '\n';
    const order = [...p.strokes.filter((s) => s.tool === 'highlighter'), ...p.strokes.filter((s) => s.tool !== 'highlighter')];
    for (const s of order) out += strokeToSvg(s, dy, PAPER_COLORS[doc.paperColor]) + '\n';
    for (const b of p.latexBlocks) {
      if (b.isTikz) {
        const svg = b.tikzSvg && b.tikzSvgSource === b.latexCode ? b.tikzSvg : renderTikzPreview(b.latexCode).svg;
        const inner = svg.replace(/<svg\b/, `<svg x="${b.x}" y="${b.y + dy}" width="${b.width}" height="${b.height}"`).replace(/currentColor/g, b.color ?? ink);
        out += turn(inner, b.rotation, b.x + b.width / 2, b.y + dy + b.height / 2) + '\n';
      } else {
        const html = renderLatexContent(b.latexCode).html;
        out += turn(`<foreignObject x="${b.x}" y="${b.y + dy}" width="${Math.max(b.width, 40) + 20}" height="${Math.max(b.height, 30) + 10}"><xhtml:div style="font-size:${22 * (b.scale ?? 1)}px;color:${b.color ?? ink}">${html}</xhtml:div></foreignObject>`, b.rotation, b.x + b.width / 2, b.y + dy + b.height / 2) + '\n';
      }
    }
    for (const t of p.textBlocks ?? []) {
      out += turn(`<foreignObject x="${t.x}" y="${t.y + dy}" width="${t.width}" height="${t.fontSize * 1.4 * (t.text.split('\n').length + 4)}"><xhtml:div style="font:${t.fontSize}px -apple-system,Helvetica,Arial,sans-serif;color:${t.color};white-space:pre-wrap;line-height:1.35">${escapeHtml(t.text)}</xhtml:div></foreignObject>`, t.rotation, t.x + t.width / 2, t.y + dy + textHeight(t) / 2) + '\n';
    }
    out += '</g>\n';
  });
  return out + '</svg>\n';
}

export const ExportModal: React.FC<ExportModalProps> = ({ isOpen, onClose, document: doc, onPdf, onError }) => {
  const [includeInk, setIncludeInk] = useState(true);
  const [busy, setBusy] = useState(false);
  if (!isOpen) return null;

  const run = async (name: string, content: string | Blob, type: string) => {
    setBusy(true);
    try {
      await shareFile(name, content instanceof Blob ? content : new Blob([content], { type }));
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/cancel/i.test(msg)) onError(`Export failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  const b = baseName(doc);
  const Row: React.FC<{ icon: React.ReactNode; title: string; sub: string; onClick: () => void; tint: string }> = ({ icon, title, sub, onClick, tint }) => (
    <button disabled={busy} onClick={onClick} className="w-full flex items-center p-3 rounded-2xl border border-gray-200 dark:border-gray-700 hover:border-blue-500 transition text-left disabled:opacity-50">
      <div className={`p-2.5 rounded-xl mr-3 ${tint}`}>{icon}</div>
      <div>
        <div className="font-semibold text-sm text-gray-900 dark:text-gray-100">{title}</div>
        <div className="text-xs text-gray-500">{sub}</div>
      </div>
    </button>
  );

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center sm:p-4" data-no-pan>
      <div className="bg-white dark:bg-[#1C1C1E] rounded-t-3xl sm:rounded-3xl w-full sm:max-w-md shadow-2xl border border-gray-200 dark:border-gray-800 overflow-hidden pb-[env(safe-area-inset-bottom)]">
        <div className="px-5 py-3.5 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between">
          <h3 className="font-bold text-base text-gray-900 dark:text-gray-100">Export “{doc.title}”</h3>
          <button onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-600 rounded-full">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-5 space-y-2.5 max-h-[75vh] overflow-y-auto">
          <Row icon={<Printer className="w-5 h-5" />} tint="bg-red-100 text-red-600 dark:bg-red-900/40" title="PDF" sub="Vector PDF through the system print dialog (Save as PDF / Save to Files)" onClick={onPdf} />
          <Row icon={<Download className="w-5 h-5" />} tint="bg-emerald-100 text-emerald-600 dark:bg-emerald-900/40" title="Vector SVG" sub="All pages, ink, TikZ diagrams and math" onClick={() => run(`${b}.svg`, buildSvg(doc), 'image/svg+xml')} />
          <Row icon={<FileCode className="w-5 h-5" />} tint="bg-indigo-100 text-indigo-600 dark:bg-indigo-900/40" title="LaTeX (.tex)" sub="Compilable document: math, text, TikZ" onClick={() => run(`${b}.tex`, buildLatex(doc, includeInk), 'application/x-tex')} />
          <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400 px-2">
            <input type="checkbox" checked={includeInk} onChange={(e) => setIncludeInk(e.target.checked)} />
            Include remaining handwriting in the .tex as TikZ drawings
          </label>
          <Row icon={<FileText className="w-5 h-5" />} tint="bg-blue-100 text-blue-600 dark:bg-blue-900/40" title="Markdown (.md)" sub="Obsidian / GitHub compatible ($$ math, latex code blocks)" onClick={() => run(`${b}.md`, buildMarkdown(doc), 'text/markdown')} />
          <Row icon={<Save className="w-5 h-5" />} tint="bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300" title="OpenNote file (.opennote)" sub="Full-fidelity note (ink with pressure, blocks) for backup or another device" onClick={() => run(`${b}.opennote`, JSON.stringify(doc), 'application/json')} />
        </div>
      </div>
    </div>
  );
};
