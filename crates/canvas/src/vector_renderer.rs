//! Vector Renderer: Industrial GPU Standard Pipeline with Ring Buffers and SDF Primitives for Infinite Zoom.

use crate::canvas_core::ViewMatrix;
use crate::geometry_engine::{OrientedBoundingBox, RectBounds, Vec2d};
use crate::spatial_index::SpatialIndex;
use bytemuck::{Pod, Zeroable};
use model::Stroke;

/// Pre-allocated Ring Buffer for dynamic GPU vertex/index streaming without heap allocations.
#[derive(Debug)]
pub struct DynamicRingBuffer<T: Copy + Pod> {
    pub buffer: Vec<T>,
    pub head: usize,
    pub capacity: usize,
}

impl<T: Copy + Pod + Default> DynamicRingBuffer<T> {
    pub fn new(capacity: usize) -> Self {
        DynamicRingBuffer {
            buffer: vec![T::default(); capacity],
            head: 0,
            capacity,
        }
    }

    /// Allocates `count` elements in the ring buffer.
    pub fn allocate(&mut self, count: usize) -> Result<(&mut [T], usize), &'static str> {
        if count > self.capacity {
            return Err("Requested size exceeds ring buffer capacity");
        }
        if self.head + count > self.capacity {
            self.head = 0; // Wrap around
        }
        let start = self.head;
        self.head += count;
        Ok((&mut self.buffer[start..start + count], start))
    }

    /// Resets the ring buffer head for a new frame.
    #[inline]
    pub fn reset(&mut self) {
        self.head = 0;
    }
}

/// SDF Eraser Cursor descriptor.
#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct EraserCursorSdf {
    pub center: [f32; 2],
    pub world_radius: f32,
    pub screen_radius: f32,
    pub border_width_px: f32,
    pub fill_color: [f32; 4],
    pub border_color: [f32; 4],
}

impl Default for EraserCursorSdf {
    fn default() -> Self {
        EraserCursorSdf {
            center: [0.0, 0.0],
            world_radius: 12.0,
            screen_radius: 24.0,
            border_width_px: 2.0,
            fill_color: [1.0, 0.2, 0.2, 0.18],
            border_color: [1.0, 0.1, 0.1, 0.95],
        }
    }
}

/// SDF Marching Ants Lasso segment descriptor.
#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct LassoSegmentSdf {
    pub p0: [f32; 2],
    pub p1: [f32; 2],
    pub dash_length_px: f32,
    pub gap_length_px: f32,
    pub phase_offset_px: f32,
    pub thickness_px: f32,
    pub stroke_color_a: [f32; 4],
    pub stroke_color_b: [f32; 4],
}

/// SDF Transform Handle descriptor.
#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct TransformHandleSdf {
    pub center: [f32; 2],
    pub size_px: f32,
    pub handle_type: u32, // 0: Corner, 1: Edge, 2: Rotation
    pub fill_color: [f32; 4],
    pub border_color: [f32; 4],
}

/// SDF Snap Guide Line descriptor.
#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SnapGuideSdf {
    pub start: [f32; 2],
    pub end: [f32; 2],
    pub thickness_px: f32,
    pub is_dashed: u32,
    pub color: [f32; 4],
}

/// Overlay Render Pass holding all real-time vector UI primitives (eraser cursor, lasso loop, handles, guides).
#[derive(Clone, Debug, Default)]
pub struct VectorOverlayPass {
    pub eraser_cursor: Option<EraserCursorSdf>,
    pub lasso_segments: Vec<LassoSegmentSdf>,
    pub handles: Vec<TransformHandleSdf>,
    pub snap_guides: Vec<SnapGuideSdf>,
    pub selection_bbox: Option<OrientedBoundingBox>,
}

impl VectorOverlayPass {
    pub fn clear(&mut self) {
        self.eraser_cursor = None;
        self.lasso_segments.clear();
        self.handles.clear();
        self.snap_guides.clear();
        self.selection_bbox = None;
    }

    /// Builds SDF marching ants segments for a lasso path.
    pub fn set_lasso_path(&mut self, path: &[Vec2d], is_closed: bool, time_sec: f64, vm: &ViewMatrix) {
        self.lasso_segments.clear();
        if path.len() < 2 {
            return;
        }
        let speed_px_sec = 24.0;
        let dash_length_px = 6.0;
        let gap_length_px = 6.0;
        let cycle_px = dash_length_px + gap_length_px;
        let phase = ((time_sec * speed_px_sec) % cycle_px as f64) as f32;

        let n = if is_closed { path.len() } else { path.len() - 1 };
        for i in 0..n {
            let p0 = path[i];
            let p1 = path[(i + 1) % path.len()];
            let sp0 = vm.world_to_screen(p0.x, p0.y);
            let sp1 = vm.world_to_screen(p1.x, p1.y);

            self.lasso_segments.push(LassoSegmentSdf {
                p0: [sp0.x as f32, sp0.y as f32],
                p1: [sp1.x as f32, sp1.y as f32],
                dash_length_px,
                gap_length_px,
                phase_offset_px: phase,
                thickness_px: 2.0,
                stroke_color_a: [0.1, 0.45, 0.95, 1.0], // Azure blue
                stroke_color_b: [1.0, 1.0, 1.0, 1.0],   // White
            });
        }
    }

    /// Sets up 8 transformation handles and 1 rotation handle for an oriented bounding box.
    pub fn set_selection_handles(&mut self, obb: &OrientedBoundingBox, vm: &ViewMatrix) {
        self.handles.clear();
        self.selection_bbox = Some(obb.clone());

        let handles_world = obb.handle_positions(28.0 / vm.scale.max(0.1));
        for (i, hw) in handles_world.iter().enumerate() {
            let sp = vm.world_to_screen(hw.x, hw.y);
            let is_rotation = i == 8;
            let is_corner = i == 0 || i == 2 || i == 4 || i == 6;

            self.handles.push(TransformHandleSdf {
                center: [sp.x as f32, sp.y as f32],
                size_px: if is_rotation { 14.0 } else { 12.0 },
                handle_type: if is_rotation { 2 } else if is_corner { 0 } else { 1 },
                fill_color: if is_rotation { [0.15, 0.7, 0.3, 1.0] } else { [1.0, 1.0, 1.0, 1.0] },
                border_color: [0.1, 0.45, 0.95, 1.0],
            });
        }
    }
}

/// Dynamic tessellation and frustum-culled vector scene collector.
pub struct VectorSceneCollector;

impl VectorSceneCollector {
    /// Performs frustum culling using the spatial index and extracts only visible strokes.
    pub fn cull_visible_strokes<'a>(
        spatial_index: &SpatialIndex,
        all_strokes: &'a [Stroke],
        visible_world_bounds: &RectBounds,
    ) -> Vec<&'a Stroke> {
        let visible_ids = spatial_index.query_intersects(visible_world_bounds);
        let id_set: std::collections::HashSet<&str> = visible_ids.iter().map(|s| s.as_str()).collect();

        all_strokes
            .iter()
            .filter(|s| {
                if s.id.is_empty() {
                    true
                } else {
                    id_set.contains(s.id.as_str())
                }
            })
            .collect()
    }
}
