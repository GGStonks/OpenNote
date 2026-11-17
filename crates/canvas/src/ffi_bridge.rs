//! Cross-Platform FFI Bridge: Zero-latency input ingestion, zero-copy C ABI, and state machine.

use crate::canvas_core::{FramePipeline, ViewMatrix, Viewport};
use crate::geometry_engine::Vec2d;
use crate::spatial_index::SpatialIndex;
use crate::tools::eraser::{EraserMode, EraserTool};
use crate::tools::lasso::{LassoTool, LASSO_CONTEXT_MENU_ACTIONS};
use crate::tools::shapes::ShapeTool;
use crate::vector_renderer::VectorOverlayPass;
use model::Stroke;
use std::ffi::CString;
use std::os::raw::c_char;

/// Touch / Pointer phases.
#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum TouchPhase {
    Down = 0,
    Move = 1,
    Ended = 2,
    Cancelled = 3,
}

/// Pointer source types.
#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PointerType {
    Stylus = 0,
    Touch = 1,
    Mouse = 2,
}

/// Zero-copy input event packet passed directly from UIKit (iOS) or Android NDK without serialization overhead.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct InputEvent {
    pub x: f64,
    pub y: f64,
    pub pressure: f64,
    pub tilt_x: f64,
    pub tilt_y: f64,
    pub timestamp_ms: f64,
    pub phase: TouchPhase,
    pub pointer_type: PointerType,
}

/// Active tool mode in CanvasEngine.
#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ActiveToolKind {
    Pen = 0,
    Eraser = 1,
    Lasso = 2,
    Shapes = 3,
    PanZoom = 4,
}

/// Core Canvas Engine managing camera, spatial index, tools, and rendering state.
pub struct CanvasEngine {
    pub view_matrix: ViewMatrix,
    pub viewport: Viewport,
    pub spatial_index: SpatialIndex,
    pub pipeline: FramePipeline,
    pub strokes: Vec<Stroke>,
    pub active_tool: ActiveToolKind,
    pub eraser_tool: EraserTool,
    pub lasso_tool: LassoTool,
    pub shape_tool: ShapeTool,
    pub overlay_pass: VectorOverlayPass,
    pub last_action_json: Option<CString>,
}

impl CanvasEngine {
    pub fn new(width: f64, height: f64, native_scale: f64) -> Self {
        CanvasEngine {
            view_matrix: ViewMatrix::default(),
            viewport: Viewport::new(width, height, native_scale),
            spatial_index: SpatialIndex::new(),
            pipeline: FramePipeline::new(),
            strokes: Vec::new(),
            active_tool: ActiveToolKind::Pen,
            eraser_tool: EraserTool::default(),
            lasso_tool: LassoTool::default(),
            shape_tool: ShapeTool::default(),
            overlay_pass: VectorOverlayPass::default(),
            last_action_json: None,
        }
    }

    /// Rebuilds spatial index from all active strokes.
    pub fn rebuild_spatial_index(&mut self) {
        self.spatial_index.clear();
        for s in &self.strokes {
            if !s.id.is_empty() {
                let mut b = crate::geometry_engine::RectBounds::default();
                for p in &s.points {
                    b.include(Vec2d::new(p.x, p.y));
                }
                self.spatial_index.insert(s.id.clone(), b);
            }
        }
    }

