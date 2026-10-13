/**
 * FROZEN — Nib v1 (OpenNote 1.8.5, git tag nib-engine-v1). The owner's decision: this engine is
 * final and must not be changed. `npm run test:engine` (run by every build) compares its output
 * with bench/engine-golden.json and fails on any difference. New features (shape tools, other
 * platforms) use the engine through this API; they never edit src/ink/engine.
 *
 * OpenNote's ink engine (Nib): handwriting model, ink geometry and the live stroke painter.
 *
 * Self-contained: nothing in src/ink/engine imports from the rest of the app. Input is raw pen
 * samples (page px, ms, force 0..1); output is the modelled centre line with pressure, ready to be
 * drawn as a union of pressure-sized capsules.
 *
 *   nib.ts         NibModeler (streaming model) and nibStroke (a whole stroke)
 *   liveStroke.ts  LiveStroke: the stroke being written, painted incrementally on a canvas
 *   geometry.ts    point types, pressure width, capsule paths (canvas and SVG)
 */
export { NIB, NibModeler, nibStroke } from './nib';
export { LiveStroke } from './liveStroke';
export type { LiveStyle, Rect } from './liveStroke';
export { addCapsule, capsulePath, capsuleSvg, hasRealPressure, pressureWidth, sampleTimes, thinModeled } from './geometry';
export type { InkPoint, ModeledPoint, XY } from './geometry';
