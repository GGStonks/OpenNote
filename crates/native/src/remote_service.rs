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
    /// The URL's QR code (see `qr_svg_path`).
    qr: Option<QrPath>,
    shutdown_tx: tokio::sync::oneshot::Sender<()>,
}

/// A QR code as one SVG path: `d` draws the dark modules on a `size` x `size` grid (quiet zone not
/// included: the page adds it).
#[derive(Serialize, Clone)]
pub struct QrPath {
    pub size: usize,
    pub d: String,
}

/// The URL's QR code (medium error correction), or None if it does not fit a QR code.
pub fn qr_svg_path(text: &str) -> Option<QrPath> {
    let code = qrcode::QrCode::with_error_correction_level(text.as_bytes(), qrcode::EcLevel::M).ok()?;
    let size = code.width();
    let colors = code.to_colors();
    let mut d = String::with_capacity(size * size * 4);
    for y in 0..size {
        let mut x = 0;
        while x < size {
            if colors[y * size + x] == qrcode::Color::Dark {
                let start = x;
                while x < size && colors[y * size + x] == qrcode::Color::Dark {
                    x += 1;
                }
                d.push_str(&format!("M{start} {y}h{}v1h-{}z", x - start, x - start));
            } else {
                x += 1;
            }
        }
    }
    Some(QrPath { size, d })
}

/// True for the private IPv4 ranges a home or office Wi-Fi hands out (RFC 1918) and link-local.
fn is_lan(ip: std::net::Ipv4Addr) -> bool {
    ip.is_private() || ip.is_link_local()
}

/// This device's IPv4 address on the local network, Wi-Fi first: the interfaces' private addresses
/// (Wi-Fi `en0` / `wlan*` before others; cellular `pdp_ip*` / `rmnet*` / `ccmni*` never), else the
/// address the system routes outward from (no packet is sent).
pub fn lan_ipv4() -> Option<std::net::Ipv4Addr> {
    #[cfg(all(unix, not(target_arch = "wasm32")))]
    {
        let mut best: Option<(u8, std::net::Ipv4Addr)> = None;
        // SAFETY: getifaddrs fills a linked list we only read and then free with freeifaddrs.
        unsafe {
            let mut head: *mut libc::ifaddrs = std::ptr::null_mut();
            if libc::getifaddrs(&mut head) == 0 {
                let mut cur = head;
                while !cur.is_null() {
                    let ifa = &*cur;
                    cur = ifa.ifa_next;
                    if ifa.ifa_addr.is_null() || i32::from((*ifa.ifa_addr).sa_family) != libc::AF_INET {
                        continue;
                    }
                    let flags = ifa.ifa_flags as i32;
                    if flags & libc::IFF_UP as i32 == 0 || flags & libc::IFF_LOOPBACK as i32 != 0 {
                        continue;
                    }
                    let sin = &*(ifa.ifa_addr as *const libc::sockaddr_in);
                    let ip = std::net::Ipv4Addr::from(u32::from_be(sin.sin_addr.s_addr));
                    if !is_lan(ip) {
                        continue;
                    }
                    let name = std::ffi::CStr::from_ptr(ifa.ifa_name).to_string_lossy();
                    let rank = if name == "en0" || name.starts_with("wlan") {
                        0
                    } else if ["pdp_ip", "rmnet", "ccmni", "utun", "ipsec", "awdl", "llw"].iter().any(|p| name.starts_with(p)) {
                        continue;
                    } else if ip.is_link_local() {
                        2
                    } else {
                        1
                    };
                    if best.is_none_or(|(r, _)| rank < r) {
                        best = Some((rank, ip));
                    }
                }
                libc::freeifaddrs(head);
            }
        }
        if let Some((_, ip)) = best {
            return Some(ip);
        }
    }
    let sock = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("192.0.2.1:9").ok()?;
    match sock.local_addr().ok()?.ip() {
        std::net::IpAddr::V4(ip) if !ip.is_loopback() && !ip.is_unspecified() => Some(ip),
        _ => None,
    }
}

static SESSION: OnceLock<Mutex<Option<ActiveSession>>> = OnceLock::new();
pub static MIRROR_ACTIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

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
                "qr": s.qr,
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
    // The URL other devices on the Wi-Fi open (and the QR code carries): this device's LAN address,
    // never loopback (127.0.0.1 sent the other device to itself).
    let host = lan_ipv4().map(|ip| ip.to_string()).unwrap_or_else(|| "127.0.0.1".into());
    let url = format!("http://{host}:{actual_port}/?pin={pin}");
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

    let qr = qr_svg_path(&url);
    let resp = json!({
        "active": true,
        "url": url,
        "pin": pin,
        "port": actual_port,
        "clients": 0,
        "qr": qr,
    });

    *guard = Some(ActiveSession {
        broadcaster,
        url,
        pin,
        port: actual_port,
        qr,
        shutdown_tx,
    });
    MIRROR_ACTIVE.store(true, std::sync::atomic::Ordering::Release);

    Ok((resp.to_string(), Vec::new()))
}

pub fn mirror_stop(_meta: &str) -> Result<(String, Vec<u8>), String> {
    let mut guard = session_lock().lock().unwrap();
    if let Some(session) = guard.take() {
        let _ = session.shutdown_tx.send(());
    }
    MIRROR_ACTIVE.store(false, std::sync::atomic::Ordering::Release);
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
            "qr": s.qr,
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
    if !MIRROR_ACTIVE.load(std::sync::atomic::Ordering::Relaxed) {
        return;
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lan_address_is_never_loopback() {
        if let Some(ip) = lan_ipv4() {
            assert!(!ip.is_loopback() && !ip.is_unspecified(), "{ip}");
        }
    }

    #[test]
    fn qr_path_covers_the_grid() {
        let qr = qr_svg_path("http://192.168.1.23:38400/?pin=123456").expect("fits a QR code");
        assert_eq!(qr.size % 4, 1, "QR sizes are 17 + 4 x version");
        assert!(qr.size >= 25);
        // The three finder patterns start with a 7-module dark run on the first row.
        assert!(qr.d.starts_with("M0 0h7v1h-7z"), "{}", &qr.d[..20]);
        if let Ok(out) = std::env::var("OPENNOTE_QR_SVG") {
            let n = qr.size + 8;
            let svg = format!(r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 -4 {n} {n}" width="{w}" height="{w}" shape-rendering="crispEdges"><rect x="-4" y="-4" width="{n}" height="{n}" fill="#fff"/><path d="{}" fill="#000"/></svg>"##, qr.d, w = n * 8);
            std::fs::write(out, svg).unwrap();
        }
    }
}