    /// Dispatches a high-frequency input event directly to the active tool.
    pub fn dispatch_input(&mut self, event: InputEvent) -> Option<String> {
        let world_pos = self.view_matrix.screen_to_world(event.x, event.y);

        match self.active_tool {
            ActiveToolKind::Lasso => {
                match event.phase {
                    TouchPhase::Down => {
                        self.lasso_tool.on_pointer_down(world_pos, event.timestamp_ms);
                        self.lasso_tool.update_overlay(&mut self.overlay_pass, &self.view_matrix);
                        self.pipeline.mark_dirty(None);
                    }
                    TouchPhase::Move => {
                        self.lasso_tool.on_pointer_move(world_pos, event.timestamp_ms);
                        self.lasso_tool.update_overlay(&mut self.overlay_pass, &self.view_matrix);
                        self.pipeline.mark_dirty(None);
                    }
                    TouchPhase::Ended | TouchPhase::Cancelled => {
                        let selected = self.lasso_tool.on_pointer_up(
                            world_pos,
                            event.timestamp_ms,
                            &self.strokes,
                            &self.spatial_index,
                        );
                        self.lasso_tool.update_overlay(&mut self.overlay_pass, &self.view_matrix);
                        self.pipeline.mark_dirty(None);

                        if selected && self.lasso_tool.is_menu_open {
                            return Some(serde_json::json!({
                                "type": "selection_opened",
                                "selectedIds": self.lasso_tool.selected_ids,
                                "bbox": self.lasso_tool.selection_bbox,
                                "menuActions": LASSO_CONTEXT_MENU_ACTIONS,
                            }).to_string());
                        } else if !selected {
                            return Some(serde_json::json!({
                                "type": "selection_dismissed",
                            }).to_string());
                        }
                    }
                }
            }
            ActiveToolKind::Eraser => {
                match event.phase {
                    TouchPhase::Down => {
                        self.eraser_tool.on_pointer_down(world_pos);
                        let res = self.eraser_tool.erase_step(
                            world_pos,
                            &self.strokes,
                            &self.spatial_index,
                        );
                        self.apply_eraser_result(res);
                        self.eraser_tool.update_overlay(&mut self.overlay_pass, &self.view_matrix);
                        self.pipeline.mark_dirty(None);
                    }
                    TouchPhase::Move => {
                        let res = self.eraser_tool.erase_step(
                            world_pos,
                            &self.strokes,
                            &self.spatial_index,
                        );
                        self.apply_eraser_result(res);
                        self.eraser_tool.update_overlay(&mut self.overlay_pass, &self.view_matrix);
                        self.pipeline.mark_dirty(None);
                    }
                    TouchPhase::Ended | TouchPhase::Cancelled => {
                        self.eraser_tool.on_pointer_up();
                        self.overlay_pass.eraser_cursor = None;
                        self.pipeline.mark_dirty(None);
                    }
                }
            }
            ActiveToolKind::Shapes => {
                match event.phase {
                    TouchPhase::Down => {
                        self.shape_tool.on_pointer_down(world_pos, event.timestamp_ms);
                        self.shape_tool.update_overlay(&mut self.overlay_pass, &self.view_matrix);
                        self.pipeline.mark_dirty(None);
                    }
                    TouchPhase::Move => {
                        self.shape_tool.on_pointer_move(world_pos, event.timestamp_ms);
                        self.shape_tool.update_overlay(&mut self.overlay_pass, &self.view_matrix);
                        self.pipeline.mark_dirty(None);
                    }
                    TouchPhase::Ended | TouchPhase::Cancelled => {
                        if let Some(new_stroke) = self.shape_tool.on_pointer_up() {
                            let id = if new_stroke.id.is_empty() { "shape".to_string() } else { new_stroke.id.clone() };
                            let mut b = crate::geometry_engine::RectBounds::default();
                            for p in &new_stroke.points {
                                b.include(Vec2d::new(p.x, p.y));
                            }
                            self.spatial_index.insert(id, b);
                            self.strokes.push(new_stroke);
                        }
                        self.shape_tool.update_overlay(&mut self.overlay_pass, &self.view_matrix);
                        self.pipeline.mark_dirty(None);
                    }
                }
            }
            _ => {}
        }
        None
    }

    fn apply_eraser_result(&mut self, res: crate::tools::eraser::EraserResult) {
        if !res.removed_stroke_ids.is_empty() {
            let removed: std::collections::HashSet<&str> =
                res.removed_stroke_ids.iter().map(|s| s.as_str()).collect();
            for id in &res.removed_stroke_ids {
                self.spatial_index.remove(id);
            }
            self.strokes.retain(|s| !removed.contains(s.id.as_str()));
        }
        for (orig_id, pieces) in res.split_replacements {
            self.spatial_index.remove(&orig_id);
            self.strokes.retain(|s| s.id != orig_id);
            for piece in pieces {
                if !piece.id.is_empty() {
                    let mut b = crate::geometry_engine::RectBounds::default();
                    for p in &piece.points {
                        b.include(Vec2d::new(p.x, p.y));
                    }
                    self.spatial_index.insert(piece.id.clone(), b);
                }
                self.strokes.push(piece);
            }
        }
    }
}

// ------------------------------------------------------------------------------------------------
// Exported C ABI Functions for iOS (UIKit / Metal) & Android NDK (SurfaceView / Vulkan)

