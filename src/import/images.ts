/**
 * Pictures for imported notes: decoded by the web view, cut to their crop, flipped, and kept at a
 * size that is sharp on the page without filling the library with camera-sized images.
 */

export interface Picture {
  dataUrl: string;
  /** Pixels of the result. */
  w: number;
  h: number;
}

export interface PictureOptions {
  /** The part of the source image to keep (source px). */
  crop?: { x: number; y: number; w: number; h: number } | null;
  flipH?: boolean;
  flipV?: boolean;
  /** Longest side of the result (px). */
  maxSide?: number;
}

function decode(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('not a readable image'));
    };
    img.src = url;
  });
}

export async function loadPicture(blob: Blob, o: PictureOptions = {}): Promise<Picture> {
  const img = await decode(blob);
  const iw = img.naturalWidth, ih = img.naturalHeight;
  const c0 = o.crop && o.crop.w > 0 && o.crop.h > 0 ? o.crop : { x: 0, y: 0, w: iw, h: ih };
  const crop = { x: Math.max(0, c0.x), y: Math.max(0, c0.y), w: Math.min(iw - Math.max(0, c0.x), c0.w), h: Math.min(ih - Math.max(0, c0.y), c0.h) };
  const s = Math.min(1, (o.maxSide ?? 2048) / Math.max(crop.w, crop.h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(crop.w * s));
  c.height = Math.max(1, Math.round(crop.h * s));
  const ctx = c.getContext('2d')!;
  ctx.setTransform(o.flipH ? -1 : 1, 0, 0, o.flipV ? -1 : 1, o.flipH ? c.width : 0, o.flipV ? c.height : 0);
  ctx.drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, c.width, c.height);
  // PNG keeps transparency; photos are smaller as JPEG.
  const png = blob.type === 'image/png' || blob.type === 'image/gif' || blob.type === 'image/webp';
  const out = { dataUrl: c.toDataURL(png ? 'image/png' : 'image/jpeg', 0.9), w: c.width, h: c.height };
  c.width = c.height = 0;
  return out;
}

/** A coloured rectangle as an image (a sticky note, a text box's background): exact, scalable. */
export function solidImage(color: string, w: number, h: number, radius = 0): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w.toFixed(2)} ${h.toFixed(2)}" preserveAspectRatio="none"><rect width="${w.toFixed(2)}" height="${h.toFixed(2)}" rx="${radius.toFixed(2)}" fill="${color}"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
