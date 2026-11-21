//! The Rust code the TypeScript app calls on the devices.
//!
//! One entry point for both shells: a method name and a request, a reply back. Request and reply
//! are framed the same way: a little-endian u32 length, that many bytes of JSON (`meta`), then
//! binary data. The page sends them through the shell (iOS: the `rust` command of the `opennote`
//! message handler, linked statically; Android: `OpenNoteRustPlugin`, this crate as
//! `libopennote_native.so`), base64 over the bridge; `src/services/rustCore.ts` is the page's side.
//!
//! Methods:
//! - `info`: `{ version, methods }`.
//! - `geometry`: the drawn line of each stroke (`ink::stroke_geometry`, the TypeScript app's
//!   `strokeGeometry` point for point: crates/ink/tests/reference.rs). Request meta
//!   `{ strokes: [{ tool, penStyle, isShape, modeled, penEnd, width, n }] }`, data: every stroke's
//!   points, f64 `x, y, pressure, t` (t NaN when missing). Reply meta
//!   `{ strokes: [{ n, widths, width }], ms }` (ms: time spent here), data: per stroke `n` points
//!   f64 `x, y, t, p`, then `n` widths when `widths`.
//!
//! A failure (bad request, panic) comes back as meta `{ error }` and no data: the page then does
//! the work in TypeScript.

pub mod canvas_service;
#[cfg(any(target_os = "ios", target_os = "macos"))]
pub use canvas_service::opennote_canvas_attach_layer;
pub use canvas_service::{
    opennote_canvas_detach, opennote_canvas_draw_active, opennote_canvas_resize,
};
pub mod live;
pub mod viewport_service;

use ink::stroke_geometry;
use model::{ModeledKind, PenStyle, Point, Stroke};
use serde::Deserialize;
use serde_json::{json, Value};
use std::panic::{catch_unwind, AssertUnwindSafe};

/// Milliseconds on the shells' own monotonic clock, so that the times they stamp on touches and
/// display frames are on the same line as Rust's: iOS `CLOCK_UPTIME_RAW` (mach_absolute_time:
/// `UITouch.timestamp`, `CADisplayLink.targetTimestamp`, `CACurrentMediaTime`), Android and Linux
/// `CLOCK_MONOTONIC` (`MotionEvent.getEventTime`, Choreographer's frame time, Node's hrtime: the
/// PC's bench). Elsewhere a clock of its own; WebAssembly has none here (the page times the call
/// itself, and `ms` is 0).
#[cfg(any(
    target_os = "ios",
    target_os = "macos",
    target_os = "android",
    target_os = "linux"
))]
pub fn clock_ms() -> f64 {
    #[cfg(any(target_os = "ios", target_os = "macos"))]
    const CLOCK: libc::clockid_t = libc::CLOCK_UPTIME_RAW;
    #[cfg(not(any(target_os = "ios", target_os = "macos")))]
    const CLOCK: libc::clockid_t = libc::CLOCK_MONOTONIC;
    let mut ts = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // SAFETY: `ts` is a valid timespec for the call to fill.
    unsafe { libc::clock_gettime(CLOCK, &mut ts) };
    ts.tv_sec as f64 * 1000.0 + ts.tv_nsec as f64 / 1e6
}
#[cfg(not(any(
    target_os = "ios",
    target_os = "macos",
    target_os = "android",
    target_os = "linux",
    target_arch = "wasm32"
)))]
pub fn clock_ms() -> f64 {
    use std::sync::OnceLock;
    use std::time::Instant;
    static T0: OnceLock<Instant> = OnceLock::new();
    T0.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}
#[cfg(target_arch = "wasm32")]
pub fn clock_ms() -> f64 {
    0.0
}

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Splits a framed message into its meta JSON and data.
pub fn unframe(bytes: &[u8]) -> Result<(&str, &[u8]), String> {
    if bytes.len() < 4 {
        return Err("message shorter than its header".into());
    }
    let n = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    let rest = &bytes[4..];
    if rest.len() < n {
        return Err("meta longer than the message".into());
    }
    let meta = std::str::from_utf8(&rest[..n]).map_err(|_| "meta is not UTF-8".to_string())?;
    Ok((meta, &rest[n..]))
}

pub fn frame(meta: &str, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + meta.len() + data.len());
    out.extend_from_slice(&(meta.len() as u32).to_le_bytes());
    out.extend_from_slice(meta.as_bytes());
    out.extend_from_slice(data);
    out
}

/// Runs `method` on a framed request and returns the framed reply; never panics.
pub fn call_framed(method: &str, request: &[u8]) -> Vec<u8> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let (meta, data) = unframe(request)?;
        call(method, meta, data)
    }));
    match result {
        Ok(Ok((meta, data))) => frame(&meta, &data),
        Ok(Err(e)) => frame(&json!({ "error": e }).to_string(), &[]),
        Err(_) => frame(
            &json!({ "error": format!("{method} panicked") }).to_string(),
            &[],
        ),
    }
}

