//! Mirroring service for OpenNote (`crates/remote` integration in `crates/native`).

use std::net::SocketAddr;
use std::sync::{Mutex, OnceLock};

use opennote_remote::{
    CameraPayload, LaserPointerPayload, MirrorBroadcaster, PointData, StrokeCommitPayload,
    StrokeLiveAddPayload, ToolType, CAMERA_FLAG_IN_MOTION, CAMERA_FLAG_MOMENTUM_GLIDE,
    DEFAULT_PORT,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

struct ActiveSession {
    broadcaster: MirrorBroadcaster,
    url: String,
    pin: String,
    port: u16,
    shutdown_tx: tokio::sync::oneshot::Sender<()>,
}

static SESSION: OnceLock<Mutex<Option<ActiveSession>>> = OnceLock::new();

fn session_lock() -> &'static Mutex<Option<ActiveSession>> {
    SESSION.get_or_init(|| Mutex::new(None))
}

#[derive(Deserialize)]
struct StartReq {
    port: Option<u16>,
    pin: Option<String>,
}

#[derive(Serialize)]
pub struct MirrorStatus {
    pub active: bool,
    pub url: Option<String>,
    pub pin: Option<String>,
    pub port: Option<u16>,
    pub clients: usize,
}

pub fn mirror_start(meta: &str) -> Result<(String, Vec<u8>), String> {
    let req: StartReq = if meta.trim().is_empty() {
        StartReq {
            port: None,
            pin: None,
        }
    } else {
        serde_json::from_str(meta).map_err(|e| format!("mirrorStart: {e}"))?
    };

    let mut guard = session_lock().lock().unwrap();
    if let Some(s) = guard.as_ref() {
        return Ok((
            json!({
                "active": true,
                "url": s.url,
                "pin": s.pin,
                "port": s.port,
                "clients": s.broadcaster.client_count(),
            })
            .to_string(),
            Vec::new(),
        ));
    }

    let initial_port = req.port.unwrap_or(DEFAULT_PORT);
    let pin = req
        .pin
        .unwrap_or_else(MirrorBroadcaster::generate_random_pin);

    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .map_err(|e| format!("failed to build tokio runtime: {e}"))?;

    let broadcaster = MirrorBroadcaster::new(&pin);
    let b_clone = broadcaster.clone();

    // Bind listener with automatic port fallback if busy
    let bind_addr: SocketAddr = format!("0.0.0.0:{initial_port}")
        .parse()
        .map_err(|e| format!("invalid bind addr: {e}"))?;

    let (listener, local_addr) = rt
        .block_on(MirrorBroadcaster::bind_listener(bind_addr))
        .map_err(|e| format!("failed to bind listener: {e}"))?;

    let actual_port = local_addr.port();
    let url = format!("http://127.0.0.1:{actual_port}/?pin={pin}");
    let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();

    // Spawn server in runtime
    std::thread::Builder::new()
        .name("opennote-mirror".into())
        .spawn(move || {
            rt.block_on(async move {
                tokio::select! {
                    _ = b_clone.serve_listener(listener) => {}
                    _ = &mut shutdown_rx => {}
                }
            });
        })
        .map_err(|e| format!("failed to spawn mirror thread: {e}"))?;

    let resp = json!({
        "active": true,
        "url": url,
        "pin": pin,
        "port": actual_port,
        "clients": 0,
    });

    *guard = Some(ActiveSession {
        broadcaster,
        url,
        pin,
        port: actual_port,
        shutdown_tx,
    });

    Ok((resp.to_string(), Vec::new()))
}

pub fn mirror_stop(_meta: &str) -> Result<(String, Vec<u8>), String> {
    let mut guard = session_lock().lock().unwrap();
    if let Some(session) = guard.take() {
        let _ = session.shutdown_tx.send(());
    }
    Ok((json!({ "active": false }).to_string(), Vec::new()))
}

pub fn mirror_status(_meta: &str) -> Result<(String, Vec<u8>), String> {
    let guard = session_lock().lock().unwrap();
    let resp = match guard.as_ref() {
        Some(s) => json!({
            "active": true,
            "url": s.url,
            "pin": s.pin,
            "port": s.port,
            "clients": s.broadcaster.client_count(),
        }),
        None => json!({
            "active": false,
            "clients": 0,
        }),
    };
    Ok((resp.to_string(), Vec::new()))
}

/// Global camera broadcast hook called on render tick. Zero-work if no receivers.
pub fn broadcast_camera(x: f32, y: f32, zoom: f32, rotation: f32, in_motion: bool, glide: bool) {
    let guard = match session_lock().try_lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    let Some(s) = guard.as_ref() else { return };
    if s.broadcaster.receiver_count() == 0 {
        return;
    }

    let mut flags = 0u32;
    if in_motion {
        flags |= CAMERA_FLAG_IN_MOTION;
    }
    if glide {
        flags |= CAMERA_FLAG_MOMENTUM_GLIDE;
    }

    s.broadcaster.broadcast_camera(CameraPayload {
        timestamp_us: (crate::clock_ms() * 1000.0) as u64,
        x,
        y,
        zoom,
        rotation,
        flags,
    });
}

/// Broadcast live pen point sample.
pub fn broadcast_live_point(stroke_id: u32, x: f32, y: f32, pressure: f32, t_ms: f32, width: f32) {
    let guard = match session_lock().try_lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    let Some(s) = guard.as_ref() else { return };
    if s.broadcaster.receiver_count() == 0 {
        return;
    }

    s.broadcaster.broadcast_live_points(StrokeLiveAddPayload {
        stroke_id,
        tool_type: ToolType::Pen,
        color_rgba: 0x000000FF,
        base_width: width,
        points: vec![PointData {
            x,
            y,
            pressure,
            t_ms,
        }],
    });
}

/// Broadcast stroke commit.
pub fn broadcast_stroke_commit(stroke_id: u32, page_id: &str, stroke_key: u64, bbox: [f32; 4]) {
    let guard = match session_lock().try_lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    let Some(s) = guard.as_ref() else { return };
    if s.broadcaster.receiver_count() == 0 {
        return;
    }

    s.broadcaster.broadcast_stroke_commit(StrokeCommitPayload {
        stroke_id,
        page_id: page_id.to_string(),
        stroke_key,
        bbox,
    });
}

/// Broadcast laser pointer movement.
pub fn broadcast_laser(x: f32, y: f32, intensity: f32, color_rgba: u32) {
    let guard = match session_lock().try_lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    let Some(s) = guard.as_ref() else { return };
    if s.broadcaster.receiver_count() == 0 {
        return;
    }

    s.broadcaster.broadcast_laser(LaserPointerPayload {
        x,
        y,
        intensity,
        color_rgba,
    });
}
