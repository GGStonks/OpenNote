//! OpenNote Ultra-Low-Latency Vector Mirroring (`crates/remote`).
//!
//! Real-time streaming of raw binary vector deltas (camera, live strokes, commits, laser pointer)
//! from tablet to PC with zero-install Web viewer and native desktop receiver.

pub mod protocol;
pub mod server;

pub use protocol::*;
pub use server::*;