pub fn call(method: &str, meta: &str, data: &[u8]) -> Result<(String, Vec<u8>), String> {
    match method {
        "info" => Ok((json!({ "version": VERSION, "methods": ["info", "geometry", "liveReplay", "renderThumbnail", "canvasRender", "canvasScene", "canvasSceneBin", "canvasFrame", "canvasImage", "canvasImageStatus", "canvasStats", "canvasForget", "canvasBudget", "viewportLayout", "viewportSet", "viewportCamera", "viewportTouch", "viewportShown", "viewportTrace", "selectInRect", "selectInLasso", "selectionBounds", "transformPageItems", "shapeHandles", "moveShapeHandle", "snapStroke", "uiThemeTokens", "uiLayoutCompute", "uiFormatPill"] }).to_string(), Vec::new())),
        "geometry" => geometry(meta, data),
        "liveReplay" => live_replay(meta),
        "renderThumbnail" => render_thumbnail(meta),
        "canvasRender" => canvas_service::canvas_render(meta),
        "canvasScene" => canvas_service::canvas_scene(meta),
        "canvasSceneBin" => canvas_service::canvas_scene_bin(meta, data),
        "canvasFrame" => canvas_service::canvas_frame(meta),
        "canvasImage" => canvas_service::canvas_image(meta, data),
        "canvasImageStatus" => canvas_service::canvas_image_status(meta),
        "canvasStats" => canvas_service::canvas_stats(meta),
        "canvasForget" => canvas_service::canvas_forget(meta),
        "canvasBudget" => canvas_service::canvas_budget(meta),
        "viewportLayout" => viewport_service::viewport_layout(meta),
        "viewportSet" => viewport_service::viewport_set(meta),
        "viewportCamera" => viewport_service::viewport_camera(meta),
        "viewportTouch" => viewport_service::viewport_touch(meta),
        "viewportShown" => viewport_service::viewport_shown(meta),
        "viewportTrace" => viewport_service::viewport_trace(meta),
        "selectInRect" => select_in_rect(meta),
        "selectInLasso" => select_in_lasso(meta),
        "selectionBounds" => selection_bounds(meta),
        "transformPageItems" => transform_page_items(meta),
        "shapeHandles" => shape_handles(meta),
        "moveShapeHandle" => move_shape_handle(meta),
        "snapStroke" => snap_stroke(meta),
        "uiThemeTokens" => ui_theme_tokens(meta),
        "uiLayoutCompute" => ui_layout_compute(meta),
        "uiFormatPill" => ui_format_pill(meta),
        _ => Err(format!("unknown method {method}")),
    }
}

/// `liveReplay` (tests: bench:ui --native --only rustlive): a whole stroke through a live session,
/// as the shells run it. Meta `{ params: [13 numbers as for opennote_live_new], samples: [[x, y,
/// force, t], ...] }`; reply `{ settled, line: [[x, y, radius], ...] }` (the settled points first).
fn live_replay(meta: &str) -> Result<(String, Vec<u8>), String> {
    #[derive(Deserialize)]
    struct Req {
        params: Vec<f64>,
        samples: Vec<[f64; 4]>,
    }
    let r: Req = serde_json::from_str(meta).map_err(|e| format!("liveReplay request: {e}"))?;
    if r.params.len() < 13 {
        return Err("liveReplay needs 13 params".into());
    }
    let v = &r.params;
    let mut l = live::Live::new(live::LiveParams {
        left: v[0],
        top: v[1],
        w: v[2],
        rw: v[3],
        h: v[4],
        rh: v[5],
        offset: v[6],
        start: v[7],
        ox: v[8],
        oy: v[9],
        k: v[10],
        width: v[11],
        variable: v[12] != 0.0,
    });
    for s in &r.samples {
        l.add(s[0], s[1], s[2], s[3]);
    }
    let mut out = Vec::new();
    let settled = l.update(&mut out);
    let line: Vec<[f64; 3]> = out.chunks(3).map(|c| [c[0], c[1], c[2]]).collect();
    Ok((
        json!({ "settled": settled, "line": line }).to_string(),
        Vec::new(),
    ))
}

#[derive(Deserialize)]
struct RenderThumbReq {
    width: usize,
    height: usize,
    #[serde(rename = "paperStyle")]
    paper_style: Option<String>,
    #[serde(rename = "paperColor")]
    paper_color: Option<String>,
    strokes: Vec<Stroke>,
}

