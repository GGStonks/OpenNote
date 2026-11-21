//! Native Rust PC Receiver for OpenNote Vector Mirroring.
//!
//! Connects to an active tablet session, sends Handshake, and processes binary packets.
//!
//! Usage:
//! `cargo run -p opennote-remote --bin opennote-receiver -- --host 127.0.0.1:38400 --pin 8492 --benchmark`

use futures_util::{SinkExt, StreamExt};
use std::time::{Duration, Instant};
use tokio_tungstenite::tungstenite::protocol::Message;

use opennote_remote::{hash_pin, HandshakePayload, Packet};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();

    let mut host = "127.0.0.1:38400".to_string();
    let mut pin = "8492".to_string();
    let mut benchmark = false;

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--host" => {
                if i + 1 < args.len() {
                    host = args[i + 1].clone();
                    i += 1;
                }
            }
            "--pin" => {
                if i + 1 < args.len() {
                    pin = args[i + 1].clone();
                    i += 1;
                }
            }
            "--benchmark" => {
                benchmark = true;
            }
            "-h" | "--help" => {
                println!("OpenNote Native Desktop Receiver");
                println!("Usage: opennote-receiver [--host <ip:port>] [--pin <pin>] [--benchmark]");
                return Ok(());
            }
            _ => {}
        }
        i += 1;
    }

    let url = if host.starts_with("ws://") || host.starts_with("wss://") {
        host
    } else {
        format!("ws://{host}/ws")
    };

    println!("Connecting to OpenNote Mirror at {url} (PIN: {pin})...");

    let (ws_stream, _) = tokio_tungstenite::connect_async(&url).await?;
    let (mut sink, mut src) = ws_stream.split();

    // Send 0x01 Handshake
    let handshake = Packet::Handshake(HandshakePayload {
        client_version: 1,
        display_dpi: 144.0,
        auth_token_hash: hash_pin(&pin),
    });
    sink.send(Message::Binary(handshake.encode().to_vec()))
        .await?;
    println!("Handshake sent. Connected and streaming!");

    let mut total_packets = 0u64;
    let mut total_bytes = 0u64;
    let mut period_packets = 0u64;
    let mut period_bytes = 0u64;
    let mut last_report = Instant::now();
    let mut last_packet_time: Option<Instant> = None;
    let mut jitter_sum_us = 0u64;
    let mut jitter_samples = 0u64;
    let expected_interval_us = 8333.0f64; // 120 Hz nominal

    while let Some(msg_res) = src.next().await {
        let msg = match msg_res {
            Ok(m) => m,
            Err(e) => {
                eprintln!("WebSocket stream error: {e}");
                break;
            }
        };

        let now = Instant::now();

        match msg {
            Message::Binary(bytes) => {
                total_packets += 1;
                total_bytes += bytes.len() as u64;
                period_packets += 1;
                period_bytes += bytes.len() as u64;

                if let Some(prev) = last_packet_time {
                    let dt_us = now.duration_since(prev).as_micros() as f64;
                    let jitter = (dt_us - expected_interval_us).abs() as u64;
                    jitter_sum_us += jitter;
                    jitter_samples += 1;
                }
                last_packet_time = Some(now);

                let packet = match Packet::decode(&bytes) {
                    Ok(p) => p,
                    Err(e) => {
                        eprintln!("Packet decode error: {e}");
                        continue;
                    }
                };

                if !benchmark {
                    match &packet {
                        Packet::Camera(c) => {
                            if total_packets.is_multiple_of(120) {
                                println!(
                                    "[Camera] pos=({:.1}, {:.1}) zoom={:.2}x flags={}",
                                    c.x, c.y, c.zoom, c.flags
                                );
                            }
                        }
                        Packet::StrokeLiveAdd(s) => {
                            if total_packets.is_multiple_of(120) {
                                println!("[LiveStroke] id={} pts={}", s.stroke_id, s.points.len());
                            }
                        }
                        Packet::StrokeCommit(c) => {
                            println!(
                                "[Commit] stroke_id={} page='{}' bbox={:?}",
                                c.stroke_id, c.page_id, c.bbox
                            );
                        }
                        Packet::LaserPointer(l) => {
                            if total_packets.is_multiple_of(120) {
                                println!(
                                    "[Laser] pos=({:.1}, {:.1}) intensity={:.2}",
                                    l.x, l.y, l.intensity
                                );
                            }
                        }
                        Packet::DocumentSync(d) => {
                            println!(
                                "[DocumentSync] decompressed size={} bytes",
                                d.raw_scene.len()
                            );
                        }
                        Packet::Handshake(_) => {}
                    }
                }
            }
            Message::Ping(payload) => {
                let _ = sink.send(Message::Pong(payload)).await;
            }
            Message::Close(_) => {
                println!("Server closed connection.");
                break;
            }
            _ => {}
        }

        if last_report.elapsed() >= Duration::from_secs(1) {
            let elapsed_s = last_report.elapsed().as_secs_f64();
            let pps = period_packets as f64 / elapsed_s;
            let kbps = (period_bytes as f64 / 1024.0) / elapsed_s;
            let avg_jitter = if jitter_samples > 0 {
                jitter_sum_us as f64 / jitter_samples as f64
            } else {
                0.0
            };

            if benchmark {
                println!(
                    "Mirror Benchmark: {:>6.1} pkt/s | {:>7.2} KB/s | Jitter: {:>6.1} µs | Total: {} pkts ({:.2} MB)",
                    pps,
                    kbps,
                    avg_jitter,
                    total_packets,
                    total_bytes as f64 / (1024.0 * 1024.0)
                );
            }

            period_packets = 0;
            period_bytes = 0;
            jitter_sum_us = 0;
            jitter_samples = 0;
            last_report = Instant::now();
        }
    }

    Ok(())
}
