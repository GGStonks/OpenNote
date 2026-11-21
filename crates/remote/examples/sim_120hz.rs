//! 120 Hz Synthetic Apple Pencil & Camera Generator for OpenNote Mirroring.
//!
//! Run with: `cargo run -p opennote-remote --example sim_120hz --release`

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use opennote_remote::{
    CameraPayload, LaserPointerPayload, MirrorBroadcaster, PointData, StrokeCommitPayload,
    StrokeLiveAddPayload, ToolType, DEFAULT_PORT,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let pin = std::env::var("OPENNOTE_PIN").unwrap_or_else(|_| "8492".to_string());
    let requested_port: u16 = std::env::var("OPENNOTE_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(DEFAULT_PORT);

    let bind_addr: SocketAddr = format!("0.0.0.0:{requested_port}").parse()?;
    let (listener, local_addr) = MirrorBroadcaster::bind_listener(bind_addr).await?;
    let port = local_addr.port();

    let broadcaster = MirrorBroadcaster::new(&pin);

    // Provide a sample document sync snapshot
    let broadcaster_clone = broadcaster.clone();
    broadcaster.set_snapshot_provider(Arc::new(|| {
        Some(b"OPENNOTE_SAMPLE_DOCUMENT_BYTES".to_vec())
    }));

    println!("\n╔═══════════════════════════════════════════════════════════════════════════════╗");
    println!("║                   OpenNote 120 Hz Vector Mirror Simulator                    ║");
    println!("╠═══════════════════════════════════════════════════════════════════════════════╣");
    println!(
        "║  Local Web Viewer:   http://127.0.0.1:{port}/?pin={pin:<35} ║",
        port = port,
        pin = pin
    );
    println!(
        "║  LAN Web Viewer:     http://<your-ip>:{port}/?pin={pin:<35} ║",
        port = port,
        pin = pin
    );
    println!(
        "║  WebSocket Target:   ws://127.0.0.1:{port}/ws                                 ║",
        port = port
    );
    println!(
        "║  PIN Hash (128-bit): {:<48} ║",
        format!("{:02X?}", &broadcaster.expected_hash()[..6])
    );
    println!("║                                                                               ║");
    println!("║  Wired USB Fallback:                                                          ║");
    println!(
        "║    Android: adb forward tcp:{port} tcp:{port}                                    ║",
        port = port
    );
    println!(
        "║    iOS:     iproxy {port} {port}                                                 ║",
        port = port
    );
    println!("╚═══════════════════════════════════════════════════════════════════════════════╝\n");

    // Spawn server task
    tokio::spawn(async move {
        if let Err(e) = broadcaster_clone.serve_listener(listener).await {
            eprintln!("Mirror server error: {e}");
        }
    });

    // 120 Hz generator loop: 8333.33 microseconds per tick
    let mut interval = tokio::time::interval(Duration::from_micros(8333));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    let start_time = Instant::now();
    let mut stroke_id: u32 = 1;
    let mut stroke_points_in_flight: Vec<PointData> = Vec::new();
    let mut last_commit = Instant::now();

    println!("Streaming synthetic 120 Hz vector events... (Press Ctrl+C to stop)");

    loop {
        interval.tick().await;

        let elapsed_s = start_time.elapsed().as_secs_f32();
        let timestamp_us = (start_time.elapsed().as_micros()) as u64;

        // 1. Smooth Lissajous curve for Apple Pencil simulation:
        // Center around (400, 500) inside standard 816 x 1056 page
        let a = 2.0;
        let b = 3.0;
        let delta = std::f32::consts::FRAC_PI_2;
        let t_param = elapsed_s * 1.8;

        let pen_x = 408.0 + 260.0 * (a * t_param + delta).sin();
        let pen_y = 528.0 + 320.0 * (b * t_param).sin();

        // Pressure modulated smoothly between 0.25 and 0.95
        let pressure = 0.6 + 0.35 * (elapsed_s * 4.0).sin();

        let pt = PointData {
            x: pen_x,
            y: pen_y,
            pressure,
            t_ms: elapsed_s * 1000.0,
        };
        stroke_points_in_flight.push(pt);

        // Broadcast Live Stroke points
        broadcaster.broadcast_live_points(StrokeLiveAddPayload {
            stroke_id,
            tool_type: ToolType::Pen,
            color_rgba: 0x2563EBFF, // Blue
            base_width: 3.5,
            points: vec![pt],
        });

        // 2. Gentle camera motion (slow breathing pan and subtle zoom)
        let cam_x = 408.0 + 30.0 * (elapsed_s * 0.4).cos();
        let cam_y = 528.0 + 40.0 * (elapsed_s * 0.3).sin();
        let cam_zoom = 1.0 + 0.08 * (elapsed_s * 0.5).sin();

        broadcaster.broadcast_camera(CameraPayload {
            timestamp_us,
            x: cam_x,
            y: cam_y,
            zoom: cam_zoom,
            rotation: 0.0,
            flags: 1, // IsInMotion
        });

        // 3. Laser pointer moving ahead of the pen like a presenter tool
        let laser_x = pen_x + 50.0 * (elapsed_s * 3.0).cos();
        let laser_y = pen_y + 50.0 * (elapsed_s * 3.0).sin();
        broadcaster.broadcast_laser(LaserPointerPayload {
            x: laser_x,
            y: laser_y,
            intensity: 0.95,
            color_rgba: 0xEF4444FF, // Red glow
        });

        // 4. Commit stroke every 3 seconds to keep scene history populated
        if last_commit.elapsed() >= Duration::from_secs(3) {
            let mut min_x = f32::INFINITY;
            let mut min_y = f32::INFINITY;
            let mut max_x = f32::NEG_INFINITY;
            let mut max_y = f32::NEG_INFINITY;
            for p in &stroke_points_in_flight {
                min_x = min_x.min(p.x);
                min_y = min_y.min(p.y);
                max_x = max_x.max(p.x);
                max_y = max_y.max(p.y);
            }

            broadcaster.broadcast_stroke_commit(StrokeCommitPayload {
                stroke_id,
                page_id: "page-0".to_string(),
                stroke_key: 1000 + stroke_id as u64,
                bbox: [min_x - 4.0, min_y - 4.0, max_x + 4.0, max_y + 4.0],
            });

            stroke_id += 1;
            stroke_points_in_flight.clear();
            last_commit = Instant::now();
        }
    }
}