fn render_thumbnail(meta: &str) -> Result<(String, Vec<u8>), String> {
    let t0 = clock_ms();
    let req: RenderThumbReq =
        serde_json::from_str(meta).map_err(|e| format!("renderThumbnail request: {e}"))?;
    if req.width == 0 || req.height == 0 {
        return Err("invalid dimensions".into());
    }

    let p_style = match req.paper_style.as_deref() {
        Some("ruled") => Some(model::PaperStyle::Ruled),
        Some("lines") => Some(model::PaperStyle::Lines),
        Some("grid") => Some(model::PaperStyle::Grid),
        Some("graph") => Some(model::PaperStyle::Graph),
        Some("dots") => Some(model::PaperStyle::Dots),
        Some("blank") | None => Some(model::PaperStyle::Blank),
        _ => Some(model::PaperStyle::Ruled),
    };

    let p_color = req
        .paper_color
        .map(|c| {
            if c.starts_with('#') {
                model::PaperColor::Hex(c)
            } else {
                model::PaperColor::Name(c)
            }
        })
        .unwrap_or_else(|| model::PaperColor::Name("white".to_string()));

    let mut buf = renderer::PixelBuffer::new(req.width, req.height);
    let scale = (req.width as f64 / 816.0).min(req.height as f64 / 1056.0);
    let renderer = renderer::Renderer::new(scale, 0.0, 0.0);

    let mut ops = Vec::new();
    for s in &req.strokes {
        ops.extend(renderer::builder::build_stroke_ops(s));
    }

    renderer.render_scene(&mut buf, &ops, p_style, Some(&p_color));

    let reply_meta = json!({
        "width": req.width,
        "height": req.height,
        "ms": clock_ms() - t0,
    });

    Ok((reply_meta.to_string(), buf.data))
}

fn select_in_rect(meta: &str) -> Result<(String, Vec<u8>), String> {
    #[derive(Deserialize)]
    struct Req {
        rect: [f64; 4],
        page: model::NotePage,
    }
    let r: Req = serde_json::from_str(meta).map_err(|e| format!("selectInRect request: {e}"))?;
    let bounds = ink::RectBounds {
        min_x: r.rect[0],
        min_y: r.rect[1],
        max_x: r.rect[2],
        max_y: r.rect[3],
    };
    let sel = shapes::selection::rect_select_page(bounds, &r.page);
    Ok((
        json!({
            "strokeIds": sel.stroke_ids,
            "latexIds": sel.latex_ids,
            "textIds": sel.text_ids,
            "imageIds": sel.image_ids,
            "bounds": sel.bounds
        })
        .to_string(),
        Vec::new(),
    ))
}

fn select_in_lasso(meta: &str) -> Result<(String, Vec<u8>), String> {
    #[derive(Deserialize)]
    struct Req {
        lasso: Vec<[f64; 2]>,
        page: model::NotePage,
    }
    let r: Req = serde_json::from_str(meta).map_err(|e| format!("selectInLasso request: {e}"))?;
    let pts: Vec<nib::geometry::XY> = r
        .lasso
        .into_iter()
        .map(|p| nib::geometry::XY { x: p[0], y: p[1] })
        .collect();
    let sel = shapes::selection::lasso_select_page(&pts, &r.page);
    Ok((
        json!({
            "strokeIds": sel.stroke_ids,
            "latexIds": sel.latex_ids,
            "textIds": sel.text_ids,
            "imageIds": sel.image_ids,
            "bounds": sel.bounds
        })
        .to_string(),
        Vec::new(),
    ))
}

fn selection_bounds(meta: &str) -> Result<(String, Vec<u8>), String> {
    #[derive(Deserialize)]
    struct Req {
        page: model::NotePage,
        ids: Vec<String>,
    }
    let r: Req = serde_json::from_str(meta).map_err(|e| format!("selectionBounds request: {e}"))?;
    let b = shapes::selection::selection_bounds(&r.page, &r.ids);
    let bounds =
        b.map(|r| json!({ "minX": r.min_x, "minY": r.min_y, "maxX": r.max_x, "maxY": r.max_y }));
    Ok((json!({ "bounds": bounds }).to_string(), Vec::new()))
}

fn transform_page_items(meta: &str) -> Result<(String, Vec<u8>), String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Req {
        page: model::NotePage,
        ids: Vec<String>,
        dx: f64,
        dy: f64,
        scale_x: f64,
        scale_y: f64,
        rotation_rad: f64,
        origin: [f64; 2],
    }
    let mut r: Req =
        serde_json::from_str(meta).map_err(|e| format!("transformPageItems request: {e}"))?;
    shapes::selection::transform_page_items(
        &mut r.page,
        &r.ids,
        r.dx,
        r.dy,
        r.scale_x,
        r.scale_y,
        r.rotation_rad,
        nib::geometry::XY {
            x: r.origin[0],
            y: r.origin[1],
        },
    );
    Ok((json!({ "page": r.page }).to_string(), Vec::new()))
}

fn shape_handles(meta: &str) -> Result<(String, Vec<u8>), String> {
    #[derive(Deserialize)]
    struct Req {
        stroke: model::Stroke,
    }
    let r: Req = serde_json::from_str(meta).map_err(|e| format!("shapeHandles request: {e}"))?;
    let handles = shapes::edit::shape_handles(&r.stroke);
    Ok((json!({ "handles": handles }).to_string(), Vec::new()))
}

