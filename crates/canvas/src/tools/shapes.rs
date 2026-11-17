//! Interactive Shapes: Hold-to-Shape (~350ms) detection via SmartPen (T4), vertex handles, magnetic angle snap, and live vector deformation.

use crate::canvas_core::ViewMatrix;
use crate::geometry_engine::Vec2d;
use crate::vector_renderer::{SnapGuideSdf, TransformHandleSdf, VectorOverlayPass};
use model::Stroke;
use nib::geometry::XY;
use shapes::edit::{drag_handle, move_shape_handle, HandleRole, ShapeHandle};
use shapes::smart_pen::{ShapeMode, SmartPen, SmartPenConfig, SmartPenTool};

pub enum ShapeToolState {
    Idle,
    Drawing {
        smart_pen: SmartPen,
        snapped_preview: Option<Stroke>,
    },
    Editing {
        selected_stroke: Stroke,
        active_handle: Option<usize>,
    },
}

impl std::fmt::Debug for ShapeToolState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Idle => write!(f, "Idle"),
            Self::Drawing { snapped_preview, .. } => f
                .debug_struct("Drawing")
                .field("snapped_preview", snapped_preview)
                .finish(),
            Self::Editing {
                selected_stroke,
                active_handle,
            } => f
                .debug_struct("Editing")
                .field("selected_stroke", selected_stroke)
                .field("active_handle", active_handle)
                .finish(),
        }
    }
}

impl Clone for ShapeToolState {
    fn clone(&self) -> Self {
        match self {
            Self::Idle => Self::Idle,
            Self::Drawing {
                smart_pen,
                snapped_preview,
            } => {
                let mut sp = SmartPen::new(SmartPenConfig {
                    tool: SmartPenTool::Shape(ShapeMode::Curve),
                    hold_threshold_ms: Some(350.0),
                    ..Default::default()
                });
                for s in smart_pen.samples() {
                    sp.add_sample(s.x, s.y, s.t, s.pressure);
                }
                Self::Drawing {
                    smart_pen: sp,
                    snapped_preview: snapped_preview.clone(),
                }
            }
            Self::Editing {
                selected_stroke,
                active_handle,
            } => Self::Editing {
                selected_stroke: selected_stroke.clone(),
                active_handle: *active_handle,
            },
        }
    }
}

pub struct ShapeTool {
    pub state: ShapeToolState,
    pub magnetic_angle_snap_enabled: bool,
    pub active_snap_guide: Option<[Vec2d; 2]>,
}

impl std::fmt::Debug for ShapeTool {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ShapeTool")
            .field("state", &self.state)
            .field("magnetic_angle_snap_enabled", &self.magnetic_angle_snap_enabled)
            .field("active_snap_guide", &self.active_snap_guide)
            .finish()
    }
}

impl Clone for ShapeTool {
    fn clone(&self) -> Self {
        Self {
            state: self.state.clone(),
            magnetic_angle_snap_enabled: self.magnetic_angle_snap_enabled,
            active_snap_guide: self.active_snap_guide,
        }
    }
}

impl Default for ShapeTool {
    fn default() -> Self {
        ShapeTool {
            state: ShapeToolState::Idle,
            magnetic_angle_snap_enabled: true,
            active_snap_guide: None,
        }
    }
}

impl ShapeTool {
    pub fn new() -> Self {
        Self::default()
    }

    /// Handles pointer down: initiates drawing or selects handle.
    pub fn on_pointer_down(&mut self, pos: Vec2d, timestamp_ms: f64) {
        self.active_snap_guide = None;
        if let ShapeToolState::Editing { selected_stroke, .. } = &self.state {
            // Check if tapped a vertex handle
            if let Some(handle_idx) = hit_test_shape_vertices(selected_stroke, pos, 14.0) {
                self.state = ShapeToolState::Editing {
                    selected_stroke: selected_stroke.clone(),
                    active_handle: Some(handle_idx),
                };
                return;
            }
        }

        let mut smart_pen = SmartPen::new(SmartPenConfig {
            tool: SmartPenTool::Shape(ShapeMode::Curve),
            hold_threshold_ms: Some(350.0),
            ..Default::default()
        });
        smart_pen.add_sample(pos.x, pos.y, timestamp_ms, 1.0);
        self.state = ShapeToolState::Drawing {
            smart_pen,
            snapped_preview: None,
        };
    }

