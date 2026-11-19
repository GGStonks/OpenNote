//! The page's native-canvas messages, exactly as CanvasPage builds them (`canvasScene`,
//! `canvasFrame`: one placement per sheet with its paper and no scene, then the strokes' placement
//! with no paper; `pattern: null`, `paper: null`), through the framed entry point the shells use,
//! into an active host: the desk, each sheet's paper and the ink must be drawn. A frame the bridge
//! cannot parse is dropped silently and the shell shows a canvas nobody drew (black).
use opennote_native::canvas_service::{attach_offscreen, detach, draw_active, offscreen_pixels};
use opennote_native::{call_framed, frame, unframe};
use serde_json::{json, Value};

fn call(method: &str, meta: Value) -> Value {
    let reply = call_framed(method, &frame(&meta.to_string(), &[]));
    let (m, _) = unframe(&reply).unwrap();
    serde_json::from_str(m).unwrap()
}

#[test]
fn the_pages_frame_is_drawn() {
    let (w, h) = (300u32, 400u32);
    assert!(attach_offscreen(w, h), "a GPU on the PC");
    let points: Vec<Value> = (0..=20).map(|i| json!({ "x": 20.0 + i as f64 * 5.0, "y": 60.0, "pressure": 0.5, "t": i as f64 * 8.0 })).collect();
    let scene = call(
        "canvasScene",
        json!({ "page": "surface", "strokes": [{ "id": "s1", "createdAt": 1, "tool": "pen", "color": "#000000", "width": 4, "opacity": 1, "penStyle": "fountain", "lineStyle": "solid", "points": points }] }),
    );
    assert_eq!(scene["attached"], true, "{scene}");
    assert!(scene["capsules"].as_u64().unwrap() > 0, "{scene}");
    // dpr 2, zoom 1: k = 2; two sheets of 140 x 90 page px stacked with a 10 px gap.
    let k = 2.0;
    let sheet = |top: f64, color: [f64; 3]| json!({ "page": "", "tf": [k, 0, 0, k, 0.0, top * k], "paper": { "width": 140, "height": 90, "style": 1, "base": [color[0], color[1], color[2], 1], "dark": false, "pattern": null, "origin": [0, top] } });
    let fr = call(
        "canvasFrame",
        json!({
            "clear": [0.5, 0.5, 0.5, 1],
            "pages": [sheet(0.0, [1.0, 1.0, 1.0]), sheet(100.0, [1.0, 1.0, 0.0]), { "page": "surface", "tf": [k, 0, 0, k, 0, 0], "paper": null }],
        }),
    );
    assert_eq!(fr["ok"], true, "the page's frame must parse: {fr}");
    assert!(draw_active());
    let stats = call("canvasStats", json!({}));
    assert_eq!(stats["frames"], 1, "{stats}");
    // Read the pixels back through a second draw into the offscreen texture.
    let px = offscreen_pixels();
    let at = |x: u32, y: u32| {
        let i = ((y * w + x) * 4) as usize;
        [px[i], px[i + 1], px[i + 2]]
    };
    let near = |a: [u8; 3], b: [u8; 3]| a.iter().zip(b).all(|(x, y)| x.abs_diff(y) <= 1);
    assert!(near(at(290, 390), [128, 128, 128]), "the desk");
    assert!(
        near(at(20, 20), [255, 255, 255]),
        "sheet 1's white paper (top band, no lines)"
    );
    assert!(near(at(20, 210), [255, 255, 0]), "sheet 2's yellow paper");
    assert!(
        at(100, 120)[0] < 80,
        "the ink at page (50, 60), device (100, 120)"
    );
    detach();
    assert_eq!(call("canvasStats", json!({}))["attached"], false);
}
