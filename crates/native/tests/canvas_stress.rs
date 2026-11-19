//! The native canvas under the three threads that reach it on a device, at once, for a few
//! seconds, on the PC's offscreen host:
//! - the page's bridge: scenes of the reference strokes (bench/rust-ref/ink.json, as compare.rs
//!   lays them out) sent as rustCore.ts sends them (`canvasSceneBin`: points once, then keys),
//!   pages removed, and frames with random transforms: zoom 0.05 to 60 at dpr 1 to 3, pages far
//!   off the surface, NaN and infinity (JSON null, 1e40), zero, negative and huge papers, and
//!   requests that do not parse;
//! - the render thread drawing every "display frame";
//! - the surface's lifecycle attaching, resizing (to zero and to sizes no GPU has) and detaching.
//!
//! It must end without a panic, an abort or a deadlock; the bridge must never wait for a draw
//! (each call returns in milliseconds while the other threads hold the GPU); and the canvas status
//! must show what could not be drawn (placements skipped, failed attaches recorded as errors)
//! rather than a crash. Afterwards the canvas still draws the page.

use opennote_native::canvas_service::{
    attach_offscreen, detach, draw_active, offscreen_pixels, resize,
};
use opennote_native::{call_framed, frame, unframe};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn call(method: &str, meta: &Value, data: &[f64]) -> Value {
    call_raw(method, &meta.to_string(), data)
}

fn call_raw(method: &str, meta: &str, data: &[f64]) -> Value {
    let bytes: Vec<u8> = data.iter().flat_map(|v| v.to_le_bytes()).collect();
    let reply = call_framed(method, &frame(meta, &bytes));
    let (m, _) = unframe(&reply).expect("a framed reply");
    serde_json::from_str(m).expect("a JSON reply")
}