    /// Handles pointer move: tracks standstill via SmartPen (~350ms) or updates dragged vertex.
    pub fn on_pointer_move(&mut self, pos: Vec2d, timestamp_ms: f64) {
        match &mut self.state {
            ShapeToolState::Drawing {
                smart_pen,
                snapped_preview,
            } => {
                smart_pen.add_sample(pos.x, pos.y, timestamp_ms, 1.0);
                if smart_pen.is_snapped() {
                    *snapped_preview = smart_pen.snapped_stroke().cloned();
                }
            }
            ShapeToolState::Editing {
                selected_stroke,
                active_handle: Some(handle_idx),
            } => {
                let target = XY { x: pos.x, y: pos.y };
                let handle = ShapeHandle {
                    x: selected_stroke.points.get(*handle_idx).map(|p| p.x).unwrap_or(pos.x),
                    y: selected_stroke.points.get(*handle_idx).map(|p| p.y).unwrap_or(pos.y),
                    role: HandleRole::Vertex,
                    index: *handle_idx as isize,
                    anchor: None,
                };

                if self.magnetic_angle_snap_enabled {
                    let (new_stroke, guide) = move_shape_handle(selected_stroke, &handle, target, None, None);
                    *selected_stroke = new_stroke;
                    self.active_snap_guide = guide.and_then(|g| {
                        g.line.map(|[a, b]| [Vec2d::new(a.x, a.y), Vec2d::new(b.x, b.y)])
                    });
                } else {
                    *selected_stroke = drag_handle(selected_stroke, &handle, target);
                    self.active_snap_guide = None;
                }
            }
            _ => {}
        }
    }

    /// Handles pointer up: finalizes stroke creation or handle edit.
    pub fn on_pointer_up(&mut self) -> Option<Stroke> {
        self.active_snap_guide = None;
        match std::mem::replace(&mut self.state, ShapeToolState::Idle) {
            ShapeToolState::Drawing {
                smart_pen,
                snapped_preview,
            } => {
                if let Some(snapped) = snapped_preview {
                    self.state = ShapeToolState::Editing {
                        selected_stroke: snapped.clone(),
                        active_handle: None,
                    };
                    Some(snapped)
                } else if let Some(st) = smart_pen.finish() {
                    Some(st)
                } else {
                    None
                }
            }
            ShapeToolState::Editing { selected_stroke, .. } => {
                let st = selected_stroke.clone();
                self.state = ShapeToolState::Editing {
                    selected_stroke,
                    active_handle: None,
                };
                Some(st)
            }
            ShapeToolState::Idle => None,
        }
    }

    /// Updates vector UI overlays (vertex handles and magnetic alignment snap guides).
    pub fn update_overlay(&self, overlay: &mut VectorOverlayPass, vm: &ViewMatrix) {
        match &self.state {
            ShapeToolState::Drawing {
                snapped_preview: Some(snapped),
                ..
            } => {
                // Show preview of snapped vertices
                for pt in &snapped.points {
                    let sp = vm.world_to_screen(pt.x, pt.y);
                    overlay.handles.push(TransformHandleSdf {
                        center: [sp.x as f32, sp.y as f32],
                        size_px: 10.0,
                        handle_type: 0,
                        fill_color: [0.1, 0.5, 1.0, 1.0],
                        border_color: [1.0, 1.0, 1.0, 1.0],
                    });
                }
            }
            ShapeToolState::Editing {
                selected_stroke,
                active_handle,
            } => {
                for (i, pt) in selected_stroke.points.iter().enumerate() {
                    let sp = vm.world_to_screen(pt.x, pt.y);
                    let is_active = Some(i) == *active_handle;
                    overlay.handles.push(TransformHandleSdf {
                        center: [sp.x as f32, sp.y as f32],
                        size_px: if is_active { 14.0 } else { 10.0 },
                        handle_type: 0,
                        fill_color: if is_active { [1.0, 0.4, 0.1, 1.0] } else { [1.0, 1.0, 1.0, 1.0] },
                        border_color: [0.1, 0.45, 0.95, 1.0],
                    });
                }

                // If dragging with snap, show magnetic alignment guide
                if let Some([p0, p1]) = self.active_snap_guide {
                    let sp0 = vm.world_to_screen(p0.x, p0.y);
                    let sp1 = vm.world_to_screen(p1.x, p1.y);
                    overlay.snap_guides.push(SnapGuideSdf {
                        start: [sp0.x as f32, sp0.y as f32],
                        end: [sp1.x as f32, sp1.y as f32],
                        thickness_px: 1.5,
                        is_dashed: 1,
                        color: [0.2, 0.7, 0.3, 0.9],
                    });
                }
            }
            _ => {}
        }
    }
}

fn hit_test_shape_vertices(stroke: &Stroke, pos: Vec2d, tolerance: f64) -> Option<usize> {
    let tol_sq = tolerance * tolerance;
    for (i, p) in stroke.points.iter().enumerate() {
        let v = Vec2d::new(p.x, p.y);
        if pos.distance_sq(v) <= tol_sq {
            return Some(i);
        }
    }
    None
}
