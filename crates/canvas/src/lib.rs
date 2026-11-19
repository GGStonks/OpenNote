//! The page drawn on the GPU (docs/rust-native-canvas.md): the page's own structure, module by
//! module, each naming its TypeScript counterpart.
//!
//! - `scene`: the page's z-layers of strokes as draw ops (`src/editor/zorder.ts`, CanvasPage.tsx's
//!   layers, glInk.ts's `Builder`).
//! - `paper`: a sheet's paper (CanvasPage.tsx `paperBackground`).
//! - `frame`: what the page shows this frame (the page's `canvasFrame` message: the desk colour,
//!   each placement's transform and paper), parsed and checked.
//! - `gpu`: the GPU objects (glInk.ts `GlInk`: programs, buffers, the coverage texture).
//! - `ink`: the passes of a frame (glInk.ts `draw` / `layOn`).
//! - `host`: a surface (a shell's layer or window) or an offscreen texture with the scenes and the
//!   frame, drawn on demand.
//!
//! `render_offscreen` is the PC path (tests, the CLI).

pub mod frame;
pub mod gpu;
pub mod host;
pub mod ink;
pub mod paper;
pub mod scene;
pub use wgpu;

pub use frame::{Frame, PageDraw};
pub use gpu::{
    pc_device, render_frame_offscreen, render_offscreen, GpuCanvas, GpuHealth, GpuScene,
};
pub use paper::Paper;
pub use scene::{CapInst, Op, PageBox, Scene, Transform};
