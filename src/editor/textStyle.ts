import type { TextBlock, TextFont } from '../types';

/**
 * Text box typography: the font families offered and how a box's style is written as CSS, the
 * same on the page, in thumbnails, in exports and in print. Only font stacks every platform has
 * (nothing is downloaded): iPadOS and Android each map them to their own system fonts.
 */
export const TEXT_FONTS: { id: TextFont; label: string; css: string }[] = [
  { id: 'sans', label: 'Sans', css: '-apple-system, system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif' },
  { id: 'serif', label: 'Serif', css: 'Georgia, "Times New Roman", "Noto Serif", serif' },
  { id: 'mono', label: 'Mono', css: 'ui-monospace, Menlo, "Roboto Mono", "Courier New", monospace' },
  { id: 'script', label: 'Script', css: '"Snell Roundhand", "Dancing Script", "Segoe Script", cursive' },
];

/** Font sizes offered by the size buttons (page px). */
export const TEXT_SIZES = [10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64, 80];

export const TEXT_LINE_HEIGHT = 1.35;

export function fontStack(f: TextFont | undefined): string {
  return (TEXT_FONTS.find((x) => x.id === f) ?? TEXT_FONTS[0]).css;
}

/** The box's typeface, weight, slant and underline as CSS properties. */
export function textCss(t: Pick<TextBlock, 'fontFamily' | 'bold' | 'italic' | 'underline' | 'align' | 'lineHeight' | 'strike'>): {
  fontFamily: string;
  fontWeight: number;
  fontStyle: 'italic' | 'normal';
  textDecoration: string;
  textAlign: 'left' | 'center' | 'right';
  lineHeight: number;
} {
  return {
    fontFamily: fontStack(t.fontFamily),
    fontWeight: t.bold ? 700 : 400,
    fontStyle: t.italic ? 'italic' : 'normal',
    textDecoration: [t.underline ? 'underline' : '', t.strike ? 'line-through' : ''].filter(Boolean).join(' ') || 'none',
    textAlign: t.align ?? 'left',
    lineHeight: t.lineHeight ?? TEXT_LINE_HEIGHT,
  };
}

/** The same as one CSS declaration string (SVG export). */
export function textCssString(t: TextBlock): string {
  const c = textCss(t);
  return `font-family:${c.fontFamily.replace(/"/g, "'")};font-size:${t.fontSize}px;font-weight:${c.fontWeight};font-style:${c.fontStyle};text-decoration:${c.textDecoration};text-align:${c.textAlign};line-height:${c.lineHeight}`;
}

/** One piece of a text box's text and how it differs from the box (TextBlock.spans). */
export interface TextPiece {
  text: string;
  css: { fontWeight?: number; fontStyle?: 'italic' | 'normal'; textDecoration?: string; color?: string } | null;
}

/** The text cut where its styled parts (spans) start and end; one plain piece without spans. */
export function textPieces(t: Pick<TextBlock, 'text' | 'spans' | 'bold' | 'italic' | 'underline' | 'strike'>): TextPiece[] {
  const spans = (t.spans ?? []).filter((s) => s.end > s.start && s.start < t.text.length).sort((a, b) => a.start - b.start);
  if (!spans.length) return [{ text: t.text, css: null }];
  const out: TextPiece[] = [];
  let at = 0;
  for (const sp of spans) {
    const a = Math.max(at, sp.start), b = Math.min(t.text.length, sp.end);
    if (a > at) out.push({ text: t.text.slice(at, a), css: null });
    if (b <= a) continue;
    const underline = sp.underline ?? t.underline, strike = sp.strike ?? t.strike;
    out.push({
      text: t.text.slice(a, b),
      css: {
        ...(sp.bold !== undefined ? { fontWeight: sp.bold ? 700 : 400 } : {}),
        ...(sp.italic !== undefined ? { fontStyle: sp.italic ? ('italic' as const) : ('normal' as const) } : {}),
        ...(sp.underline !== undefined || sp.strike !== undefined ? { textDecoration: [underline ? 'underline' : '', strike ? 'line-through' : ''].filter(Boolean).join(' ') || 'none' } : {}),
        ...(sp.color ? { color: sp.color } : {}),
      },
    });
    at = b;
  }
  if (at < t.text.length) out.push({ text: t.text.slice(at), css: null });
  return out;
}

/** A canvas `font` value (rasterised previews). */
export function canvasFont(t: TextBlock): string {
  const c = textCss(t);
  return `${c.fontStyle === 'italic' ? 'italic ' : ''}${c.fontWeight} ${t.fontSize}px ${c.fontFamily}`;
}

/** Sizes one step up or down from `size`. */
export function nextTextSize(size: number, dir: 1 | -1): number {
  if (dir > 0) return TEXT_SIZES.find((s) => s > size + 0.01) ?? size;
  return [...TEXT_SIZES].reverse().find((s) => s < size - 0.01) ?? size;
}
