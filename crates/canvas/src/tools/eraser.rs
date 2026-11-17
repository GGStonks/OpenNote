//! Vector Eraser: SDF circle cursor, Object Eraser (instant deletion via R-Tree), and Precision Eraser (geometric splitting).

use crate::canvas_core::ViewMatrix;
use crate::geometry_engine::{distance_to_segment, Vec2d};
use crate::spatial_index::SpatialIndex;
use crate::vector_renderer::{EraserCursorSdf, VectorOverlayPass};
use model::Stroke;

#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum EraserMode {
    Object,
    Precision,
}

#[derive(Clone, Debug)]
pub struct EraserResult {
    pub removed_stroke_ids: Vec<String>,
    pub split_replacements: Vec<(String, Vec<Stroke>)>, // (original_id, new_pieces)
}

#[derive(Clone, Debug)]
pub struct EraserTool {
    pub mode: EraserMode,
    pub radius: f64,
    pub prev_pos: Option<Vec2d>,
    pub current_pos: Option<Vec2d>,
}

impl Default for EraserTool {
    fn default() -> Self {
        EraserTool {
            mode: EraserMode::Object,
            radius: 16.0,
            prev_pos: None,
            current_pos: None,
        }
    }
}

impl EraserTool {
    pub fn new(mode: EraserMode, radius: f64) -> Self {
        EraserTool {
            mode,
            radius,
            prev_pos: None,
            current_pos: None,
        }
    }

    pub fn on_pointer_down(&mut self, world_pos: Vec2d) {
        self.prev_pos = Some(world_pos);
        self.current_pos = Some(world_pos);
    }

    pub fn on_pointer_up(&mut self) {
        self.prev_pos = None;
        self.current_pos = None;
    }

    /// Performs erasing along the segment from `prev_pos` to `curr_pos`.
    pub fn erase_step(
        &mut self,
        curr_pos: Vec2d,
        strokes: &[Stroke],
        spatial_index: &SpatialIndex,
    ) -> EraserResult {
        let p0 = self.prev_pos.unwrap_or(curr_pos);
        let p1 = curr_pos;
        self.prev_pos = Some(p1);
        self.current_pos = Some(p1);

        let mut result = EraserResult {
            removed_stroke_ids: Vec::new(),
            split_replacements: Vec::new(),
        };

        // Spatial query for candidate strokes within radius of path segment
        let candidate_ids = spatial_index.query_segment(p0, p1, self.radius + 20.0);
        let candidate_set: std::collections::HashSet<&str> =
            candidate_ids.iter().map(|s| s.as_str()).collect();

        for stroke in strokes {
            let id = stroke.id.as_str();
            if !candidate_set.contains(id) {
                continue;
            }

            match self.mode {
                EraserMode::Object => {
                    if stroke_intersects_segment(stroke, p0, p1, self.radius) {
                        result.removed_stroke_ids.push(id.to_string());
                    }
                }
                EraserMode::Precision => {
                    let mut make_id = || format!("{}-{}", stroke.id, nanoid_short());
                    let (pieces, changed) = ink::erase_strokes_partial(
                        std::slice::from_ref(stroke),
                        p1.x,
                        p1.y,
                        self.radius,
                        &mut make_id,
                        None,
                    );
                    if changed {
                        result.split_replacements.push((id.to_string(), pieces));
                    }
                }
            }
        }

        result
    }

    /// Prepares real-time vector UI overlay for the eraser cursor.
    pub fn update_overlay(&self, overlay: &mut VectorOverlayPass, vm: &ViewMatrix) {
        if let Some(pos) = self.current_pos {
            let sp = vm.world_to_screen(pos.x, pos.y);
            let screen_radius = (self.radius * vm.scale) as f32;

            overlay.eraser_cursor = Some(EraserCursorSdf {
                center: [sp.x as f32, sp.y as f32],
                world_radius: self.radius as f32,
                screen_radius,
                border_width_px: 2.0,
                fill_color: [1.0, 0.2, 0.2, 0.16],
                border_color: [1.0, 0.1, 0.1, 0.95],
            });
        }
    }
}

/// Hit-tests whether a stroke's rendered path comes within `radius` of segment (a, b).
fn stroke_intersects_segment(stroke: &Stroke, a: Vec2d, b: Vec2d, radius: f64) -> bool {
    let effective_r = radius
        + (if stroke.tool == "highlighter" {
            stroke.width * 2.75
        } else {
            stroke.width * 0.9
        });

    let pts = &stroke.points;
    if pts.is_empty() {
        return false;
    }
    if pts.len() == 1 {
        let p = Vec2d::new(pts[0].x, pts[0].y);
        return distance_to_segment(p, a, b) <= effective_r;
    }

    for i in 1..pts.len() {
        let sp0 = Vec2d::new(pts[i - 1].x, pts[i - 1].y);
        let sp1 = Vec2d::new(pts[i].x, pts[i].y);
        // Distance between two segments (sp0, sp1) and (a, b)
        let mid = sp0.lerp(sp1, 0.5);
        if distance_to_segment(mid, a, b) <= effective_r {
            return true;
        }
        if distance_to_segment(sp0, a, b) <= effective_r || distance_to_segment(sp1, a, b) <= effective_r {
            return true;
        }
    }
    false
}

fn nanoid_short() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    format!("{:x}", COUNTER.fetch_add(1, Ordering::Relaxed))
}