fn move_shape_handle(meta: &str) -> Result<(String, Vec<u8>), String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Req {
        stroke: model::Stroke,
        handle: shapes::edit::ShapeHandle,
        target: [f64; 2],
        page: Option<model::NotePage>,
        options: Option<shapes::recognition::SnapOptions>,
    }
    let r: Req = serde_json::from_str(meta).map_err(|e| format!("moveShapeHandle request: {e}"))?;
    let target_xy = nib::geometry::XY {
        x: r.target[0],
        y: r.target[1],
    };
    let (st, guide) = shapes::edit::move_shape_handle(
        &r.stroke,
        &r.handle,
        target_xy,
        r.page.as_ref(),
        r.options.as_ref(),
    );
    Ok((
        json!({ "stroke": st, "guide": guide }).to_string(),
        Vec::new(),
    ))
}

fn snap_stroke(meta: &str) -> Result<(String, Vec<u8>), String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Req {
        stroke: model::Stroke,
        page: Option<model::NotePage>,
        options: Option<shapes::recognition::SnapOptions>,
    }
    let r: Req = serde_json::from_str(meta).map_err(|e| format!("snapStroke request: {e}"))?;
    let opts = r.options.unwrap_or_default();
    let (st, guides) =
        shapes::recognition::snap_stroke_with_context(&r.stroke, r.page.as_ref(), opts);
    Ok((
        json!({ "stroke": st, "guides": guides }).to_string(),
        Vec::new(),
    ))
}

fn ui_theme_tokens(meta: &str) -> Result<(String, Vec<u8>), String> {
    #[derive(Deserialize)]
    struct Req {
        platform: Option<String>,
        #[serde(default)]
        dark: bool,
    }
    let r: Req = if meta.trim().is_empty() {
        Req {
            platform: None,
            dark: false,
        }
    } else {
        serde_json::from_str(meta).map_err(|e| format!("uiThemeTokens request: {e}"))?
    };
    let tokens = match r.platform.as_deref() {
        Some("apple") | Some("ios") | Some("macos") => {
            if r.dark {
                ui::ThemeTokens::apple_dark()
            } else {
                ui::ThemeTokens::apple_light()
            }
        }
        Some("android") => {
            if r.dark {
                ui::ThemeTokens::android_expressive_dark()
            } else {
                ui::ThemeTokens::android_expressive_light()
            }
        }
        _ => ui::ThemeProvider::default_for_target(r.dark),
    };
    Ok((
        serde_json::to_string(&tokens).map_err(|e| e.to_string())?,
        Vec::new(),
    ))
}

fn ui_layout_compute(meta: &str) -> Result<(String, Vec<u8>), String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Req {
        width: f32,
        height: f32,
        #[serde(default)]
        sidebar_collapsed: bool,
        platform: Option<String>,
        #[serde(default)]
        dark: bool,
    }
    let r: Req = serde_json::from_str(meta).map_err(|e| format!("uiLayoutCompute request: {e}"))?;
    let tokens = match r.platform.as_deref() {
        Some("apple") | Some("ios") | Some("macos") => {
            if r.dark {
                ui::ThemeTokens::apple_dark()
            } else {
                ui::ThemeTokens::apple_light()
            }
        }
        Some("android") => {
            if r.dark {
                ui::ThemeTokens::android_expressive_dark()
            } else {
                ui::ThemeTokens::android_expressive_light()
            }
        }
        _ => ui::ThemeProvider::default_for_target(r.dark),
    };
    let mut shell = ui::LayoutShell::new(r.width, r.height);
    shell.sidebar.set_collapsed(r.sidebar_collapsed);
    let geom = shell.compute_geometry(&tokens);
    Ok((
        serde_json::to_string(&geom).map_err(|e| e.to_string())?,
        Vec::new(),
    ))
}

