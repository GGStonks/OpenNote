import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PdfPageRef } from '../types';
import { drawPdfRegion, pdfPreview, PdfRegion } from '../services/pdf';
import { tileWork } from '../editor/tileWork';

/**
 * The PDF page drawn as a page's paper (PageSheet.pdf), under its content, always from the PDF's
 * vectors at the resolution it is shown at:
 *  - a preview (pdfPreview) at once, until the page is drawn;
 *  - the whole page at the page canvases' zoom (`baseZoom`, fitting the width) once it comes
 *    near the view, given back when it is far (WebKit's canvas memory is tight);
 *  - zoomed in past that, the part in view again at the zoom, once zooming and scrolling rest
 *    (the base page, stretched, shows meanwhile), as SharpInk does for the ink.
 * Nothing is drawn while two fingers zoom (tileWork.paused).
 * For print: the whole page sharp enough to print; `printBare` (the PDF export lays the original
 * page under the printed one, pdfExport.ts) draws nothing.
 */

/**
 * Largest canvas drawn for a whole page or for the part in view (px; WebKit's GPU canvas limit is
 * 14.7 M). A whole page fitting the width of a 13" iPad Pro (2064 px wide) is 5.5 M; a few pages
 * near the view at 9 M each were over 100 MB of canvas.
 */
const BASE_PIXELS = 5_600_000;
const SHARP_PIXELS = 12_000_000;
/**
 * Printed pages: px per page px (2 x 96 = 192 dpi), as a JPEG image each. Canvases (one per
 * printed page, all at once in the print layout) went past WebKit's canvas memory and printed
 * empty: the PDF was missing from the export.
 */
const PRINT_RATIO = 2;
/** The part in view is drawn this much wider and taller (a little scrolling stays sharp). */
const SHARP_MARGIN = 0.25;
const SHARP_REST_MS = 160;

/** Print layouts waiting for their PDF pages (pdfPrintReady). */
const printing = new Set<Promise<unknown>>();

/** Resolves once every PDF page of the print layout on screen is drawn. */
export async function pdfPrintReady(): Promise<void> {
  // A layout mounted in this frame registers its pages in its effects.
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  while (printing.size) await Promise.all([...printing]);
  // And the pictures are on the page (React shows them in its next commit).
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
}

interface Props {
  pdf: PdfPageRef;
  width: number;
  height: number;
  zoom: number;
  /** The zoom the page's ink canvases are drawn for (the fit-width zoom). */
  baseZoom: number;
  scrollRoot: HTMLElement | null;
  /** The page's paper colour: the part drawn zoomed in is opaque on it (see below). */
  paper: string;
  printMode?: boolean;
  printBare?: boolean;
}

