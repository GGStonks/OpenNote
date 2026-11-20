# Rust port: map

Goal: the native canvas finished (rust/DECISIONS.md ADR-001), released officially step by step
(ADR-003). Decisions: rust/DECISIONS.md. Canvas plan and rules: docs/rust-native-canvas.md.
Crate status: docs/rust-status.md.

| Step | What | State |
|---|---|---|
| C1 | Canvas rebuilt: the parallel engine deleted, modules on the TS page's structure, one owner of the GPU, no host pointers in the shells, wgpu errors never panic, Android crash capture, GLES after an abnormal end | done 2026-11-19: cargo test 101/101 incl. a 3-thread stress test, clippy -D warnings, Android + iOS builds, `npm run build`, `bench:ui` nativecanvas and rustcore (0 lines differ); the Tab A8 crash not reproduced (no Mali on the PC) |
| R2 | Release 2.9.6: V1 | done 2026-11-20: https://github.com/GGStonks/OpenNote/releases/tag/v2.9.6, verified |
| R1 | Release 2.9.5: C1 + crash capture, native canvas still opt-in | done 2026-11-19: https://github.com/GGStonks/OpenNote/releases/tag/v2.9.5, verified (tag, APK, IPA 2.9.5) |
| V1 | Rust owns scroll and zoom (N5, ADR-006): the device's best rate | done 2026-11-20: crates/viewport = useViewport.ts to 1e-9 on 1,616 reference rows; cargo test 150/150; `--native --only rustcamera`: DOM at rest within 0.001 px of the Rust camera, page lag p95 0.6 / max 1.85 page frames; 120 Hz feel to be checked on the iPad |
| V2 | Coherence and smoothness (ADR-006/007): canvas at the display rate, ink with the paper, the page and the fingers; Tab A8 never black | done 2026-11-20: ink vs paper 0.00 px; tick judder p95 20 -> 0.02-0.56 px; DOM vs ink p95 2-35 px on the PC stand-in (device to measure: crash log trailP50, alone, linkMs); canvas 80-120 Hz on iOS; never-black fallback; 2,000-page note: open 862 ms, ticks as the small note, 621k strokes drawn every frame (V3) |
| V3 | Scale (ADR-007): culling, lazy page streaming, GPU memory LRU, DOM virtualization; 2,000-page bench at the small note's frame timing | open |
| C2 | Pictures (N4): ImageBlock textures in z-order, crop, flip, rotation; decoded in Rust (image, resvg) | paused 2026-11-20 (stash "C2 pictures WIP"), resumes after V2 |
| C3 | PDF pages (N4): PdfRenderer / PDFKit textures at the zoom in view | open |
| C4 | Text boxes, formulas, TikZ as bitmaps from the web view (N5) | open |
| C5 | Selection frame, lasso, eraser circle, glow, live ink in the canvas (N3/N5) | open |
| C6 | Native canvas on by default; the page's ink retired (N7) | open, needs the owner's device check |

Out of scope (ADR-001): a Rust UI toolkit, native text editing, the shell owning scroll.
