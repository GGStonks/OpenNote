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
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum TouchPhase {
    Down = 0,
    Move = 1,
    Ended = 2,
    Cancelled = 3,
}

/// Pointer source types.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PointerType {
    Stylus = 0,
    Touch = 1,
    Mouse = 2,
}

/// An input event as the shells pass it (C layout). `phase` and `pointer_type` are plain integers
/// here: a Rust enum read from C memory holding any other value is undefined behaviour, so they
/// are checked in `InputEvent::from_raw` (an unknown value drops the event).
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RawInputEvent {
    pub x: f64,
    pub y: f64,
    pub pressure: f64,
    pub tilt_x: f64,
    pub tilt_y: f64,
    pub timestamp_ms: f64,
    /// 0 down, 1 move, 2 ended, 3 cancelled.
    pub phase: u32,
    /// 0 stylus, 1 touch, 2 mouse.
    pub pointer_type: u32,
}

/// A checked input event.
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

impl InputEvent {
    pub fn from_raw(r: &RawInputEvent) -> Option<InputEvent> {
        let phase = match r.phase { 0 => TouchPhase::Down, 1 => TouchPhase::Move, 2 => TouchPhase::Ended, 3 => TouchPhase::Cancelled, _ => return None };
        let pointer_type = match r.pointer_type { 0 => PointerType::Stylus, 1 => PointerType::Touch, 2 => PointerType::Mouse, _ => return None };
        if !(r.x.is_finite() && r.y.is_finite()) {
            return None;
        }
        Some(InputEvent { x: r.x, y: r.y, pressure: r.pressure, tilt_x: r.tilt_x, tilt_y: r.tilt_y, timestamp_ms: r.timestamp_ms, phase, pointer_type })
    }
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
    pub undo_stack: Vec<Vec<Stroke>>,
    pub redo_stack: Vec<Vec<Stroke>>,
    pub active_tool: ActiveToolKind,
    pub tool_color: String,
    pub tool_width: f64,
    pub tool_opacity: f64,
    pub viewport_insets: [f64; 4],
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
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            active_tool: ActiveToolKind::Pen,
            tool_color: "#000000".to_string(),
            tool_width: 2.0,
            tool_opacity: 1.0,
            viewport_insets: [0.0; 4],
            eraser_tool: EraserTool::default(),
            lasso_tool: LassoTool::default(),
            shape_tool: ShapeTool::default(),
            overlay_pass: VectorOverlayPass::default(),
            last_action_json: None,
        }
    }

    pub fn push_undo_state(&mut self) {
        self.undo_stack.push(self.strokes.clone());
        if self.undo_stack.len() > 50 {
            self.undo_stack.remove(0);
        }
        self.redo_stack.clear();
    }

    pub fn undo(&mut self) -> bool {
        if let Some(prev) = self.undo_stack.pop() {
            let cur = std::mem::replace(&mut self.strokes, prev);
            self.redo_stack.push(cur);
            self.rebuild_spatial_index();
            self.pipeline.mark_dirty(None);
            true
        } else {
            false
        }
    }

    pub fn redo(&mut self) -> bool {
        if let Some(next) = self.redo_stack.pop() {
            let cur = std::mem::replace(&mut self.strokes, next);
            self.undo_stack.push(cur);
            self.rebuild_spatial_index();
            self.pipeline.mark_dirty(None);
            true
        } else {
            false
        }
    }

    pub fn set_tool_config(&mut self, tool: ActiveToolKind, color: &str, width: f64, opacity: f64) {
        self.active_tool = tool;
        self.tool_color = color.to_string();
        self.tool_width = width;
        self.tool_opacity = opacity;
        self.pipeline.mark_dirty(None);
    }

    pub fn set_viewport_insets(&mut self, top: f64, bottom: f64, left: f64, right: f64) {
        self.viewport_insets = [top, bottom, left, right];
        self.pipeline.mark_dirty(None);
    }

    pub fn load_document_strokes(&mut self, strokes: Vec<Stroke>) {
        self.undo_stack.clear();
        self.redo_stack.clear();
        self.strokes = strokes;
        self.rebuild_spatial_index();
        self.pipeline.mark_dirty(None);
    }

    pub fn pan(&mut self, dx: f64, dy: f64) {
        self.view_matrix.pan(dx, dy);
        self.pipeline.mark_dirty(None);
    }

    pub fn zoom_at(&mut self, factor: f64, cx: f64, cy: f64) {
        self.view_matrix.zoom_at(factor, cx, cy);
        self.pipeline.mark_dirty(None);
    }

    /// Rebuilds spatial index from all active strokes.
    pub fn rebuild_spatial_index(&mut self) {
        self.spatial_index.clear();
        for s in &self.strokes {
            if !s.id.is_empty() {
                self.spatial_index.insert(s.id.clone(), ink_bounds(s));
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
                        // One undo step per eraser gesture (dropped at the lift if nothing was erased).
                        self.push_undo_state();
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
                        if self.undo_stack.last().is_some_and(|prev| prev.len() == self.strokes.len() && prev.iter().zip(&self.strokes).all(|(a, b)| a.id == b.id)) {
                            self.undo_stack.pop();
                        }
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
                        if let Some(mut new_stroke) = self.shape_tool.on_pointer_up() {
                            self.push_undo_state();
                            // The index finds strokes by id: one shared fallback id made later shapes
                            // shadow each other there.
                            if new_stroke.id.is_empty() {
                                new_stroke.id = format!("shape-{}", self.strokes.len() + self.undo_stack.len());
                            }
                            self.spatial_index.insert(new_stroke.id.clone(), ink_bounds(&new_stroke));
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
                    self.spatial_index.insert(piece.id.clone(), ink_bounds(&piece));
                }
                self.strokes.push(piece);
            }
        }
    }
}