export const PdfBackground = React.memo(function PdfBackground({ pdf, width: W, height: H, zoom, baseZoom, scrollRoot, paper, printMode, printBare }: Props) {
  const holderRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const sharpRef = useRef<HTMLCanvasElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [near, setNear] = useState(false);
  const [baseDrawn, setBaseDrawn] = useState(false);
  /** Print layout: the page as a picture (object URL). */
  const [printUrl, setPrintUrl] = useState<string | null>(null);
  const key = `${pdf.file}|${pdf.page}|${Math.round(W)}x${Math.round(H)}`;
  const slot = useRef(`${key}|${Math.random().toString(36).slice(2)}`).current;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);

  useEffect(() => {
    let live = true;
    void pdfPreview(pdf).then((u) => live && setPreview(u));
    return () => {
      live = false;
    };
  }, [pdf.file, pdf.page]); // eslint-disable-line react-hooks/exhaustive-deps

  // Near the view: drawn; far from it: given back.
  useEffect(() => {
    const el = holderRef.current;
    if (!el || printMode) return;
    const wake = () => setNear(true);
    const nearIo = new IntersectionObserver((en) => {
      if (!en.some((e) => e.isIntersecting)) return;
      if (tileWork.paused) tileWork.resume.add(wake);
      else wake();
    }, { root: scrollRoot, rootMargin: '100% 0px' });
    const farIo = new IntersectionObserver((en) => !en.some((e) => e.isIntersecting) && setNear(false), { root: scrollRoot, rootMargin: '250% 0px' });
    nearIo.observe(el);
    farIo.observe(el);
    return () => {
      tileWork.resume.delete(wake);
      nearIo.disconnect();
      farIo.disconnect();
    };
  }, [scrollRoot, printMode]);

  // The whole page.
  const baseRatio = printMode ? Math.min(PRINT_RATIO, Math.sqrt(BASE_PIXELS / (W * H))) : Math.min(Math.max(0.25, baseZoom) * dpr, Math.sqrt(BASE_PIXELS / (W * H)));
  // Print layout: the whole page as a JPEG picture, its canvas given back at once.
  useLayoutEffect(() => {
    if (!printMode || printBare) return;
    let live = true, url: string | null = null;
    const c = document.createElement('canvas');
    const done = drawPdfRegion(`${slot}|print`, pdf, { w: W, h: H }, { x0: 0, y0: 0, x1: W, y1: H }, baseRatio, c, '#ffffff')
      .then((ok) => (ok ? new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.92)) : null))
      .then(async (blob) => {
        c.width = c.height = 0;
        if (!blob || !live) return;
        url = URL.createObjectURL(blob);
        const img = new Image();
        img.src = url;
        await img.decode().catch(() => undefined);
        if (live) setPrintUrl(url);
      });
    printing.add(done);
    void done.finally(() => printing.delete(done));
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
      setPrintUrl(null);
    };
  }, [printMode, printBare, baseRatio, key]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const c = baseRef.current;
    if (!c) return;
    if (printMode) return;
    if (!printMode && !near) {
      c.width = c.height = 0;
      setBaseDrawn(false);
      return;
    }
    let live = true;
    void drawPdfRegion(`${slot}|base`, pdf, { w: W, h: H }, { x0: 0, y0: 0, x1: W, y1: H }, baseRatio, c).then((ok) => {
      if (!live || !ok) return;
      // Shown in the same task as its pixels.
      c.style.visibility = 'visible';
      setBaseDrawn(true);
    });
    return () => {
      live = false;
    };
  }, [near, printMode, printBare, baseRatio, key]); // eslint-disable-line react-hooks/exhaustive-deps

  // The part in view, zoomed in.
  const [sharp, setSharp] = useState<PdfRegion | null>(null);
  useEffect(() => {
    const c = sharpRef.current;
    if (printMode || !near || !c || zoom * dpr <= baseRatio * 1.05) {
      if (c) c.width = c.height = 0;
      setSharp(null);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    let drawnFor: { region: PdfRegion; r: number } | null = null;
    const draw = () => {
      timer = null;
      if (tileWork.paused) {
        tileWork.resume.add(later);
        return;
      }
      const holder = holderRef.current;
      if (!holder) return;
      const hr = holder.getBoundingClientRect();
      const rr = scrollRoot?.getBoundingClientRect() ?? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight, width: window.innerWidth, height: window.innerHeight };
      const s = hr.width / W;
      if (!(s > 0)) return;
      // The view in sheet px, and a margin around it.
      const vx0 = (rr.left - hr.left) / s, vy0 = (rr.top - hr.top) / s, vx1 = (rr.right - hr.left) / s, vy1 = (rr.bottom - hr.top) / s;
      if (vx1 <= 0 || vy1 <= 0 || vx0 >= W || vy0 >= H) return;
      // Exactly the screen's pixels: the scale it is shown at, and its corner on a whole device
      // pixel (anywhere else the compositor resampled it and the PDF's text went soft).
      const r = s * dpr;
      const snap = (v: number, edge: number) => ((Math.floor((edge + v * s) * dpr) / dpr - edge) / s);
      let m = SHARP_MARGIN;
      let region: PdfRegion;
      for (;;) {
        const mx = (vx1 - vx0) * m, my = (vy1 - vy0) * m;
        region = { x0: Math.max(0, vx0 - mx), y0: Math.max(0, vy0 - my), x1: Math.min(W, vx1 + mx), y1: Math.min(H, vy1 + my) };
        if ((region.x1 - region.x0) * (region.y1 - region.y0) * r * r <= SHARP_PIXELS || m <= 0) break;
        m = Math.max(0, m - 0.1);
      }
      region.x0 = snap(region.x0, hr.left);
      region.y0 = snap(region.y0, hr.top);
      // Whole device pixels wide and high too (the canvas is exactly as many px as it covers).
      region.x1 = region.x0 + Math.ceil((region.x1 - region.x0) * r) / r;
      region.y1 = region.y0 + Math.ceil((region.y1 - region.y0) * r) / r;
      // Still covering the view at this zoom: nothing to do.
      const d = drawnFor;
      if (d && Math.abs(d.r - r) < 1e-3 * r && d.region.x0 <= Math.max(0, vx0) && d.region.y0 <= Math.max(0, vy0) && d.region.x1 >= Math.min(W, vx1) && d.region.y1 >= Math.min(H, vy1)) return;
      const target = region;
      // Opaque, on the paper's colour: over the stretched base page, a see-through part let its
      // blurred text show around the sharp text (a soft halo).
      void drawPdfRegion(`${slot}|sharp`, pdf, { w: W, h: H }, target, r, c, paper).then((ok) => {
        if (!ok) return;
        drawnFor = { region: target, r };
        // Placed in the same task as its new pixels (React would place it a frame later).
        Object.assign(c.style, { display: '', position: 'absolute', left: `${target.x0}px`, top: `${target.y0}px`, width: `${target.x1 - target.x0}px`, height: `${target.y1 - target.y0}px` });
        setSharp(target);
      });
    };
    const later = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(draw, SHARP_REST_MS);
    };
    later();
    const target: HTMLElement | Window = scrollRoot ?? window;
    target.addEventListener('scroll', later, { passive: true });
    window.addEventListener('resize', later);
    return () => {
      if (timer) clearTimeout(timer);
      tileWork.resume.delete(later);
      target.removeEventListener('scroll', later);
      window.removeEventListener('resize', later);
    };
  }, [zoom, near, printMode, baseRatio, key, scrollRoot, paper]); // eslint-disable-line react-hooks/exhaustive-deps

  const fill: React.CSSProperties = { position: 'absolute', left: 0, top: 0, width: W, height: H };
  return (
    <div ref={holderRef} className="absolute inset-0 pointer-events-none" data-pdf-page={`${pdf.file}:${pdf.page}`}>
      {printMode ? (
        !printBare && printUrl && <img src={printUrl} alt="" draggable={false} style={{ ...fill, maxWidth: 'none' }} />
      ) : (
        <>
          {preview && !baseDrawn && <img src={preview} alt="" draggable={false} style={{ ...fill, objectFit: 'contain', maxWidth: 'none' }} />}
          <canvas ref={baseRef} style={{ ...fill, visibility: baseDrawn ? 'visible' : 'hidden' }} />
        </>
      )}
      {!printMode && (
        <canvas
          ref={sharpRef}
          style={sharp ? { position: 'absolute', left: sharp.x0, top: sharp.y0, width: sharp.x1 - sharp.x0, height: sharp.y1 - sharp.y0 } : { display: 'none' }}
        />
      )}
    </div>
  );
});
