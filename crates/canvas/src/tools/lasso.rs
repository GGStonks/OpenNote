//! Lasso Tool: Vector marching-ants tracing, on_pointer_up selection, oriented bounding box, and exclusive outside-tap dismissal.

use crate::canvas_core::ViewMatrix;
use crate::geometry_engine::{OrientedBoundingBox, RectBounds, Vec2d};
use crate::spatial_index::SpatialIndex;
use crate::vector_renderer::VectorOverlayPass;
use model::{NotePage, Stroke};
use nib::geometry::XY;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum LassoPhase {
    Idle,
    Tracking,
    Selected,
    Transforming { handle_idx: usize, anchor: Vec2d, start_pos: Vec2d },
    Dragging { start_pos: Vec2d },
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ContextMenuAction {
    pub id: &'static str,
    pub title: &'static str,
}

pub const LASSO_CONTEXT_MENU_ACTIONS: &[ContextMenuAction] = &[
    ContextMenuAction { id: "cut", title: "Cut" },
    ContextMenuAction { id: "copy", title: "Copy" },
    ContextMenuAction { id: "duplicate", title: "Duplicate" },
    ContextMenuAction { id: "delete", title: "Delete" },
    ContextMenuAction { id: "change_color", title: "Change Color" },
    ContextMenuAction { id: "resize", title: "Resize" },
];

#[derive(Clone, Debug)]
pub struct LassoTool {
    pub phase: LassoPhase,
    pub raw_path: Vec<Vec2d>,
    pub selected_ids: Vec<String>,
    pub selection_bbox: Option<OrientedBoundingBox>,
    pub is_menu_open: bool,
    pub last_timestamp_ms: f64,
}

impl Default for LassoTool {
    fn default() -> Self {
        LassoTool {
            phase: LassoPhase::Idle,
            raw_path: Vec::new(),
            selected_ids: Vec::new(),
            selection_bbox: None,
            is_menu_open: false,
            last_timestamp_ms: 0.0,
        }
    }
}

impl LassoTool {
    pub fn new() -> Self {
        Self::default()
    }

    /// Handles pointer down: either starts a new lasso or interacts with an existing selection.
    pub fn on_pointer_down(&mut self, world_pos: Vec2d, timestamp_ms: f64) -> bool {
        self.last_timestamp_ms = timestamp_ms;

        if let Some(bbox) = &self.selection_bbox {
            // Check if user tapped a transform handle (within 24px tolerance)
            if let Some(handle_idx) = bbox.hit_test_handle(world_pos, 16.0) {
                let corners = bbox.corners();
                let anchor = corners[(handle_idx + 2) % 4];
                self.phase = LassoPhase::Transforming {
                    handle_idx,
                    anchor,
                    start_pos: world_pos,
                };
                return true;
            }

            // Check if user tapped inside the selection bounding box (to drag/move)
            if bbox.contains_point(world_pos) {
                self.phase = LassoPhase::Dragging { start_pos: world_pos };
                return true;
            }

            // Check if user tapped explicitly OUTSIDE the selection bounding box (with safety margin)
            if bbox.is_point_outside(world_pos, 12.0) {
                // Exclusive dismissal requirement: close menu and clear selection!
                self.clear_selection();
                return false;
            }

            // Otherwise, touch was on boundary or near handle: ignore to prevent accidental dismiss
            return true;
        }

        // Start drawing new lasso
        self.phase = LassoPhase::Tracking;
        self.raw_path.clear();
        self.raw_path.push(world_pos);
        true
    }

    /// Handles pointer move: appends points to the lasso path without computing selection.
    pub fn on_pointer_move(&mut self, world_pos: Vec2d, timestamp_ms: f64) {
        self.last_timestamp_ms = timestamp_ms;

        match self.phase {
            LassoPhase::Tracking => {
                // Only collect points, never run selection during movement (per spec)
                if let Some(last) = self.raw_path.last() {
                    if last.distance_sq(world_pos) >= 4.0 {
                        self.raw_path.push(world_pos);
                    }
                } else {
                    self.raw_path.push(world_pos);
                }
            }
            LassoPhase::Dragging { ref mut start_pos } => {
                let delta = world_pos.sub(*start_pos);
                if let Some(bbox) = &mut self.selection_bbox {
                    bbox.center = bbox.center.add(delta);
                }
                *start_pos = world_pos;
            }
            LassoPhase::Transforming { handle_idx: _, anchor: _, ref mut start_pos } => {
                // Resize / transform update
                *start_pos = world_pos;
            }
            _ => {}
        }
    }

    /// Handles pointer up (`TouchPhase::Ended`): EXCLUSIVELY triggers selection calculation.
    pub fn on_pointer_up(
        &mut self,
        _world_pos: Vec2d,
        timestamp_ms: f64,
        strokes: &[Stroke],
        spatial_index: &SpatialIndex,
    ) -> bool {
        self.last_timestamp_ms = timestamp_ms;

        match self.phase {
            LassoPhase::Tracking => {
                if self.raw_path.len() >= 3 {
                    // Pre-cull candidate strokes using the lasso polygon AABB from spatial index
                    let poly_aabb = RectBounds::from_points(&self.raw_path);
                    let candidate_ids = spatial_index.query_intersects(&poly_aabb);
                    let candidate_set: std::collections::HashSet<&str> =
                        candidate_ids.iter().map(|s| s.as_str()).collect();

                    let candidate_strokes: Vec<Stroke> = strokes
                        .iter()
                        .filter(|s| candidate_set.contains(s.id.as_str()))
                        .cloned()
                        .collect();

                    let candidate_page = NotePage {
                        id: String::new(),
                        page_number: 0,
                        strokes: candidate_strokes,
                        latex_blocks: Vec::new(),
                        text_blocks: None,
                        image_blocks: None,
                    };

                    let lasso_xy: Vec<XY> = self
                        .raw_path
                        .iter()
                        .map(|p| XY { x: p.x, y: p.y })
                        .collect();

                    let selection = shapes::selection::lasso_select_page(&lasso_xy, &candidate_page);

                    #[cfg(debug_assertions)]
                    {
                        let full_page = NotePage {
                            id: String::new(),
                            page_number: 0,
                            strokes: strokes.to_vec(),
                            latex_blocks: Vec::new(),
                            text_blocks: None,
                            image_blocks: None,
                        };
                        let unfiltered = shapes::selection::lasso_select_page(&lasso_xy, &full_page);
                        debug_assert_eq!(
                            selection.stroke_ids, unfiltered.stroke_ids,
                            "prefiltered lasso selection must equal unfiltered call"
                        );
                    }

                    if !selection.stroke_ids.is_empty() {
                        let captured_bounds = if let Some(b) = selection.bounds {
                            RectBounds::new(b.min_x, b.min_y, b.max_x, b.max_y)
                        } else {
                            let mut cb = RectBounds::default();
                            for id in &selection.stroke_ids {
                                if let Some(s) = strokes.iter().find(|s| &s.id == id) {
                                    for p in &s.points {
                                        cb.include(Vec2d::new(p.x, p.y));
                                    }
                                }
                            }
                            cb
                        };
                        let obb = OrientedBoundingBox::from_aabb(&captured_bounds);
                        self.selected_ids = selection.stroke_ids;
                        self.selection_bbox = Some(obb);
                        // Show contextual interaction menu and vector handles
                        self.is_menu_open = true;
                        self.phase = LassoPhase::Selected;
                        return true;
                    }
                }

                // If nothing was selected or path was too short, reset
                self.clear_selection();
                false
            }
            LassoPhase::Dragging { .. } | LassoPhase::Transforming { .. } => {
                self.phase = LassoPhase::Selected;
                true
            }
            _ => false,
        }
    }

    /// Explicitly closes the selection and menu (on outside tap).
    pub fn clear_selection(&mut self) {
        self.phase = LassoPhase::Idle;
        self.raw_path.clear();
        self.selected_ids.clear();
        self.selection_bbox = None;
        self.is_menu_open = false;
    }

    /// Prepares real-time vector UI overlays (marching ants or transform handles).
    pub fn update_overlay(&self, overlay: &mut VectorOverlayPass, vm: &ViewMatrix) {
        match self.phase {
            LassoPhase::Tracking => {
                let time_sec = self.last_timestamp_ms * 0.001;
                overlay.set_lasso_path(&self.raw_path, false, time_sec, vm);
            }
            LassoPhase::Selected | LassoPhase::Dragging { .. } | LassoPhase::Transforming { .. } => {
                if let Some(bbox) = &self.selection_bbox {
                    overlay.set_selection_handles(bbox, vm);
                }
            }
            LassoPhase::Idle => {}
        }
    }
}
