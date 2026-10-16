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
export function textCss(t: Pick<TextBlock, 'fontFamily' | 'bold' | 'italic' | 'underline'>): {
  fontFamily: string;
  fontWeight: number;
  fontStyle: 'italic' | 'normal';
  textDecoration: 'underline' | 'none';
} {
  return {
    fontFamily: fontStack(t.fontFamily),
    fontWeight: t.bold ? 700 : 400,
    fontStyle: t.italic ? 'italic' : 'normal',
    textDecoration: t.underline ? 'underline' : 'none',
  };
}

/** The same as one CSS declaration string (SVG export). */
export function textCssString(t: TextBlock): string {
  const c = textCss(t);
  return `font-family:${c.fontFamily.replace(/"/g, "'")};font-size:${t.fontSize}px;font-weight:${c.fontWeight};font-style:${c.fontStyle};text-decoration:${c.textDecoration};line-height:${TEXT_LINE_HEIGHT}`;
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
