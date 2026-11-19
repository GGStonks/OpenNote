//! The library's entry point on the PC, for bench/ui.mjs (a stand-in shell answers the page's
//! `rust` command with it).
//!
//! - `opennote_native_cli <method>`: one call, the framed request on stdin, the framed reply on stdout.
//! - `opennote_native_cli --serve <w> <h>`: a running shell with a native canvas (an offscreen
//!   host of w x h device px, the active one), as the iOS / Android shells keep it: calls in a
//!   row, each `u32 method length, method, u32 request length, request` in, `u32 reply length,
//!   reply` out (little endian). `canvasSnapshot` draws the frame and replies its RGBA pixels.
//!   `--serve <w> <h> --tick <hz>`: also a display link: `draw_active` every 1/hz s on a thread
//!   of its own, as the shells' render threads call it (the Rust camera advances there).
use std::io::{Read, Write};

fn read_u32(r: &mut impl Read) -> Option<u32> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b).ok()?;
    Some(u32::from_le_bytes(b))
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--serve") {
        let (w, h): (u32, u32) = (
            args[2].parse().expect("width"),
            args[3].parse().expect("height"),
        );
        assert!(
            opennote_native::canvas_service::attach_offscreen(w, h),
            "no GPU for the canvas"
        );
        if let Some(hz) = args
            .iter()
            .position(|a| a == "--tick")
            .and_then(|i| args.get(i + 1))
            .and_then(|v| v.parse::<f64>().ok())
            .filter(|hz| *hz > 0.0)
        {
            opennote_native::viewport_service::set_display_hz(hz);
            std::thread::spawn(move || {
                let period = std::time::Duration::from_secs_f64(1.0 / hz);
                let mut next = std::time::Instant::now();
                loop {
                    opennote_native::canvas_service::draw_active();
                    next += period;
                    let now = std::time::Instant::now();
                    if next > now {
                        std::thread::sleep(next - now);
                    } else {
                        next = now;
                    }
                }
            });
        }
        let (mut input, mut output) = (std::io::stdin().lock(), std::io::stdout().lock());
        while let Some(n) = read_u32(&mut input) {
            let mut method = vec![0u8; n as usize];
            input.read_exact(&mut method).expect("method");
            let len = read_u32(&mut input).expect("request length");
            let mut request = vec![0u8; len as usize];
            input.read_exact(&mut request).expect("request");
            let method = String::from_utf8_lossy(&method).to_string();
            let reply = if method == "canvasSnapshot" {
                opennote_native::canvas_service::draw_active();
                let px = opennote_native::canvas_service::offscreen_pixels();
                opennote_native::frame(&format!("{{\"width\":{w},\"height\":{h}}}"), &px)
            } else {
                opennote_native::call_framed(&method, &request)
            };
            output
                .write_all(&(reply.len() as u32).to_le_bytes())
                .expect("out");
            output.write_all(&reply).expect("out");
            output.flush().expect("flush");
        }
        return;
    }
    let method = args.get(1).cloned().unwrap_or_default();
    let mut request = Vec::new();
    std::io::stdin().read_to_end(&mut request).expect("stdin");
    let reply = opennote_native::call_framed(&method, &request);
    std::io::stdout().write_all(&reply).expect("stdout");
}
