pub mod geometry;
pub mod nib;

pub use geometry::{InkPoint, ModeledPoint, XY, has_real_pressure, pressure_width, sample_times, thin_modeled, thin_modeled_indices};
pub use nib::{DEFAULT_NIB, NibModeler, NibParams, nib_stroke};
