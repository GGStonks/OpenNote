//! The note's camera while the native canvas draws it (rust/DECISIONS.md ADR-006,
//! docs/rust-native-canvas.md N5): the page's two-finger gestures (src/editor/useViewport.ts) and
//! their arithmetic (src/editor/viewportMath.ts) in Rust, advanced by the canvas's render thread
//! at the display's rate. Pure Rust: no GPU, nothing of the app.
//!
//! - [`math`]: the constants and arithmetic, checked against the TypeScript (tests/reference.rs).
//! - [`Viewport`]: the camera and the gesture moving it (`touch`, `tick`, the page's own views).
//! - [`record`]: each gesture's frames, for the crash report's `pinch` entries.

pub mod math;
pub mod record;
mod viewport;

pub use math::Anchor;
pub use record::{GestureRecorder, GestureSummary};
pub use viewport::{Camera, FitMode, Layout, Phase, SavedView, Viewport};
