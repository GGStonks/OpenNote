import { splitIntoPages } from '../editor/sheets';
import { zLayers } from '../editor/zorder';
import React, { useState } from 'react';
import { X, FileText, FileCode, Printer, Download, Save, Check, FolderDown, Share2 } from 'lucide-react';
import { NoteDocument } from '../types';
import { strokeToSvg } from '../ink/strokeRenderer';
import { latexForDocument, renderLatexContent, escapeHtml } from '../services/latexRender';
import { prepareTikz, renderTikzPreview } from '../services/tikzEngine';
import { convertStrokesToTikz } from '../services/shapeRecognition';
import { paperHex, paperIsDark } from './CanvasPage';
import { textHeight } from '../editor/selection';
import { ExportMode, canMakePdf, exportFile, exportOffersBoth } from '../platform';
import { textCssString } from '../editor/textStyle';
import type { TextBlock } from '../types';

/** A text box's text with its style as LaTeX / Markdown markup. */
function texText(t: TextBlock): string {
  let s = t.text.replace(/([#%&_{}$])/g, '\\$1');
  if (t.bold) s = `\\textbf{${s}}`;
  if (t.italic) s = `\\textit{${s}}`;
  if (t.underline) s = `\\underline{${s}}`;
  return s;
}
function mdText(t: TextBlock): string {
  if (!t.text.trim()) return t.text;
  let s = t.text;
  if (t.bold) s = `**${s}**`;
  if (t.italic) s = `*${s}*`;
  if (t.underline) s = `<u>${s}</u>`;
  return s;
}

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  document: NoteDocument;
  onPdf: (mode?: ExportMode) => void;
  onPrint: () => void;
  onError: (msg: string) => void;
}

export function baseName(doc: NoteDocument): string {
  return (doc.title || 'OpenNote').replace(/[^\p{L}\p{N}\-_ ]+/gu, '').trim().replace(/\s+/g, '_') || 'OpenNote';
}

type Item = { y: number; tex: string; md: string };

export function buildLatex(doc: NoteDocument, includeInk: boolean): string {
  const libs = new Set<string>(['arrows.meta']);
  const pkgs = new Set<string>();
  const body: string[] = [];
  splitIntoPages(doc).forEach(({ page: p }, i) => {
    const items: Item[] = [];
    for (const t of p.textBlocks ?? []) items.push({ y: t.y, tex: texText(t) + '\n', md: mdText(t) + '\n' });
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
  splitIntoPages(doc).forEach(({ page: p }, i) => {
    const items: Item[] = [];
    for (const t of p.textBlocks ?? []) items.push({ y: t.y, tex: '', md: mdText(t) + '\n' });
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
  const gap = 24;
  const pages = splitIntoPages(doc).map(({ page, box }) => ({ p: page, setup: box }));
  const W = Math.max(...pages.map((x) => x.setup.width));
  const total = pages.reduce((h, x) => h + x.setup.height + gap, 0) - gap;
  let out = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xhtml="http://www.w3.org/1999/xhtml" viewBox="0 0 ${W} ${total}" width="${W}" height="${total}">\n`;
  let top = 0;
  pages.forEach(({ p, setup }, i) => {
    const dy = top;
    top += setup.height + gap;
    const paper = paperHex(setup.paperColor);
    const ink = paperIsDark(setup.paperColor) ? '#F3F4F6' : '#111827';
    out += `<g id="page-${i + 1}"${setup.width < W ? ` transform="translate(${(W - setup.width) / 2} 0)"` : ''}>\n<rect x="0" y="${dy}" width="${setup.width}" height="${setup.height}" fill="${paper}"/>\n`;
    // In stacking order (editor/zorder.ts), as on screen.
    for (const l of zLayers(p)) {
      if (l.kind === 'ink') {
        const order = [...l.strokes.filter((s) => s.tool === 'highlighter'), ...l.strokes.filter((s) => s.tool !== 'highlighter')];
        for (const s of order) out += strokeToSvg(s, dy, paper) + '\n';
        continue;
      }
      if (l.kind === 'image') {
        const im = l.block;
        out += turn(`<image href="${im.dataUrl}" x="${im.x}" y="${im.y + dy}" width="${im.width}" height="${im.height}"/>`, im.rotation, im.x + im.width / 2, im.y + dy + im.height / 2) + '\n';
        continue;
      }
      if (l.kind === 'text') {
        const t = l.block;
        out += turn(`<foreignObject x="${t.x}" y="${t.y + dy}" width="${t.width}" height="${Math.max(t.height ?? 0, t.fontSize * 1.4 * (t.text.split('\n').length + 4))}"><xhtml:div style="${textCssString(t)};color:${t.color};white-space:pre-wrap">${escapeHtml(t.text)}</xhtml:div></foreignObject>`, t.rotation, t.x + t.width / 2, t.y + dy + textHeight(t) / 2) + '\n';
        continue;
      }
      const b = l.block;
      if (b.isTikz) {
        const svg = b.tikzSvg && b.tikzSvgSource === b.latexCode ? b.tikzSvg : renderTikzPreview(b.latexCode).svg;
        const inner = svg.replace(/<svg\b/, `<svg x="${b.x}" y="${b.y + dy}" width="${b.width}" height="${b.height}"`).replace(/currentColor/g, b.color ?? ink);
        out += turn(inner, b.rotation, b.x + b.width / 2, b.y + dy + b.height / 2) + '\n';
      } else {
        const html = renderLatexContent(b.latexCode).html;
        out += turn(`<foreignObject x="${b.x}" y="${b.y + dy}" width="${Math.max(b.width, 40) + 20}" height="${Math.max(b.height, 30) + 10}"><xhtml:div style="font-size:${22 * (b.scale ?? 1)}px;color:${b.color ?? ink}">${html}</xhtml:div></foreignObject>`, b.rotation, b.x + b.width / 2, b.y + dy + b.height / 2) + '\n';
      }
    }
    out += '</g>\n';
  });
  return out + '</svg>\n';
}

export const ExportModal: React.FC<ExportModalProps> = ({ isOpen, onClose, document: doc, onPdf, onPrint, onError }) => {
  const [includeInk, setIncludeInk] = useState(true);
  const [busy, setBusy] = useState(false);
  /** Where the last export went (shown until the dialog closes). */
  const [saved, setSaved] = useState<string | null>(null);
  if (!isOpen) return null;

  const both = exportOffersBoth();

  const run = async (name: string, content: string | Blob, type: string, mode?: ExportMode) => {
    setBusy(true);
    setSaved(null);
    try {
      const where = await exportFile(name, content instanceof Blob ? content : new Blob([content], { type }), mode);
      if (where) setSaved(where);
      else onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/cancel/i.test(msg)) onError(`Export failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  const b = baseName(doc);
  /**
   * One format. Android (exportOffersBoth): "Save to…" (a folder the user picks) and "Share"
   * (Drive, Gmail, a chat…) side by side; elsewhere the whole card exports, as Settings chooses.
   */
  const Format: React.FC<{ icon: React.ReactNode; title: string; sub: string; tint: string; onExport: (mode?: ExportMode) => void; children?: React.ReactNode }> = ({ icon, title, sub, tint, onExport, children }) => {
    const head = (
      <>
        <div className={`p-2.5 rounded-xl mr-3 flex-shrink-0 ${tint}`}>{icon}</div>
        <div className="min-w-0">
          <div className="font-semibold text-sm text-gray-900 dark:text-gray-100">{title}</div>
          <div className="text-xs text-gray-500">{sub}</div>
        </div>
      </>
    );
    const option = children && <div className="px-3 pb-3 pl-[4.25rem]">{children}</div>;
    if (!both) {
      return (
        <div className="rounded-2xl border border-gray-200 dark:border-gray-700 hover:border-blue-500 transition">
          <button disabled={busy} onClick={() => onExport()} className={`w-full flex items-center p-3 text-left disabled:opacity-50 ${children ? 'pb-2' : ''}`}>{head}</button>
          {option}
        </div>
      );
    }
    const action = 'flex-1 flex items-center justify-center gap-2 h-10 rounded-xl text-sm font-semibold transition disabled:opacity-50';
    return (
      <div className="rounded-2xl border border-gray-200 dark:border-gray-700">
        <div className="flex items-center p-3 pb-2">{head}</div>
        {option}
        <div className="flex gap-2 px-3 pb-3">
          <button disabled={busy} onClick={() => onExport('save')} className={`${action} bg-gray-100 text-gray-800 active:bg-gray-200 dark:bg-ui-raised dark:text-gray-100`}>
            <FolderDown className="w-4 h-4" /> Save to…
          </button>
          <button disabled={busy} onClick={() => onExport('share')} className={`${action} bg-blue-600 text-white active:bg-blue-700`}>
            <Share2 className="w-4 h-4" /> Share
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center sm:p-4" data-no-pan>
      <div className="bg-white dark:bg-ui-panel rounded-t-3xl sm:rounded-3xl w-full sm:max-w-md shadow-2xl border border-gray-200 dark:border-gray-800 overflow-hidden pb-[env(safe-area-inset-bottom)] max-h-[calc(100dvh-16px)] flex flex-col">
        <div className="px-5 py-3.5 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between">
          <h3 className="font-bold text-base text-gray-900 dark:text-gray-100">Export “{doc.title}”</h3>
          <button onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-600 rounded-full">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-5 space-y-2.5 flex-1 min-h-0 overflow-y-auto">
          {saved && (
            <div className="flex items-start gap-2 text-sm rounded-2xl bg-emerald-50 dark:bg-emerald-900/30 text-emerald-800 dark:text-emerald-200 px-3 py-2.5">
              <Check className="w-4 h-4 mt-0.5 flex-shrink-0" /> {saved}
            </div>
          )}
          <Format
            icon={<FileText className="w-5 h-5" />}
            tint="bg-red-100 text-red-600 dark:bg-red-900/40"
            title="PDF"
            sub={canMakePdf() ? 'Vector PDF, every page at its own size and orientation' : 'Vector PDF through the system print dialog (Save as PDF / Save to Files)'}
            onExport={onPdf}
          />
          <Format icon={<Download className="w-5 h-5" />} tint="bg-emerald-100 text-emerald-600 dark:bg-emerald-900/40" title="Vector SVG" sub="All pages, ink, TikZ diagrams and math" onExport={(m) => run(`${b}.svg`, buildSvg(doc), 'image/svg+xml', m)} />
          <Format icon={<FileCode className="w-5 h-5" />} tint="bg-indigo-100 text-indigo-600 dark:bg-indigo-900/40" title="LaTeX (.tex)" sub="Compilable document: math, text, TikZ" onExport={(m) => run(`${b}.tex`, buildLatex(doc, includeInk), 'application/x-tex', m)}>
            <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
              <input type="checkbox" checked={includeInk} onChange={(e) => setIncludeInk(e.target.checked)} />
              Include remaining handwriting as TikZ drawings
            </label>
          </Format>
          <Format icon={<FileText className="w-5 h-5" />} tint="bg-blue-100 text-blue-600 dark:bg-blue-900/40" title="Markdown (.md)" sub="Obsidian / GitHub compatible ($$ math, latex code blocks)" onExport={(m) => run(`${b}.md`, buildMarkdown(doc), 'text/markdown', m)} />
          <Format icon={<Save className="w-5 h-5" />} tint="bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300" title="OpenNote file (.opennote)" sub="Full-fidelity note (ink with pressure, blocks) for backup or another device" onExport={(m) => run(`${b}.opennote`, JSON.stringify(doc), 'application/json', m)} />
          {canMakePdf() && (
            <button disabled={busy} onClick={onPrint} className="w-full flex items-center p-3 rounded-2xl border border-gray-200 dark:border-gray-700 hover:border-blue-500 transition text-left disabled:opacity-50">
              <div className="p-2.5 rounded-xl mr-3 bg-gray-100 text-gray-600 dark:bg-gray-800"><Printer className="w-5 h-5" /></div>
              <div>
                <div className="font-semibold text-sm text-gray-900 dark:text-gray-100">Print…</div>
                <div className="text-xs text-gray-500">System print dialog (one paper size for all pages)</div>
              </div>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