/// xorshift64*: the same run every time.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
    fn range(&mut self, a: f64, b: f64) -> f64 {
        a + (b - a) * self.unit()
    }
    fn pick(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

/// The reference strokes as the page sends them: style (`s`) and point count, then the points.
fn reference_strokes() -> Vec<(Value, Vec<f64>)> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../bench/rust-ref/ink.json");
    let refs: Value = match std::fs::read_to_string(path) {
        Ok(t) => serde_json::from_str(&t).expect("ink.json"),
        Err(_) => return synthetic_strokes(),
    };
    refs["strokes"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .map(|(i, r)| {
            let (col, row) = (i % 6, i / 6);
            let pts: Vec<[f64; 4]> = r["points"].as_array().unwrap().iter().map(|p| std::array::from_fn(|k| p[k].as_f64().unwrap())).collect();
            let (min_x, min_y) = pts.iter().fold((f64::INFINITY, f64::INFINITY), |m, p| (m.0.min(p[0]), m.1.min(p[1])));
            let (ox, oy) = (15.0 + col as f64 * 133.0, 20.0 + row as f64 * 172.0);
            let data: Vec<f64> = pts.iter().flat_map(|p| [ox + p[0] - min_x, oy + p[1] - min_y, p[3], p[2]]).collect();
            let (tool, pen_style, color) = match row {
                4 => ("pen", Some("ballpoint"), "#1a3d8f"),
                5 => ("highlighter", None, "#f5c400"),
                _ => ("pen", Some("fountain"), "#000000"),
            };
            let s = json!({ "id": format!("s{i}"), "createdAt": i, "tool": tool, "color": color, "width": r["width"], "opacity": 1, "penStyle": pen_style, "lineStyle": if i % 7 == 3 { "dashed" } else { "solid" } });
            (s, data)
        })
        .collect()
}

/// Without bench/rust-ref (npm run bench:rustref): lines like canvas_cache.rs's.
fn synthetic_strokes() -> Vec<(Value, Vec<f64>)> {
    (0..36)
        .map(|i| {
            let y = 30.0 + 20.0 * i as f64;
            let pts: Vec<f64> = (0..=20).flat_map(|j| [20.0 + j as f64 * 5.0, y, 0.5, j as f64 * 8.0]).collect();
            (json!({ "id": format!("s{i}"), "createdAt": i, "tool": "pen", "color": "#000000", "width": 4, "opacity": 1, "penStyle": "fountain", "lineStyle": "solid" }), pts)
        })
        .collect()
}

/// A number the page might send, valid or not (None: JSON null, as JSON.stringify writes NaN
/// and infinity).
fn num(rng: &mut Rng, valid: f64) -> Value {
    match rng.pick(40) {
        0 => Value::Null,
        1 => json!(1e40),
        2 => json!(-1e40),
        3 => json!(0.0),
        4 => json!(1e12),
        _ => json!(valid),
    }
}

fn random_frame(rng: &mut Rng, pages: &[String]) -> Value {
    let dpr = [1.0, 2.0, 2.625, 3.0][rng.pick(4)];
    let zoom = (rng.range(0.05f64.ln(), 60f64.ln())).exp();
    let k = zoom * dpr;
    let (ox, oy) = match rng.pick(4) {
        0 => (rng.range(-1e7, 1e7), rng.range(-1e7, 1e7)),
        _ => (
            rng.range(-3000.0, 3000.0) * k,
            rng.range(-3000.0, 3000.0) * k,
        ),
    };
    let mut placements = Vec::new();
    for s in 0..rng.pick(4) {
        let w = match rng.pick(12) {
            0 => json!(0.0),
            1 => json!(-50.0),
            2 => json!(1e9),
            3 => Value::Null,
            _ => json!(816.0),
        };
        let top = s as f64 * 1066.0 * k;
        placements.push(json!({ "page": "", "tf": [num(rng, k), 0, 0, num(rng, k), num(rng, ox), num(rng, oy + top)],
            "paper": { "width": w, "height": num(rng, 1056.0), "style": rng.pick(9), "base": [1, num(rng, 1.0), 1, 1], "dark": rng.pick(2) == 0, "pattern": if rng.pick(3) == 0 { json!([0.2, 0.3, num(rng, 0.9)]) } else { Value::Null }, "origin": [0, num(rng, top / k)] } }));
    }
    for p in pages {
        let a = if rng.pick(10) == 0 {
            k * rng.range(-1.0, 1.0)
        } else {
            0.0
        };
        placements.push(json!({ "page": p, "tf": [num(rng, k), a, -a, num(rng, k), num(rng, ox), num(rng, oy)], "paper": null }));
    }
    json!({ "clear": [num(rng, 0.9), 0.9, 0.9, 1], "pages": placements })
}

#[test]
fn three_threads_never_crash_the_canvas() {
    let strokes = Arc::new(reference_strokes());
    let run = Duration::from_millis(
        std::env::var("CANVAS_STRESS_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(4000),
    );
    let stop = Arc::new(AtomicBool::new(false));
    let draws = Arc::new(AtomicU64::new(0));
    let drawn = Arc::new(AtomicU64::new(0));
    assert!(attach_offscreen(400, 300), "a GPU on the PC");

    // The page's bridge.
    let bridge = {
        let (stop, strokes) = (stop.clone(), strokes.clone());
        std::thread::Builder::new().name("bridge".into()).spawn(move || {
            let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
            let mut held: Vec<Vec<usize>> = vec![Vec::new(); 4];
            let (mut calls, mut slowest_frame) = (0u64, Duration::ZERO);
            while !stop.load(Ordering::SeqCst) {
                let pi = rng.pick(4);
                let page = format!("p{pi}");
                match rng.pick(10) {
                    // A scene: some strokes new (sent whole), the rest by key; or every one again.
                    0..=2 => {
                        let n = 1 + rng.pick(strokes.len());
                        let pick: Vec<usize> = (0..n).map(|_| rng.pick(strokes.len())).collect::<std::collections::BTreeSet<_>>().into_iter().collect();
                        let full = rng.pick(3) == 0;
                        let mut heads = Vec::new();
                        let mut data = Vec::new();
                        for &i in &pick {
                            if !full && held[pi].contains(&i) {
                                heads.push(json!({ "k": i }));
                            } else {
                                heads.push(json!({ "k": i, "n": strokes[i].1.len() / 4, "s": strokes[i].0 }));
                                data.extend_from_slice(&strokes[i].1);
                            }
                        }
                        let r = call("canvasSceneBin", &json!({ "page": page, "strokes": heads }), &data);
                        assert!(r.get("error").is_none(), "{r}");
                        held[pi] = if r.get("missing").is_some() { Vec::new() } else { pick };
                    }
                    3 => {
                        call("canvasSceneBin", &json!({ "page": page, "strokes": [] }), &[]);
                        held[pi].clear();
                    }
                    4 => {
                        let bad = ["{", r#"{"clear":null}"#, r#"{"clear":null,"pages":[{"page":"p1","tf":[1,2]}]}"#, r#"{"clear":"x","pages":7}"#][rng.pick(4)];
                        let r = call_raw("canvasFrame", bad, &[]);
                        assert_eq!(r["ok"], false, "{bad}: {r}");
                    }
                    5 => {
                        let r = call("canvasStats", &json!({}), &[]);
                        assert!(r.get("attached").is_some(), "{r}");
                    }
                    _ => {
                        let pages: Vec<String> = (0..4).filter(|_| rng.pick(2) == 0).map(|i| format!("p{i}")).collect();
                        let f = random_frame(&mut rng, &pages);
                        let t0 = Instant::now();
                        let r = call("canvasFrame", &f, &[]);
                        slowest_frame = slowest_frame.max(t0.elapsed());
                        assert!(r.get("error").is_none(), "{r}");
                    }
                }
                calls += 1;
            }
            (calls, slowest_frame)
        })
    }
    .unwrap();

    // The render thread.
    let render = {
        let (stop, draws, drawn) = (stop.clone(), draws.clone(), drawn.clone());
        std::thread::Builder::new()
            .name("opennote-canvas".into())
            .spawn(move || {
                let mut n = 0u64;
                while !stop.load(Ordering::SeqCst) {
                    if draw_active() {
                        drawn.fetch_add(1, Ordering::SeqCst);
                    }
                    draws.fetch_add(1, Ordering::SeqCst);
                    n += 1;
                    if n.is_multiple_of(50) {
                        let _ = offscreen_pixels();
                    }
                    std::thread::sleep(Duration::from_millis(2));
                }
            })
    }
    .unwrap();

    // The surface's lifecycle.
    let lifecycle = {
        let stop = stop.clone();
        std::thread::Builder::new()
            .name("ui".into())
            .spawn(move || {
                let mut rng = Rng(0x0123_4567_89ab_cdef);
                let mut refused = 0;
                while !stop.load(Ordering::SeqCst) {
                    match rng.pick(8) {
                        // The surface goes, and comes back a little later (the app in the background).
                        0 => {
                            detach();
                            std::thread::sleep(Duration::from_millis(rng.pick(30) as u64));
                            assert!(attach_offscreen(400, 300));
                        }
                        1 => {
                            let (w, h) = [
                                (0, 300),
                                (1 << 20, 64),
                                (320, 1 << 18),
                                (1, 1),
                                (800, 1280),
                                (400, 300),
                            ][rng.pick(6)];
                            let ok = attach_offscreen(w, h);
                            if w == 0 || w > 1 << 16 || h > 1 << 16 {
                                assert!(!ok, "{w} x {h} cannot be attached");
                                refused += 1;
                                assert!(attach_offscreen(400, 300));
                            }
                        }
                        _ => {
                            let (w, h) = [
                                (0, 0),
                                (1 << 20, 1 << 20),
                                (1, 9000),
                                (640, 480),
                                (1280, 800),
                                (400, 300),
                            ][rng.pick(6)];
                            resize(w, h);
                        }
                    }
                    std::thread::sleep(Duration::from_millis(rng.pick(40) as u64));
                }
                refused
            })
    }
    .unwrap();

    // Run, then stop; a thread that does not end is a deadlock.
    std::thread::sleep(run);
    stop.store(true, Ordering::SeqCst);
    let t0 = Instant::now();
    while !(bridge.is_finished() && render.is_finished() && lifecycle.is_finished()) {
        assert!(
            t0.elapsed() < Duration::from_secs(60),
            "a thread did not end: deadlock"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    let (calls, slowest_frame) = bridge.join().expect("the bridge thread panicked");
    render.join().expect("the render thread panicked");
    let refused = lifecycle.join().expect("the lifecycle thread panicked");

    let st = call("canvasStats", &json!({}), &[]);
    eprintln!(
        "{calls} bridge calls (slowest canvasFrame {:.2} ms), {} draws ({} frames drawn), {refused} attaches refused; status {st}",
        slowest_frame.as_secs_f64() * 1000.0,
        draws.load(Ordering::SeqCst),
        drawn.load(Ordering::SeqCst)
    );
    assert!(drawn.load(Ordering::SeqCst) > 0, "frames were drawn");
    assert!(
        slowest_frame < Duration::from_millis(250),
        "the bridge waited {slowest_frame:?} (for a draw?)"
    );
    assert!(
        refused > 0 && st["errors"].as_u64().unwrap_or(0) > 0,
        "attaches refused are recorded as errors: {st}"
    );

    // Afterwards the canvas still draws the page: one stroke, a valid frame.
    assert!(attach_offscreen(200, 200));
    let (s, data) = &synthetic_strokes()[1];
    call(
        "canvasSceneBin",
        &json!({ "page": "after", "strokes": [{ "k": 1, "n": data.len() / 4, "s": s }] }),
        data,
    );
    let r = call(
        "canvasFrame",
        &json!({ "clear": [1, 1, 1, 1], "pages": [{ "page": "after", "tf": [1, 0, 0, 1, 0, 0], "paper": null }, { "page": "bad", "tf": [null, 0, 0, 1, 0, 0], "paper": null }] }),
        &[],
    );
    assert_eq!(r["ok"], true, "{r}");
    assert!(draw_active());
    let px = offscreen_pixels();
    assert!(
        px[((50 * 200 + 60) * 4) as usize] < 100,
        "the stroke is drawn"
    );
    let st = call("canvasStats", &json!({}), &[]);
    assert!(
        st["skippedPages"].as_u64().unwrap_or(0) > 0,
        "the placement that cannot be drawn is counted: {st}"
    );
    detach();
}
