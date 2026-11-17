//! Interactive Shapes: Hold-to-Shape (~350ms) detection, vertex handles, magnetic angle snap, and live vector deformation.

use crate::canvas_core::ViewMatrix;
use crate::geometry_engine::{snap_angle_cardinal, Vec2d};
use crate::vector_renderer::{SnapGuideSdf, TransformHandleSdf, VectorOverlayPass};
use model::{Point, ShapeKind, Stroke};
use std::f64::consts::PI;

const HOLD_TO_SHAPE_THRESHOLD_MS: f64 = 350.0;
const STANDSTILL_RADIUS_SQ: f64 = 16.0; // 4px standstill tolerance squared

#[derive(Clone, Debug, PartialEq)]
pub enum ShapeToolState {
    Idle,
    Drawing {
        start_time_ms: f64,
        last_move_time_ms: f64,
        anchor_pos: Vec2d,
        raw_points: Vec<Point>,
        snapped_preview: Option<Stroke>,
    },
    Editing {
        selected_stroke: Stroke,
        active_handle: Option<usize>,
    },
}

#[derive(Clone, Debug)]
pub struct ShapeTool {
    pub state: ShapeToolState,
    pub magnetic_angle_snap_enabled: bool,
}

impl Default for ShapeTool {
    fn default() -> Self {
        ShapeTool {
            state: ShapeToolState::Idle,
            magnetic_angle_snap_enabled: true,
        }
    }
}

impl ShapeTool {
    pub fn new() -> Self {
        Self::default()
    }

    /// Handles pointer down: initiates drawing or selects handle.
    pub fn on_pointer_down(&mut self, pos: Vec2d, timestamp_ms: f64) {
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

        self.state = ShapeToolState::Drawing {
            start_time_ms: timestamp_ms,
            last_move_time_ms: timestamp_ms,
            anchor_pos: pos,
            raw_points: vec![Point {
                x: pos.x,
                y: pos.y,
                pressure: 1.0,
                t: Some(timestamp_ms),
                alt: None,
                az: None,
            }],
            snapped_preview: None,
        };
    }

    /// Handles pointer move: tracks standstill for Hold-to-Shape (~350ms) or updates dragged vertex.
    pub fn on_pointer_move(&mut self, pos: Vec2d, timestamp_ms: f64) {
        match &mut self.state {
            ShapeToolState::Drawing {
                last_move_time_ms,
                anchor_pos,
                raw_points,
                snapped_preview,
                ..
            } => {
                let dist_sq = pos.distance_sq(*anchor_pos);
                if dist_sq > STANDSTILL_RADIUS_SQ {
                    // Pen is moving: reset standstill anchor
                    *anchor_pos = pos;
                    *last_move_time_ms = timestamp_ms;
                    *snapped_preview = None;
                } else if timestamp_ms - *last_move_time_ms >= HOLD_TO_SHAPE_THRESHOLD_MS {
                    // User held pen still for >= 350ms: Trigger Hold-to-Shape recognition!
                    if snapped_preview.is_none() && raw_points.len() >= 2 {
                        let proto = Stroke {
                            points: raw_points.clone(),
                            tool: "pen".to_string(),
                            width: 3.0,
                            ..Default::default()
                        };
                        let recognized = shapes::recognition::detect_shape(raw_points);
                        if let Some(snapped) = recognized {
                            let mut converted = proto.clone();
                            converted.is_shape = Some(true);
                            converted.shape_kind = Some(snapped.kind);
                            converted.points = snapped.points;
                            converted.closed = Some(snapped.closed);
                            *snapped_preview = Some(converted);
                        }
                    }
                }
                raw_points.push(Point {
                    x: pos.x,
                    y: pos.y,
                    pressure: 1.0,
                    t: Some(timestamp_ms),
                    alt: None,
                    az: None,
                });
            }
            ShapeToolState::Editing {
                selected_stroke,
                active_handle: Some(handle_idx),
            } => {
                // Dragging vertex: live dynamic shape deformation
                let target_pos = if self.magnetic_angle_snap_enabled
                    && selected_stroke.shape_kind == Some(ShapeKind::Line)
                    && selected_stroke.points.len() == 2
                {
                    let other_idx = 1 - *handle_idx;
                    let other = Vec2d::new(
                        selected_stroke.points[other_idx].x,
                        selected_stroke.points[other_idx].y,
                    );
                    let delta = pos.sub(other);
                    let angle = delta.y.atan2(delta.x);
                    let snapped_angle = snap_angle_cardinal(angle, 5.0 * PI / 180.0);
                    let length = delta.length();
                    other.add(Vec2d::new(snapped_angle.cos() * length, snapped_angle.sin() * length))
                } else {
                    pos
                };

                if *handle_idx < selected_stroke.points.len() {
                    selected_stroke.points[*handle_idx].x = target_pos.x;
                    selected_stroke.points[*handle_idx].y = target_pos.y;
                }

                // If arrow, dynamically update wings
                if selected_stroke.shape_kind == Some(ShapeKind::Arrow) && selected_stroke.points.len() >= 2 {
                    update_arrow_wings(selected_stroke);
                }
            }
            _ => {}
        }
    }

    /// Handles pointer up: finalizes stroke creation or handle edit.
    pub fn on_pointer_up(&mut self) -> Option<Stroke> {
        match std::mem::replace(&mut self.state, ShapeToolState::Idle) {
            ShapeToolState::Drawing {
                snapped_preview,
                raw_points,
                ..
            } => {
                if let Some(snapped) = snapped_preview {
                    self.state = ShapeToolState::Editing {
                        selected_stroke: snapped.clone(),
                        active_handle: None,
                    };
                    Some(snapped)
                } else if raw_points.len() >= 2 {
                    let s = Stroke {
                        id: format!("st-{}", nanoid_short()),
                        points: raw_points,
                        tool: "pen".to_string(),
                        width: 3.0,
                        ..Default::default()
                    };
                    Some(s)
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

                // If dragging a line endpoint with angle snap, show magnetic alignment guide
                if selected_stroke.shape_kind == Some(ShapeKind::Line) && active_handle.is_some() {
                    if let (Some(p0), Some(p1)) = (selected_stroke.points.first(), selected_stroke.points.last()) {
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

fn update_arrow_wings(stroke: &mut Stroke) {
    if stroke.points.len() < 2 {
        return;
    }
    let p_start = Vec2d::new(stroke.points[0].x, stroke.points[0].y);
    let p_tip = Vec2d::new(stroke.points[1].x, stroke.points[1].y);
    let dir = p_tip.sub(p_start).normalize();
    if dir.length_sq() < 1e-6 {
        return;
    }
    let wing_len = 16.0;
    let wing_angle = 25.0 * PI / 180.0;
    let w1 = p_tip.sub(dir.rotate(wing_angle).scale(wing_len));
    let w2 = p_tip.sub(dir.rotate(-wing_angle).scale(wing_len));

    stroke.points = vec![
        Point { x: p_start.x, y: p_start.y, pressure: 1.0, t: None, alt: None, az: None },
        Point { x: p_tip.x, y: p_tip.y, pressure: 1.0, t: None, alt: None, az: None },
        Point { x: w1.x, y: w1.y, pressure: 1.0, t: None, alt: None, az: None },
        Point { x: p_tip.x, y: p_tip.y, pressure: 1.0, t: None, alt: None, az: None },
        Point { x: w2.x, y: w2.y, pressure: 1.0, t: None, alt: None, az: None },
    ];
}

fn nanoid_short() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(100);
    format!("{:x}", COUNTER.fetch_add(1, Ordering::Relaxed))
}
