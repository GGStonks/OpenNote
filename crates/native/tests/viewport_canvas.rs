//! The Rust camera places the canvas (rust/DECISIONS.md ADR-006): the page's frame, sent once
//! with where its surface was, is drawn where two fingers took the camera, with no new frame from
//! the page; the gesture is recorded for the crash report, and the page reads the camera.
use opennote_native::canvas_service::{attach_offscreen, detach, draw_active, offscreen_pixels};
use opennote_native::viewport_service::{opennote_viewport_touch, poll, reset};
use opennote_native::{call_framed, frame, unframe};
use serde_json::{json, Value};

fn call(method: &str, meta: Value) -> Value {
    let reply = call_framed(method, &frame(&meta.to_string(), &[]));
    let (m, _) = unframe(&reply).unwrap();
    serde_json::from_str(m).unwrap()
}

fn dark_at(x: u32, y: u32, w: u32) -> bool {
    let px = offscreen_pixels();
    let i = ((y * w + x) * 4) as usize;
    px[i] < 80 && px[i + 1] < 80 && px[i + 2] < 80
}

#[test]
fn two_fingers_move_the_canvas_without_the_page() {
    reset();
    let (w, h) = (300u32, 400u32);
    assert!(attach_offscreen(w, h), "a GPU on the PC");
    let points: Vec<Value> = (0..=20).map(|i| json!({ "x": 20.0 + i as f64 * 5.0, "y": 60.0, "pressure": 0.5, "t": i as f64 * 8.0 })).collect();
    call(
        "canvasScene",
        json!({ "page": "surface", "strokes": [{ "id": "s1", "createdAt": 1, "tool": "pen", "color": "#000000", "width": 4, "opacity": 1, "penStyle": "fountain", "lineStyle": "solid", "points": points }] }),
    );
    // A 150 x 200 CSS px scroll view at dpr 2; the surface at (8, 8) in a 156 x 600 content.
    let layout = json!({
        "layout": { "view": [0, 0, 150, 200], "content": [156, 600], "surface": [8, 8], "sheets": [[0, 0, 140, 580]],
                    "pull": true, "single": false, "holes": [], "dpr": 2, "frameMs": 16.7, "owned": true },
        "adopt": { "zoom": 1, "sl": 0, "st": 0, "sub": [0, 0], "fit": null }
    });
    let cam = call("viewportLayout", layout);
    assert_eq!(cam["owned"], true, "{cam}");
    // The page's frame at its camera: the surface at device (16, 16), scale 2.
    let k = 2.0;
    call(
        "canvasFrame",
        json!({ "clear": [0.5, 0.5, 0.5, 1], "surface": [k, 16, 16],
                "pages": [{ "page": "", "tf": [k, 0, 0, k, 16, 16], "paper": { "width": 140, "height": 580, "style": 0, "base": [1, 1, 1, 1], "origin": [0, 0] } },
                          { "page": "surface", "tf": [k, 0, 0, k, 16, 16], "paper": null }] }),
    );
    draw_active();
    // Page (70, 60) -> device (16 + 140, 16 + 120).
    assert!(dark_at(156, 136, w), "the ink where the page put it");

    // Two fingers up 30 CSS px: the camera scrolls 30, the ink goes up 60 device px.
    assert!(opennote_viewport_touch(1, 0, 50.0, 150.0));
    assert!(opennote_viewport_touch(2, 0, 90.0, 150.0));
    for s in 1..=10 {
        opennote_viewport_touch(1, 1, 50.0, 150.0 - 3.0 * s as f64);
        opennote_viewport_touch(2, 1, 90.0, 150.0 - 3.0 * s as f64);
        draw_active();
    }
    let cam = call("viewportCamera", json!({}));
    assert!(
        (cam["camera"]["st"].as_f64().unwrap() - 30.0).abs() < 1e-9,
        "{cam}"
    );
    assert!(cam["camera"]["gesture"].as_bool().unwrap());
    draw_active();
    assert!(dark_at(156, 76, w), "the ink moved with the fingers");
    assert!(
        !dark_at(156, 136, w),
        "and is no longer where the page had it"
    );

    // A finger outside the note is not the camera's.
    assert!(!opennote_viewport_touch(3, 0, 400.0, 150.0));

    // Lifted together: no fling (useViewport); the gesture goes to the log once at rest.
    opennote_viewport_touch(1, 2, 50.0, 120.0);
    opennote_viewport_touch(2, 2, 90.0, 120.0);
    draw_active();
    let stats = call("canvasStats", json!({}));
    assert_eq!(stats["viewport"]["gestures"], 1, "{stats}");
    let pushed: Value = serde_json::from_str(&poll(1e12).expect("a camera to push")).unwrap();
    let log = pushed["log"].as_array().unwrap();
    assert_eq!(log.len(), 1, "{pushed}");
    assert!(log[0]["frames"].as_u64().unwrap() >= 10, "{pushed}");
    assert!(poll(2e12).is_none(), "nothing new to push");

    // The page takes the camera back (a note the canvas does not own): its own frames again.
    let mut l = layout_owned(false);
    l["adopt"] = Value::Null;
    call("viewportLayout", l);
    draw_active();
    assert!(dark_at(156, 136, w), "the page's own placement");
    detach();
}

fn layout_owned(owned: bool) -> Value {
    json!({ "layout": { "view": [0, 0, 150, 200], "content": [156, 600], "surface": [8, 8], "sheets": [[0, 0, 140, 580]], "dpr": 2, "owned": owned } })
}
