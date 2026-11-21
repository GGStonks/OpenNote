#![allow(clippy::all)]
pub mod geometry;
pub mod nib;

pub use geometry::{
    has_real_pressure, pressure_width, sample_times, thin_modeled, thin_modeled_indices, InkPoint,
    ModeledPoint, XY,
};
pub use nib::{nib_stroke, NibModeler, NibParams, DEFAULT_NIB};
