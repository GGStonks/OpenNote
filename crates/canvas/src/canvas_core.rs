//! Canvas Core: ViewMatrix with f64 precision, Viewport camera, Frustum Culling, and Triple Buffering.

use crate::geometry_engine::{RectBounds, Vec2d};
use crate::Transform;

/// Affine 2D camera transformation in double precision (f64) to eliminate jitter at extreme zoom.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ViewMatrix {
    pub scale: f64,
    pub offset_x: f64,
    pub offset_y: f64,
}

impl Default for ViewMatrix {
    fn default() -> Self {
        ViewMatrix {
            scale: 1.0,
            offset_x: 0.0,
            offset_y: 0.0,
        }
    }
}

impl ViewMatrix {
    #[inline]
    pub const fn new(scale: f64, offset_x: f64, offset_y: f64) -> Self {
        ViewMatrix { scale, offset_x, offset_y }
    }

    /// Converts screen pixel coordinates to world/page coordinates in double precision.
    #[inline]
    pub fn screen_to_world(&self, screen_x: f64, screen_y: f64) -> Vec2d {
        let inv_scale = 1.0 / self.scale.max(1e-9);
        Vec2d {
            x: (screen_x - self.offset_x) * inv_scale,
            y: (screen_y - self.offset_y) * inv_scale,
        }
    }

    /// Converts world/page coordinates to screen pixel coordinates in double precision.
    #[inline]
    pub fn world_to_screen(&self, world_x: f64, world_y: f64) -> Vec2d {
        Vec2d {
            x: world_x * self.scale + self.offset_x,
            y: world_y * self.scale + self.offset_y,
        }
    }

    /// Converts the f64 affine transform into a GPU f32 `Transform` struct.
    #[inline]
    pub fn to_transform32(&self) -> Transform {
        Transform {
            a: self.scale as f32,
            b: 0.0,
            c: 0.0,
            d: self.scale as f32,
            ox: self.offset_x as f32,
            oy: self.offset_y as f32,
        }
    }

    /// Pans the camera by (dx, dy) in screen pixels.
    #[inline]
    pub fn pan(&mut self, dx: f64, dy: f64) {
        self.offset_x += dx;
        self.offset_y += dy;
    }

    /// Zooms around a specific screen anchor point (e.g. pinch midpoint).
    #[inline]
    pub fn zoom_at(&mut self, factor: f64, screen_center_x: f64, screen_center_y: f64) {
        let prev_scale = self.scale;
        let new_scale = (self.scale * factor).clamp(0.05, 50.0);
        let ratio = new_scale / prev_scale;

        self.offset_x = screen_center_x - (screen_center_x - self.offset_x) * ratio;
        self.offset_y = screen_center_y - (screen_center_y - self.offset_y) * ratio;
        self.scale = new_scale;
    }
}

/// Canvas Viewport representing screen dimensions and display pixel density.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Viewport {
    pub width: f64,
    pub height: f64,
    pub native_scale: f64,
}

impl Default for Viewport {
    fn default() -> Self {
        Viewport {
            width: 1024.0,
            height: 768.0,
            native_scale: 2.0,
        }
    }
}

impl Viewport {
    pub const fn new(width: f64, height: f64, native_scale: f64) -> Self {
        Viewport { width, height, native_scale }
    }

    /// Computes the visible bounding box in world space (for frustum culling).
    pub fn visible_world_bounds(&self, vm: &ViewMatrix) -> RectBounds {
        let tl = vm.screen_to_world(0.0, 0.0);
        let br = vm.screen_to_world(self.width, self.height);
        RectBounds::new(
            tl.x.min(br.x),
            tl.y.min(br.y),
            tl.x.max(br.x),
            tl.y.max(br.y),
        )
    }

    /// Converts physical device pixels to logical points.
    #[inline]
    pub fn device_to_logical(&self, px: f64) -> f64 {
        px / self.native_scale.max(1.0)
    }

    /// Converts logical points to physical device pixels.
    #[inline]
    pub fn logical_to_device(&self, pt: f64) -> f64 {
        pt * self.native_scale
    }
}

/// Triple Buffering and Frame Lifecycle Controller.
#[derive(Clone, Debug)]
pub struct FramePipeline {
    pub current_buffer_idx: usize,
    pub is_dirty: bool,
    pub dirty_rect: Option<RectBounds>,
    pub frame_counter: u64,
    pub active_animations: usize,
}

impl Default for FramePipeline {
    fn default() -> Self {
        FramePipeline {
            current_buffer_idx: 0,
            is_dirty: true,
            dirty_rect: None,
            frame_counter: 0,
            active_animations: 0,
        }
    }
}

impl FramePipeline {
    pub fn new() -> Self {
        Self::default()
    }

    /// Marks the pipeline dirty with an optional incremental dirty-rect.
    pub fn mark_dirty(&mut self, rect: Option<RectBounds>) {
        let was_dirty = self.is_dirty;
        self.is_dirty = true;
        match (self.dirty_rect, rect) {
            (Some(existing), Some(new_rect)) => {
                self.dirty_rect = Some(existing.union(&new_rect));
            }
            // Already dirty in full: a rect must not shrink that to the rect.
            (None, Some(new_rect)) if !was_dirty => {
                self.dirty_rect = Some(new_rect);
            }
            _ => {
                self.dirty_rect = None; // Full frame dirty
            }
        }
    }

    /// Determines whether GPU rendering is needed this frame.
    #[inline]
    pub fn should_render(&self) -> bool {
        self.is_dirty || self.active_animations > 0
    }

    /// Advances the triple buffer index after submission (0 -> 1 -> 2 -> 0).
    pub fn advance_frame(&mut self) -> usize {
        let presented = self.current_buffer_idx;
        self.current_buffer_idx = (self.current_buffer_idx + 1) % 3;
        self.frame_counter += 1;
        self.is_dirty = false;
        self.dirty_rect = None;
        presented
    }
}