fn ui_format_pill(meta: &str) -> Result<(String, Vec<u8>), String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Req {
        selection: Option<ui::TextSelection>,
        viewport_width: f32,
        viewport_height: f32,
        platform: Option<String>,
        #[serde(default)]
        dark: bool,
    }
    let r: Req = serde_json::from_str(meta).map_err(|e| format!("uiFormatPill request: {e}"))?;
    let tokens = match r.platform.as_deref() {
        Some("apple") | Some("ios") | Some("macos") => {
            if r.dark {
                ui::ThemeTokens::apple_dark()
            } else {
                ui::ThemeTokens::apple_light()
            }
        }
        Some("android") => {
            if r.dark {
                ui::ThemeTokens::android_expressive_dark()
            } else {
                ui::ThemeTokens::android_expressive_light()
            }
        }
        _ => ui::ThemeProvider::default_for_target(r.dark),
    };
    let mut pill = ui::FloatingSelectionPill::default();
    pill.update_selection(
        r.selection.as_ref(),
        r.viewport_width,
        r.viewport_height,
        &tokens,
    );
    Ok((
        serde_json::to_string(&pill).map_err(|e| e.to_string())?,
        Vec::new(),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StrokeHead {
    tool: String,
    pen_style: Option<PenStyle>,
    #[serde(default)]
    is_shape: bool,
    modeled: Option<ModeledKind>,
    #[serde(default)]
    pen_end: bool,
    width: f64,
    n: usize,
}

#[derive(Deserialize)]
struct GeometryRequest {
    strokes: Vec<StrokeHead>,
}

pub(crate) fn f64s(data: &[u8]) -> Result<Vec<f64>, String> {
    let (chunks, rest) = data.as_chunks::<8>();
    if !rest.is_empty() {
        return Err("data is not a list of f64".into());
    }
    Ok(chunks.iter().map(|c| f64::from_le_bytes(*c)).collect())
}

fn geometry(meta: &str, data: &[u8]) -> Result<(String, Vec<u8>), String> {
    let start = clock_ms();
    let req: GeometryRequest =
        serde_json::from_str(meta).map_err(|e| format!("geometry request: {e}"))?;
    let vals = f64s(data)?;
    let total: usize = req.strokes.iter().map(|s| s.n).sum();
    if total * 4 != vals.len() {
        return Err(format!(
            "{} points announced, {} values sent",
            total,
            vals.len()
        ));
    }
    let mut out_meta: Vec<Value> = Vec::with_capacity(req.strokes.len());
    let mut out: Vec<u8> = Vec::with_capacity(total * 40);
    let mut at = 0;
    for h in req.strokes {
        let points: Vec<Point> = vals[at * 4..(at + h.n) * 4]
            .as_chunks::<4>()
            .0
            .iter()
            .map(|c| Point {
                x: c[0],
                y: c[1],
                pressure: c[2],
                t: if c[3].is_nan() { None } else { Some(c[3]) },
                alt: None,
                az: None,
            })
            .collect();
        at += h.n;
        let s = Stroke {
            tool: h.tool,
            width: h.width,
            opacity: 1.0,
            points,
            pen_style: h.pen_style,
            is_shape: h.is_shape.then_some(true),
            modeled: h.modeled,
            pen_end: h.pen_end.then_some(true),
            ..Default::default()
        };
        let g = stroke_geometry(&s);
        for p in &g.pts {
            for v in [p.x, p.y, p.t, p.p] {
                out.extend_from_slice(&v.to_le_bytes());
            }
        }
        if let Some(w) = &g.widths {
            for v in w {
                out.extend_from_slice(&v.to_le_bytes());
            }
        }
        out_meta.push(json!({ "n": g.pts.len(), "widths": g.widths.is_some(), "width": g.width }));
    }
    let ms = clock_ms() - start;
    Ok((json!({ "strokes": out_meta, "ms": ms }).to_string(), out))
}

// ------------------------------------------------------------------------------------------------
// C entry points (iOS shell).

/// Runs `method` (NUL-terminated) on the framed request `input[..len]`. The reply is allocated
/// here: its length goes to `out_len`, and it must be given back to `opennote_rs_free`.
///
/// # Safety
/// `method` must be a valid C string, `input` valid for `len` bytes, `out_len` writable.
#[no_mangle]
pub unsafe extern "C" fn opennote_rs_call(
    method: *const std::os::raw::c_char,
    input: *const u8,
    len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    let method = if method.is_null() {
        ""
    } else {
        std::ffi::CStr::from_ptr(method).to_str().unwrap_or("")
    };
    let request = if input.is_null() {
        &[][..]
    } else {
        std::slice::from_raw_parts(input, len)
    };
    let reply = call_framed(method, request).into_boxed_slice();
    *out_len = reply.len();
    Box::into_raw(reply) as *mut u8
}

/// Frees a reply of `opennote_rs_call`.
///
/// # Safety
/// `ptr` and `len` must be exactly a reply and its length, not freed before.
#[no_mangle]
pub unsafe extern "C" fn opennote_rs_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)));
    }
}

/// Memory for a request (WebAssembly: the page writes the method name and the request here, then
/// calls `opennote_rs_call`, and gives both back to `opennote_rs_free`).
#[no_mangle]
pub extern "C" fn opennote_rs_alloc(len: usize) -> *mut u8 {
    Box::into_raw(vec![0u8; len].into_boxed_slice()) as *mut u8
}

// ------------------------------------------------------------------------------------------------
// Native live ink (live.rs): one session per stroke, driven by the shell's own pen samples.

/// The session behind a shell's handle: the line's state and the last update's points.
pub struct LiveHandle {
    live: live::Live,
    out: Vec<f64>,
}

/// A session for the stroke `r` announced. `params` (13): left, top, w, rw, h, rh, offset, start,
/// ox, oy, k, width, variable (0 / 1). Null on a bad call.
///
/// # Safety
/// `params` must be valid for `n` f64.
#[no_mangle]
pub unsafe extern "C" fn opennote_live_new(params: *const f64, n: usize) -> *mut LiveHandle {
    if params.is_null() || n < 13 {
        return std::ptr::null_mut();
    }
    let v = std::slice::from_raw_parts(params, n);
    let p = live::LiveParams {
        left: v[0],
        top: v[1],
        w: v[2],
        rw: v[3],
        h: v[4],
        rh: v[5],
        offset: v[6],
        start: v[7],
        ox: v[8],
        oy: v[9],
        k: v[10],
        width: v[11],
        variable: v[12] != 0.0,
    };
    Box::into_raw(Box::new(LiveHandle {
        live: live::Live::new(p),
        out: Vec::new(),
    }))
}

