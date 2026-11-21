//! The page drawn on the GPU (docs/rust-native-canvas.md): the page's own structure, module by
//! module, each naming its TypeScript counterpart.
//!
//! - `scene`: the page's z-layers of strokes and pictures as draw ops (`src/editor/zorder.ts`, CanvasPage.tsx's
//!   layers, glInk.ts's `Builder`).
//! - `paper`: a sheet's paper (CanvasPage.tsx `paperBackground`).
//! - `picture`: the pictures' files (Blocks.tsx `ImageBlockView`'s `dataUrl`), decoded off the
//!   render thread at the size the zoom needs; `textures`: their textures on the device, within a
//!   memory budget.
//! - `frame`: what the page shows this frame (the page's `canvasFrame` message: the desk colour,
//!   each placement's transform and paper), parsed and checked.
//! - `gpu`: the GPU objects (glInk.ts `GlInk`: programs, buffers, the coverage texture).
//! - `ink`: the passes of a frame (glInk.ts `draw` / `layOn`).
//! - `cull`: which placements meet the view, without looking at the others (ADR-007).
//! - `pages`: each page's scene on the CPU and, near the view only, on the GPU (an LRU by bytes),
//!   and what the view still waits for (docs/rust-native-canvas.md "Scale").
//! - `host`: a surface (a shell's layer or window) or an offscreen texture with the scenes and the
//!   frame, drawn on demand.
//!
//! `render_offscreen` is the PC path (tests, the CLI).

#![allow(clippy::type_complexity, clippy::chunks_exact_to_as_chunks)]
pub mod cull;
pub mod frame;
pub mod gpu;
pub mod host;
pub mod ink;
pub mod pages;
pub mod paper;
pub mod picture;
pub mod scene;
pub mod telemetry;
pub mod textures;
pub use wgpu;

pub use frame::{Frame, PageDraw};
pub use gpu::{
    pc_device, render_frame_offscreen, render_offscreen, GpuCanvas, GpuHealth, GpuScene,
};
pub use paper::Paper;
pub use picture::Library;
pub use scene::{CapInst, ImageItem, Layer, Op, OpsLayer, PageBox, Scene, Transform};
pub use telemetry::{FrameSample, FrameStats, StatsSummary};
