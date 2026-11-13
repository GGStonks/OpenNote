# Rust port: where it stands

The plan is docs/rust-rewrite-roadmap.md. The port is developed on the `opennote-rs` branch
(origin `GGStonks/OpenNote`, branch `opennote-rs`). The app does not use any of it yet: what ships
is the TypeScript app in `src/`.

`npm run test:rust` (`cargo test --workspace`) runs every crate's tests. The ones that read
`bench/recordings` (nib's golden test does not) need the recordings, which are not in git.

| Crate | Ports | Checked against the TypeScript app | Not yet |
|---|---|---|---|
| `nib` | the ink engine (`src/ink/engine`) | **exactly**: `bench/engine-golden.json` to 1e-4 px (finished line, `nibStroke`), live line hash for hash on every sample (asserts 0 mismatches) | — |
| `model` | note types, packed points, sheets, migration, the `.opennote` codec | round trip of every recorded stroke and a backup, Rust against Rust, `split_into_pages`, `PaperColor::hex()` | reading the app's IndexedDB data (roadmap Phase 6) |
| `ink` | densify, widths, smoothing, dashes, geometry, live stroke, precision eraser, overshoot fixes | **point for point** on 36 recorded strokes (`crates/ink/tests/reference.rs` against `npm run bench:rustref -- bench/rust-ref/ink.json`): engine points, modelled line, widths, drawn line (`strokeGeometry`, 2.9.4's smoothing), live line, dash runs, and precision eraser to 1e-4 px; four overshoot mechanisms (`crates/ink/tests/overshoot_fixes.rs`): prediction purge on UP (`StrokePredictor`), liftoff jitter pressure gate (`filter_liftoff_jitter`), quadratic Bézier spline endpoint termination without straight pieces, critically damped spring (`CriticallyDampedSpring`); benches match 2.9.4 baseline | — |
| `shapes` | shape recognition, shape handles, selection, z-order | shape detection (line, arrow, polyline, triangle, rectangle, ellipse, circle), handles, lasso selection & transforms, z-layers & restamping | — |
| `import` | text, LaTeX, Word (`.docx`), Notability's FlatBuffers reader & plist | unit tests on FlatBuffer reader, mock docx, text/LaTeX parser | real `.note` files from device |
| `store` | SQLite storage (notes, folders, tags, files, thumbnails, audio, backup) | full CRUD, file/thumb storage, backup round-trip, transactions | reading the app's IndexedDB data (roadmap Phase 6) |
| `svg` | SVG export (`svgExport.ts`) | stroke paths, fills, dashed lines, text blocks, image blocks, multi-page document export | — |
| `renderer` | One renderer (Phase 2): SDF capsule rasterizer, paper patterns & colors, thumbnails | all 16 `glcompare` benchmark stroke kinds at x1.5 and x4 zoom, paper styles (ruled, lines, grid, graph, dots, blank) on light and dark paper, selection glow | device surface integration (Phase 3) |
| `canvas` | the page on the GPU (wgpu: Metal on iOS, Vulkan / GLES on Android), the passes of the page's WebGL ink (`glInk.ts`): coverage runs, even-odd fills, holes, hatches, arrows, paper patterns in WGSL; docs/rust-native-canvas.md N1-N2 | the CPU renderer (`crates/canvas/tests/compare.rs`) and the app's own canvas (`npm run bench:canvas`): on the 36 reference strokes at 1x and 4x, 100% of each one's ink within 1 px of the other's, total darkness within 1%; paper patterns (WGSL) and `CanvasHost` tested; builds for aarch64-apple-ios and aarch64-linux-android | device surface integration in shells (N2), pictures, PDF pages, blocks (N4, N5) |
| `native` | the app's entry point on the devices (iOS static library, Android JNI): `geometry` (the drawn lines of strokes), the live line while writing (`live.rs`, the shells' `r`), `renderThumbnail` (Phase 2 renderer bridge), `canvasRender` and `CanvasHost` FFI | the page's own lines through it: `bench:ui --only rustcore` (Rust check, 3,031 strokes, 0 differ), `crates/native/tests/geometry.rs` (every reference kind through the framing), `tests/live.rs` (57 live lines of the reference), `tests/render.rs` (thumbnail and GPU canvasRender through bridge, CanvasHost FFI lifecycle), `bench:ui --native --only rustlive` (the shell's Rust line = the page's `u` line), `tests/jni/run.sh` | a run on the devices |

Spikes present in `spikes/`:
- Spike A (`spike_a_ink`): 240 Hz coalesced touch ingestion buffer and 120 Hz render pipeline.
- Spike B (`spike_b_text`): Rich-text layout via `parley 0.12.0`.
- Spike C (`spike_c_formulas`): `mitex 0.2.4` math layout.
- Spike D (`spike_d_pdf`): `hayro 0.9.0` PDF rendering.
- Spike E (`spike_e_tikz`): `wasmi 2.0.0` running `tex.wasm`.
- Spike F (`spike_f_ui`): UI evaluation matrix.