/// One pen sample (view position, force as sent, shell time in s). False if the session broke.
///
/// # Safety
/// `h` must come from `opennote_live_new` and not be freed.
#[no_mangle]
pub unsafe extern "C" fn opennote_live_add(
    h: *mut LiveHandle,
    x: f64,
    y: f64,
    force: f64,
    t: f64,
) -> bool {
    let Some(h) = h.as_mut() else { return false };
    catch_unwind(AssertUnwindSafe(|| h.live.add(x, y, force, t))).is_ok()
}

/// The line now: `*n` points (x, y, radius in view units), the first `*fresh` of them settled since
/// the last call, then the rest. The points stay valid until the next call; null if it broke.
///
/// # Safety
/// `h` must come from `opennote_live_new`; `fresh` and `n` must be writable.
#[no_mangle]
pub unsafe extern "C" fn opennote_live_update(
    h: *mut LiveHandle,
    fresh: *mut usize,
    n: *mut usize,
) -> *const f64 {
    let Some(h) = h.as_mut() else {
        return std::ptr::null();
    };
    let LiveHandle { live, out } = h;
    match catch_unwind(AssertUnwindSafe(|| live.update(out))) {
        Ok(f) => {
            *fresh = f;
            *n = out.len() / 3;
            out.as_ptr()
        }
        Err(_) => std::ptr::null(),
    }
}

/// Ends a session.
///
/// # Safety
/// `h` must come from `opennote_live_new`, not freed before.
#[no_mangle]
pub unsafe extern "C" fn opennote_live_free(h: *mut LiveHandle) {
    if !h.is_null() {
        drop(Box::from_raw(h));
    }
}

/// The shells' crash file (iOS ONInstallCrashCapture, Android OpenNoteCrashCapture): a Rust panic is appended there with its
/// thread, message, place and backtrace, before it unwinds or aborts, and the next start puts it
/// in the crash report. Panics `catch_unwind` stops are written too.
///
/// # Safety
/// `path` must be a valid C string.
#[no_mangle]
pub unsafe extern "C" fn opennote_set_crash_file(path: *const std::os::raw::c_char) {
    if path.is_null() {
        return;
    }
    let Ok(p) = std::ffi::CStr::from_ptr(path).to_str().map(str::to_string) else {
        return;
    };
    // Once per process: a shell that sets it again (an activity made again) would chain a second
    // hook writing each panic twice.
    static SET: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if SET.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(&p)
        {
            let thread = std::thread::current();
            let bt = std::backtrace::Backtrace::force_capture();
            let _ = writeln!(
                f,
                "\nrust panic on thread {}: {info}\n{bt}",
                thread.name().unwrap_or("?")
            );
        }
        prev(info);
    }));
}

// ------------------------------------------------------------------------------------------------
// JNI entry point (Android: com.opennote.app.OpenNoteRustPlugin.nativeCall).

#[cfg(feature = "jni")]
mod android {
    use jni::objects::{JByteArray, JClass, JDoubleArray, JString};
    use jni::sys::{jboolean, jbyteArray, jdouble, jdoubleArray, jlong, JNI_FALSE, JNI_TRUE};
    use jni::JNIEnv;
    use std::panic::{catch_unwind, AssertUnwindSafe};

    // Native live ink (live.rs) for InkOverlay: a session's handle is its pointer as a long.

