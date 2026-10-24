import { Stroke } from '../types';

/**
 * Strokes loaded from storage keep their points packed (db.ts: x, y, pressure, t, alt, az per point)
 * until something reads `points`. Code that only needs a coordinate range reads it here, without
 * making an object per point (the library would otherwise unpack every note).
 */
export const PACKED_STRIDE = 6;
export const packedPoints = new WeakMap<Stroke, Float64Array>();