/// Creates a new CanvasEngine.
#[no_mangle]
pub extern "C" fn opennote_canvas_engine_create(
    width: f64,
    height: f64,
    native_scale: f64,
) -> *mut CanvasEngine {
    Box::into_raw(Box::new(CanvasEngine::new(width, height, native_scale)))
}

/// Destroys a CanvasEngine.
#[no_mangle]
pub unsafe extern "C" fn opennote_canvas_engine_destroy(engine: *mut CanvasEngine) {
    if !engine.is_null() {
        drop(Box::from_raw(engine));
    }
}

/// Dispatches an input event with zero-copy FFI overhead.
#[no_mangle]
pub unsafe extern "C" fn opennote_canvas_engine_dispatch_input(
    engine: *mut CanvasEngine,
    event: *const InputEvent,
) -> *const c_char {
    let Some(e) = engine.as_mut() else { return std::ptr::null() };
    if event.is_null() {
        return std::ptr::null();
    }
    let ev = *event;
    if let Some(action_json) = e.dispatch_input(ev) {
        if let Ok(c_str) = CString::new(action_json) {
            e.last_action_json = Some(c_str);
            return e.last_action_json.as_ref().unwrap().as_ptr();
        }
    }
    std::ptr::null()
}

/// Sets active tool kind (0: Pen, 1: Eraser, 2: Lasso, 3: Shapes, 4: PanZoom).
#[no_mangle]
pub unsafe extern "C" fn opennote_canvas_engine_set_tool(
    engine: *mut CanvasEngine,
    tool_kind: u32,
) {
    let Some(e) = engine.as_mut() else { return };
    e.active_tool = match tool_kind {
        1 => ActiveToolKind::Eraser,
        2 => ActiveToolKind::Lasso,
        3 => ActiveToolKind::Shapes,
        4 => ActiveToolKind::PanZoom,
        _ => ActiveToolKind::Pen,
    };
    e.pipeline.mark_dirty(None);
}

/// Sets eraser mode (0: Object, 1: Precision) and radius.
#[no_mangle]
pub unsafe extern "C" fn opennote_canvas_engine_set_eraser_config(
    engine: *mut CanvasEngine,
    mode: u32,
    radius: f64,
) {
    let Some(e) = engine.as_mut() else { return };
    e.eraser_tool.mode = if mode == 1 { EraserMode::Precision } else { EraserMode::Object };
    e.eraser_tool.radius = radius.max(1.0);
}

/// Sets camera ViewMatrix in double precision.
#[no_mangle]
pub unsafe extern "C" fn opennote_canvas_engine_set_camera(
    engine: *mut CanvasEngine,
    scale: f64,
    offset_x: f64,
    offset_y: f64,
) {
    let Some(e) = engine.as_mut() else { return };
    e.view_matrix = ViewMatrix::new(scale, offset_x, offset_y);
    e.pipeline.mark_dirty(None);
}

/// Converts screen coordinates to world coordinates in double precision.
#[no_mangle]
pub unsafe extern "C" fn opennote_canvas_engine_screen_to_world(
    engine: *mut CanvasEngine,
    sx: f64,
    sy: f64,
    out_wx: *mut f64,
    out_wy: *mut f64,
) {
    let Some(e) = engine.as_mut() else { return };
    if out_wx.is_null() || out_wy.is_null() { return };
    let w = e.view_matrix.screen_to_world(sx, sy);
    *out_wx = w.x;
    *out_wy = w.y;
}

/// Converts world coordinates to screen coordinates in double precision.
#[no_mangle]
pub unsafe extern "C" fn opennote_canvas_engine_world_to_screen(
    engine: *mut CanvasEngine,
    wx: f64,
    wy: f64,
    out_sx: *mut f64,
    out_sy: *mut f64,
) {
    let Some(e) = engine.as_mut() else { return };
    if out_sx.is_null() || out_sy.is_null() { return };
    let s = e.view_matrix.world_to_screen(wx, wy);
    *out_sx = s.x;
    *out_sy = s.y;
}

/// Dismisses the selection explicitly.
#[no_mangle]
pub unsafe extern "C" fn opennote_canvas_engine_dismiss_selection(engine: *mut CanvasEngine) {
    let Some(e) = engine.as_mut() else { return };
    e.lasso_tool.clear_selection();
    e.overlay_pass.selection_bbox = None;
    e.overlay_pass.handles.clear();
    e.pipeline.mark_dirty(None);
}
