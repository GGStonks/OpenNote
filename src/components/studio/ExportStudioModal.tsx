import React, { useState } from 'react';
import {
  FileText,
  FileCode,
  Printer,
  Download,
  Save,
  Check,
  FolderDown,
  Share2,
} from 'lucide-react';
import { NoteDocument } from '../../types';
import { ExportMode, canMakePdf, exportFile, exportOffersBoth } from '../../platform';
import { StudioButton } from './StudioButton';
import { StudioSheet } from './StudioSheet';
import { baseName, buildLatex, buildMarkdown } from '../ExportModal';
import { filesForBackup } from '../../storage/db';
import { layerSvg, svgHead } from '../../services/svgExport';
import { splitIntoPages } from '../../editor/sheets';
import { zLayers } from '../../editor/zorder';
import { pdfPageImage } from '../../services/pdf';
import { paperHex, paperIsDark } from '../CanvasPage';

export interface ExportStudioModalProps {
  isOpen: boolean;
  onClose: () => void;
  document: NoteDocument;
  onPdf: (mode?: ExportMode) => void;
  onPrint: () => void;
  onError: (msg: string) => void;
}

async function buildSvgDocument(doc: NoteDocument): Promise<string> {
  const gap = 24;
  const pages = splitIntoPages(doc).map(({ page, box }) => ({ p: page, setup: box, layers: zLayers(page) }));
  const pdfImages = new Map<string, string>();
  for (const { setup } of pages) {
    if (!setup.pdf) continue;
    const url = await pdfPageImage(setup.pdf, setup.width, setup.height);
    if (url) pdfImages.set(setup.id, url);
  }
  const W = Math.max(...pages.map((x) => x.setup.width));
  const total = pages.reduce((h, x) => h + x.setup.height + gap, 0) - gap;
  let out = await svgHead([0, 0, W, total], pages.flatMap((x) => x.layers));
  let top = 0;
  pages.forEach(({ setup, layers }, i) => {
    const dy = top;
    top += setup.height + gap;
    const paper = paperHex(setup.paperColor);
    const ink = paperIsDark(setup.paperColor) ? '#F3F4F6' : '#111827';
    out += `<g id="page-${i + 1}"${setup.width < W ? ` transform="translate(${(W - setup.width) / 2} 0)"` : ''}>\n<rect x="0" y="${dy}" width="${setup.width}" height="${setup.height}" fill="${paper}"/>\n`;
    const pdf = pdfImages.get(setup.id);
    if (pdf) out += `<image href="${pdf}" xlink:href="${pdf}" x="0" y="${dy}" width="${setup.width}" height="${setup.height}"/>\n`;
    for (const l of layers) out += layerSvg(l, dy, paper, ink) + '\n';
    out += '</g>\n';
  });
  return out + '</svg>\n';
}