/// A stroke's box in page px, including its ink around the points: highlighters are 5.5x their
/// width, the fountain pen up to 1.55 x 1.4x (strokeWidth x pressure), so half of 5.5 covers all.
/// Built from the points alone, the eraser and lasso missed ink the circle touched beyond them.
pub fn ink_bounds(s: &Stroke) -> crate::geometry_engine::RectBounds {
    let mut b = crate::geometry_engine::RectBounds::default();
    for p in &s.points {
        b.include(Vec2d::new(p.x, p.y));
    }
    let pad = s.width.max(0.0) * 2.75 + 0.5;
    if b.min_x.is_finite() {
        b.min_x -= pad;
        b.min_y -= pad;
        b.max_x += pad;
        b.max_y += pad;
    }
    b
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
    event: *const RawInputEvent,
) -> *const c_char {
    let Some(e) = engine.as_mut() else { return std::ptr::null() };
    let Some(ev) = event.as_ref().and_then(InputEvent::from_raw) else { return std::ptr::null() };
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

/// Undoes the last stroke mutation in CanvasEngine.
#[no_mangle]
pub unsafe extern "C" fn opennote_canvas_engine_undo(engine: *mut CanvasEngine) -> bool {
    let Some(e) = engine.as_mut() else { return false };
    e.undo()
}

/// Redoes the previously undone stroke mutation in CanvasEngine.
#[no_mangle]
pub unsafe extern "C" fn opennote_canvas_engine_redo(engine: *mut CanvasEngine) -> bool {
    let Some(e) = engine.as_mut() else { return false };
    e.redo()
}

/// Sets active tool, color hex, stroke width, and opacity.
#[no_mangle]
pub unsafe extern "C" fn opennote_canvas_engine_set_tool_config(
    engine: *mut CanvasEngine,
    tool_kind: u32,
    color: *const c_char,
    width: f64,
    opacity: f64,
) {
    let Some(e) = engine.as_mut() else { return };
    let c_str = if color.is_null() { "#000000" } else { std::ffi::CStr::from_ptr(color).to_str().unwrap_or("#000000") };
    let kind = match tool_kind {
        1 => ActiveToolKind::Eraser,
        2 => ActiveToolKind::Lasso,
        3 => ActiveToolKind::Shapes,
        4 => ActiveToolKind::PanZoom,
        _ => ActiveToolKind::Pen,
    };
    e.set_tool_config(kind, c_str, width, opacity);
}

/// Sets viewport safe area insets (top, bottom, left, right).
#[no_mangle]
pub unsafe extern "C" fn opennote_canvas_engine_set_viewport_insets(
    engine: *mut CanvasEngine,
    top: f64,
    bottom: f64,
    left: f64,
    right: f64,
) {
    let Some(e) = engine.as_mut() else { return };
    e.set_viewport_insets(top, bottom, left, right);
}

/// Loads document strokes directly into CanvasEngine.
#[no_mangle]
pub unsafe extern "C" fn opennote_canvas_engine_load_strokes(
    engine: *mut CanvasEngine,
    strokes_json: *const c_char,
) -> usize {
    let Some(e) = engine.as_mut() else { return 0 };
    if strokes_json.is_null() { return 0; }
    let Ok(json_str) = std::ffi::CStr::from_ptr(strokes_json).to_str() else { return 0 };
    let Ok(strokes) = serde_json::from_str::<Vec<Stroke>>(json_str) else { return 0 };
    let count = strokes.len();
    e.load_document_strokes(strokes);
    count
}

/// Serializes all active document strokes from CanvasEngine to JSON string.
#[no_mangle]
pub unsafe extern "C" fn opennote_canvas_engine_get_strokes_json(
    engine: *mut CanvasEngine,
) -> *const c_char {
    let Some(e) = engine.as_mut() else { return std::ptr::null() };
    if let Ok(json_str) = serde_json::to_string(&e.strokes) {
        if let Ok(c_str) = CString::new(json_str) {
            e.last_action_json = Some(c_str);
            return e.last_action_json.as_ref().unwrap().as_ptr();
        }
    }
    std::ptr::null()
}

/// Pans CanvasEngine camera.
#[no_mangle]
pub unsafe extern "C" fn opennote_canvas_engine_pan(engine: *mut CanvasEngine, dx: f64, dy: f64) {
    let Some(e) = engine.as_mut() else { return };
    e.pan(dx, dy);
}

/// Zooms CanvasEngine camera around (cx, cy).
#[no_mangle]
pub unsafe extern "C" fn opennote_canvas_engine_zoom_at(engine: *mut CanvasEngine, factor: f64, cx: f64, cy: f64) {
    let Some(e) = engine.as_mut() else { return };
    e.zoom_at(factor, cx, cy);
}
