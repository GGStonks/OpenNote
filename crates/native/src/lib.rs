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

use ink::stroke_geometry;
use model::{ModeledKind, PenStyle, Point, Stroke};
use serde::Deserialize;
use serde_json::{json, Value};
use std::panic::{catch_unwind, AssertUnwindSafe};

/// Milliseconds on a monotonic clock where there is one (WebAssembly has none here: the page
/// times the call itself, and `ms` is 0).
#[cfg(not(target_arch = "wasm32"))]
fn clock_ms() -> f64 {
    use std::sync::OnceLock;
    use std::time::Instant;
    static T0: OnceLock<Instant> = OnceLock::new();
    T0.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}
#[cfg(target_arch = "wasm32")]
fn clock_ms() -> f64 {
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
        Err(_) => frame(&json!({ "error": format!("{method} panicked") }).to_string(), &[]),
    }
}

pub fn call(method: &str, meta: &str, data: &[u8]) -> Result<(String, Vec<u8>), String> {
    match method {
        "info" => Ok((json!({ "version": VERSION, "methods": ["info", "geometry"] }).to_string(), Vec::new())),
        "geometry" => geometry(meta, data),
        _ => Err(format!("unknown method {method}")),
    }
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

fn f64s(data: &[u8]) -> Result<Vec<f64>, String> {
    if data.len() % 8 != 0 {
        return Err("data is not a list of f64".into());
    }
    Ok(data.chunks_exact(8).map(|c| f64::from_le_bytes(c.try_into().unwrap())).collect())
}

fn geometry(meta: &str, data: &[u8]) -> Result<(String, Vec<u8>), String> {
    let start = clock_ms();
    let req: GeometryRequest = serde_json::from_str(meta).map_err(|e| format!("geometry request: {e}"))?;
    let vals = f64s(data)?;
    let total: usize = req.strokes.iter().map(|s| s.n).sum();
    if total * 4 != vals.len() {
        return Err(format!("{} points announced, {} values sent", total, vals.len()));
    }
    let mut out_meta: Vec<Value> = Vec::with_capacity(req.strokes.len());
    let mut out: Vec<u8> = Vec::with_capacity(total * 40);
    let mut at = 0;
    for h in req.strokes {
        let points: Vec<Point> = vals[at * 4..(at + h.n) * 4]
            .chunks_exact(4)
            .map(|c| Point { x: c[0], y: c[1], pressure: c[2], t: if c[3].is_nan() { None } else { Some(c[3]) }, alt: None, az: None })
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
pub unsafe extern "C" fn opennote_rs_call(method: *const std::os::raw::c_char, input: *const u8, len: usize, out_len: *mut usize) -> *mut u8 {
    let method = if method.is_null() { "" } else { std::ffi::CStr::from_ptr(method).to_str().unwrap_or("") };
    let request = if input.is_null() { &[][..] } else { std::slice::from_raw_parts(input, len) };
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
// JNI entry point (Android: com.opennote.app.OpenNoteRustPlugin.nativeCall).

#[cfg(feature = "jni")]
mod android {
    use jni::objects::{JByteArray, JClass, JString};
    use jni::sys::jbyteArray;
    use jni::JNIEnv;

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
        env.byte_array_from_slice(&reply).map(|a| a.into_raw()).unwrap_or(std::ptr::null_mut())
    }
}