export const ExportStudioModal: React.FC<ExportStudioModalProps> = ({
  isOpen,
  onClose,
  document: doc,
  onPdf,
  onPrint,
  onError,
}) => {
  const [includeInk, setIncludeInk] = useState(true);
  const [busy, setBusy] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);

  if (!isOpen) return null;

  const b = baseName(doc);
  const dualOffers = exportOffersBoth();

  const runExport = async (
    filename: string,
    contentMaker: () => Promise<string | Blob> | string | Blob,
    mimeType: string,
    mode?: ExportMode
  ) => {
    setBusy(true);
    setSavedPath(null);
    try {
      const res = await contentMaker();
      const blob = res instanceof Blob ? res : new Blob([res], { type: mimeType });
      const where = await exportFile(filename, blob, mode);
      if (where) {
        setSavedPath(where);
      } else {
        onClose();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/cancel/i.test(msg)) onError(`Export failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  const renderCard = (
    title: string,
    description: string,
    icon: React.ReactNode,
    onAction: (mode?: ExportMode) => void,
    extraContent?: React.ReactNode
  ) => (
    <div className="studio-card rounded-2xl p-4 flex flex-col gap-2.5">
      <div className="flex items-start gap-3">
        <div className="p-2.5 rounded-xl bg-studio-accent-subtle text-studio-accent flex-shrink-0">
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-bold text-sm text-gray-900 dark:text-gray-100">{title}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 leading-relaxed">
            {description}
          </div>
        </div>
      </div>

      {extraContent && <div className="pl-12">{extraContent}</div>}

      <div className="flex gap-2 pt-1">
        {dualOffers ? (
          <>
            <StudioButton
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => onAction('save')}
              className="flex-1"
            >
              <FolderDown className="w-3.5 h-3.5 mr-1" /> Save to…
            </StudioButton>
            <StudioButton
              size="sm"
              variant="primary"
              disabled={busy}
              onClick={() => onAction('share')}
              className="flex-1"
            >
              <Share2 className="w-3.5 h-3.5 mr-1" /> Share
            </StudioButton>
          </>
        ) : (
          <StudioButton
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => onAction()}
            className="w-full"
          >
            Export
          </StudioButton>
        )}
      </div>
    </div>
  );

  return (
    <StudioSheet
      isOpen={isOpen}
      onClose={onClose}
      title={`Export “${doc.title}”`}
      icon={<Share2 className="w-5 h-5 text-studio-accent" />}
      maxWidth="lg"
    >
      <div className="space-y-3">
        {savedPath && (
          <div className="p-3 rounded-2xl bg-emerald-50 dark:bg-emerald-900/30 text-emerald-800 dark:text-emerald-200 text-xs flex items-center gap-2">
            <Check className="w-4 h-4 flex-shrink-0 text-emerald-500" />
            <span>Saved: {savedPath}</span>
          </div>
        )}

        {/* PDF Option */}
        {renderCard(
          'Vector PDF',
          canMakePdf()
            ? 'Original vector resolution, individual page formats and underlays preserved'
            : 'Export vector PDF via system print dialog',
          <FileText className="w-5 h-5" />,
          onPdf
        )}

        {/* Vector SVG Option */}
        {renderCard(
          'Vector SVG',
          'Scalable vector document with native ink paths, KaTeX formulas, and TikZ illustrations',
          <Download className="w-5 h-5" />,
          (m) => runExport(`${b}.svg`, () => buildSvgDocument(doc), 'image/svg+xml', m)
        )}

        {/* LaTeX (.tex) Option */}
        {renderCard(
          'LaTeX Document (.tex)',
          'Complete compilable document containing math equations and TikZ drawings',
          <FileCode className="w-5 h-5" />,
          (m) => runExport(`${b}.tex`, () => buildLatex(doc, includeInk), 'application/x-tex', m),
          <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400 cursor-pointer">
            <input
              type="checkbox"
              className="accent-studio-accent rounded"
              checked={includeInk}
              onChange={(e) => setIncludeInk(e.target.checked)}
            />
            <span>Include handwriting as vectorized TikZ drawings</span>
          </label>
        )}

        {/* Markdown Option */}
        {renderCard(
          'Markdown (.md)',
          'Obsidian & GitHub compatible with $$ equations and LaTeX code blocks',
          <FileText className="w-5 h-5" />,
          (m) => runExport(`${b}.md`, () => buildMarkdown(doc), 'text/markdown', m)
        )}

        {/* OpenNote Archive Option */}
        {renderCard(
          'OpenNote Archive (.opennote)',
          'Full-fidelity native notebook backup including embedded files, audio, and pressure strokes',
          <Save className="w-5 h-5" />,
          (m) =>
            runExport(
              `${b}.opennote`,
              async () => JSON.stringify({ ...doc, files: await filesForBackup([doc]) }),
              'application/json',
              m
            )
        )}

        {/* Print Option */}
        {canMakePdf() && (
          <StudioButton
            size="md"
            variant="glass"
            onClick={onPrint}
            disabled={busy}
            className="w-full flex items-center justify-center gap-2 mt-2"
          >
            <Printer className="w-4 h-4 text-studio-accent" />
            <span>Print with System Dialog…</span>
          </StudioButton>
        )}
      </div>
    </StudioSheet>
  );
};