    #[no_mangle]
    pub extern "system" fn Java_com_opennote_app_OpenNoteRustPlugin_liveNew<'l>(
        env: JNIEnv<'l>,
        _class: JClass<'l>,
        params: JDoubleArray<'l>,
    ) -> jlong {
        let n = env.get_array_length(&params).unwrap_or(0) as usize;
        let mut v = vec![0.0; n];
        if n < 13 || env.get_double_array_region(&params, 0, &mut v).is_err() {
            return 0;
        }
        unsafe { super::opennote_live_new(v.as_ptr(), n) as jlong }
    }

    #[no_mangle]
    pub extern "system" fn Java_com_opennote_app_OpenNoteRustPlugin_liveAdd<'l>(
        _env: JNIEnv<'l>,
        _class: JClass<'l>,
        h: jlong,
        x: jdouble,
        y: jdouble,
        force: jdouble,
        t: jdouble,
    ) -> jboolean {
        if unsafe { super::opennote_live_add(h as *mut super::LiveHandle, x, y, force, t) } {
            JNI_TRUE
        } else {
            JNI_FALSE
        }
    }

    /// [fresh, x, y, radius, ...] (view units), or null if the session broke.
    #[no_mangle]
    pub extern "system" fn Java_com_opennote_app_OpenNoteRustPlugin_liveUpdate<'l>(
        env: JNIEnv<'l>,
        _class: JClass<'l>,
        h: jlong,
    ) -> jdoubleArray {
        let (mut fresh, mut n) = (0usize, 0usize);
        let p =
            unsafe { super::opennote_live_update(h as *mut super::LiveHandle, &mut fresh, &mut n) };
        if p.is_null() {
            return std::ptr::null_mut();
        }
        let pts = unsafe { std::slice::from_raw_parts(p, n * 3) };
        let mut out = Vec::with_capacity(1 + pts.len());
        out.push(fresh as f64);
        out.extend_from_slice(pts);
        let Ok(arr) = env.new_double_array(out.len() as i32) else {
            return std::ptr::null_mut();
        };
        if env.set_double_array_region(&arr, 0, &out).is_err() {
            return std::ptr::null_mut();
        }
        arr.into_raw()
    }

    #[no_mangle]
    pub extern "system" fn Java_com_opennote_app_OpenNoteRustPlugin_liveFree<'l>(
        _env: JNIEnv<'l>,
        _class: JClass<'l>,
        h: jlong,
    ) {
        unsafe { super::opennote_live_free(h as *mut super::LiveHandle) }
    }

    #[no_mangle]
    pub extern "system" fn Java_com_opennote_app_OpenNoteRustPlugin_nativeCall<'l>(
        mut env: JNIEnv<'l>,
        _class: JClass<'l>,
        method: JString<'l>,
        input: JByteArray<'l>,
    ) -> jbyteArray {
        let method: String = env.get_string(&method).map(Into::into).unwrap_or_default();
        let request = env.convert_byte_array(&input).unwrap_or_default();
        let reply = super::call_framed(&method, &request);
        env.byte_array_from_slice(&reply)
            .map(|a| a.into_raw())
            .unwrap_or(std::ptr::null_mut())
    }

    /// The SurfaceView's surface is there (`surfaceChanged`, with its size): the canvas draws
    /// into its window (Vulkan, or GLES where Vulkan failed in this run). On the PC (the JVM test)
    /// there is no window: an offscreen host. False when no GPU could draw into it.
    #[no_mangle]
    pub extern "system" fn Java_com_opennote_app_OpenNoteRustPlugin_canvasSurfaceCreated<'l>(
        env: JNIEnv<'l>,
        _class: JClass<'l>,
        surface: jni::objects::JObject<'l>,
        w: jni::sys::jint,
        h: jni::sys::jint,
    ) -> jboolean {
        let (w, h) = (w.max(1) as u32, h.max(1) as u32);
        let ok = catch_unwind(AssertUnwindSafe(|| {
            #[cfg(target_os = "android")]
            {
                // One reference of ours, released by the service after the host that uses it.
                let window = unsafe {
                    ndk_sys::ANativeWindow_fromSurface(
                        env.get_raw() as *mut _,
                        surface.as_raw() as *mut _,
                    )
                };
                match std::ptr::NonNull::new(window) {
                    Some(win) => crate::canvas_service::attach(
                        crate::canvas_service::Surface::Window(win),
                        w,
                        h,
                    ),
                    None => false,
                }
            }
            #[cfg(not(target_os = "android"))]
            {
                let _ = (env, surface);
                crate::canvas_service::attach_offscreen(w, h)
            }
        }))
        .unwrap_or(false);
        if ok {
            JNI_TRUE
        } else {
            JNI_FALSE
        }
    }

    #[no_mangle]
    pub extern "system" fn Java_com_opennote_app_OpenNoteRustPlugin_canvasSurfaceChanged<'l>(
        _env: JNIEnv<'l>,
        _class: JClass<'l>,
        w: jni::sys::jint,
        h: jni::sys::jint,
    ) {
        let _ = catch_unwind(|| crate::canvas_service::resize(w.max(1) as u32, h.max(1) as u32));
    }

    /// The surface goes (`surfaceDestroyed`, UI thread): when this returns no draw uses the
    /// window, and it is released.
    #[no_mangle]
    pub extern "system" fn Java_com_opennote_app_OpenNoteRustPlugin_canvasSurfaceDestroyed<'l>(
        _env: JNIEnv<'l>,
        _class: JClass<'l>,
    ) {
        let _ = catch_unwind(crate::canvas_service::detach);
    }

    /// Rust panics go to the Android shell's crash file (OpenNoteCrashCapture), read at the next start.
    #[no_mangle]
    pub extern "system" fn Java_com_opennote_app_OpenNoteRustPlugin_setCrashFile<'l>(
        mut env: JNIEnv<'l>,
        _class: JClass<'l>,
        path: JString<'l>,
    ) {
        let _ = catch_unwind(AssertUnwindSafe(|| {
            let Ok(p) = env.get_string(&path).map(String::from) else {
                return;
            };
            let Ok(c) = std::ffi::CString::new(p) else {
                return;
            };
            unsafe { super::opennote_set_crash_file(c.as_ptr()) };
        }));
    }

    /// GLES instead of Vulkan for this run (OpenNoteRustPlugin, before the surface exists).
    #[no_mangle]
    pub extern "system" fn Java_com_opennote_app_OpenNoteRustPlugin_canvasPreferGl<'l>(
        mut env: JNIEnv<'l>,
        _class: JClass<'l>,
        why: JString<'l>,
    ) {
        let _ = catch_unwind(AssertUnwindSafe(|| {
            let why = env.get_string(&why).map(String::from).unwrap_or_default();
            crate::canvas_service::prefer_gl(&why);
        }));
    }

    /// A finger for the camera (OpenNoteRustPlugin.onTouch, UI thread): phase 0 began, 1 moved,
    /// 2 ended, 3 cancelled; (x, y) WebView CSS px. True when the camera holds it.
    #[no_mangle]
    pub extern "system" fn Java_com_opennote_app_OpenNoteRustPlugin_viewportTouch<'l>(
        _env: JNIEnv<'l>,
        _class: JClass<'l>,
        id: jlong,
        phase: jni::sys::jint,
        x: jdouble,
        y: jdouble,
    ) -> jboolean {
        if crate::viewport_service::opennote_viewport_touch(id, phase, x, y) {
            JNI_TRUE
        } else {
            JNI_FALSE
        }
    }

    /// The display's best refresh rate (Hz), for the gestures' record.
    #[no_mangle]
    pub extern "system" fn Java_com_opennote_app_OpenNoteRustPlugin_viewportDisplayHz<'l>(
        _env: JNIEnv<'l>,
        _class: JClass<'l>,
        hz: jdouble,
    ) {
        crate::viewport_service::opennote_viewport_display_hz(hz);
    }

    /// The camera for the page when due (render thread, after each tick), else null.
    #[no_mangle]
    pub extern "system" fn Java_com_opennote_app_OpenNoteRustPlugin_viewportPoll<'l>(
        env: JNIEnv<'l>,
        _class: JClass<'l>,
    ) -> jni::sys::jstring {
        let polled = catch_unwind(|| crate::viewport_service::poll(crate::clock_ms()))
            .ok()
            .flatten();
        match polled.and_then(|s| env.new_string(s).ok()) {
            Some(s) => s.into_raw(),
            None => std::ptr::null_mut(),
        }
    }

    /// The render thread's draw (OpenNoteRustPlugin's "opennote-canvas" thread).
    #[no_mangle]
    pub extern "system" fn Java_com_opennote_app_OpenNoteRustPlugin_canvasDrawActive<'l>(
        _env: JNIEnv<'l>,
        _class: JClass<'l>,
    ) -> jboolean {
        if catch_unwind(crate::canvas_service::draw_active).unwrap_or(false) {
            JNI_TRUE
        } else {
            JNI_FALSE
        }
    }

    /// The draw of the display frame presented at `present_ms` (CLOCK_MONOTONIC ms:
    /// Choreographer's frame time plus a vsync period). Render thread only.
    #[no_mangle]
    pub extern "system" fn Java_com_opennote_app_OpenNoteRustPlugin_canvasDrawAt<'l>(
        _env: JNIEnv<'l>,
        _class: JClass<'l>,
        present_ms: jdouble,
    ) -> jboolean {
        if catch_unwind(|| crate::canvas_service::draw_at(present_ms)).unwrap_or(false) {
            JNI_TRUE
        } else {
            JNI_FALSE
        }
    }

    /// The fingers of one MotionEvent, historical samples first: `n` x [id, phase, x, y, t]
    /// (WebView CSS px, `t` seconds of CLOCK_MONOTONIC: getEventTime / 1000). UI thread.
    #[no_mangle]
    pub extern "system" fn Java_com_opennote_app_OpenNoteRustPlugin_viewportTouches<'l>(
        env: JNIEnv<'l>,
        _class: JClass<'l>,
        samples: JDoubleArray<'l>,
        n: jni::sys::jint,
    ) -> jni::sys::jint {
        let len = (n.max(0) as usize) * 5;
        let mut buf = [0f64; 5 * 64];
        if len == 0 || len > buf.len() {
            return 0;
        }
        if env
            .get_double_array_region(&samples, 0, &mut buf[..len])
            .is_err()
        {
            return 0;
        }
        catch_unwind(|| crate::viewport_service::touches(&buf[..len])).unwrap_or(0)
    }

    /// Whether the camera moves or holds fingers (the render thread asks for the display's best
    /// rate then).
    #[no_mangle]
    pub extern "system" fn Java_com_opennote_app_OpenNoteRustPlugin_viewportBusy<'l>(
        _env: JNIEnv<'l>,
        _class: JClass<'l>,
    ) -> jboolean {
        if catch_unwind(crate::viewport_service::busy).unwrap_or(false) {
            JNI_TRUE
        } else {
            JNI_FALSE
        }
    }
}
