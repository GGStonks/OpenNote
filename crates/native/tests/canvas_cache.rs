//! `canvasSceneBin` as rustCore.ts sends it: each stroke's points once, then its key alone. A new
//! stroke on a long note must cost its own geometry (`built`), the scene must equal one built from
//! every stroke, a key the canvas does not hold is answered `missing`, and a host made later
//! (Android, back from the background) shows the scene and the frame without the page resending.
//! One test: the library's canvas state is global.
use opennote_native::{call_framed, frame, opennote_canvas_host_draw, opennote_canvas_host_free, opennote_canvas_host_offscreen, set_active_host, unframe};
use serde_json::{json, Value};

fn call(method: &str, meta: Value, data: &[f64]) -> Value {
    let bytes: Vec<u8> = data.iter().flat_map(|v| v.to_le_bytes()).collect();
    let reply = call_framed(method, &frame(&meta.to_string(), &bytes));
    let (m, _) = unframe(&reply).unwrap();
    serde_json::from_str(m).unwrap()
}

/// Stroke `i`: a horizontal pen line at y = 30 + 20 i (page px), 21 points of x, y, pressure, t.
fn stroke(i: usize) -> (Value, Vec<f64>) {
    let y = 30.0 + 20.0 * i as f64;
    let pts: Vec<f64> = (0..=20).flat_map(|j| [20.0 + j as f64 * 5.0, y, 0.5, j as f64 * 8.0]).collect();
    let s = json!({ "id": format!("s{i}"), "createdAt": i, "tool": "pen", "color": "#000000", "width": 4, "opacity": 1, "penStyle": "fountain", "lineStyle": "solid" });
    (s, pts)
}

fn full(keys: &[usize]) -> (Vec<Value>, Vec<f64>) {
    let mut heads = Vec::new();
    let mut data = Vec::new();
    for &i in keys {
        let (s, pts) = stroke(i);
        heads.push(json!({ "k": i, "n": pts.len() / 4, "s": s }));
        data.extend(pts);
    }
    (heads, data)
}

#[test]
fn strokes_are_built_once_and_a_new_host_gets_the_scene() {
    let (w, h) = (200u32, 200u32);
    let host = unsafe { opennote_canvas_host_offscreen(w, h) };
    assert!(!host.is_null(), "a GPU on the PC");
    set_active_host(host);

    let (heads, data) = full(&[1, 2, 3]);
    let all = call("canvasSceneBin", json!({ "page": "p", "strokes": heads }), &data);
    assert_eq!(all["ok"], true, "{all}");
    assert_eq!(all["built"], 3, "{all}");
    let caps3 = all["capsules"].as_u64().unwrap();

    // Stroke 4 added: only it is sent and built; the scene is the one of all four.
    let (h4, d4) = full(&[4]);
    let heads = vec![json!({ "k": 1 }), json!({ "k": 2 }), json!({ "k": 3 }), h4[0].clone()];
    let more = call("canvasSceneBin", json!({ "page": "p", "strokes": heads }), &d4);
    assert_eq!(more["ok"], true, "{more}");
    assert_eq!(more["built"], 1, "{more}");
    let (hf, df) = full(&[1, 2, 3, 4]);
    let again = call("canvasSceneBin", json!({ "page": "q", "strokes": hf }), &df);
    assert_eq!(more["capsules"], again["capsules"], "the same scene as built from every stroke");
    assert!(more["capsules"].as_u64().unwrap() > caps3);
    call("canvasSceneBin", json!({ "page": "q", "strokes": [] }), &[]);

    // Stroke 2 erased: dropped from what the canvas holds, so its key alone is refused later.
    let less = call("canvasSceneBin", json!({ "page": "p", "strokes": [{ "k": 1 }, { "k": 3 }, { "k": 4 }] }), &[]);
    assert_eq!(less["built"], 0, "{less}");
    let refused = call("canvasSceneBin", json!({ "page": "p", "strokes": [{ "k": 1 }, { "k": 2 }] }), &[]);
    assert_eq!(refused["ok"], false, "{refused}");
    assert_eq!(refused["missing"], json!([2]), "{refused}");

    // The frame: white desk, the strokes at 1:1.
    let fr = call("canvasFrame", json!({ "clear": [1, 1, 1, 1], "pages": [{ "page": "p", "tf": [1, 0, 0, 1, 0, 0], "paper": null }] }), &[]);
    assert_eq!(fr["ok"], true, "{fr}");
    let ink = |host: *mut canvas::host::CanvasHost| {
        assert!(unsafe { opennote_canvas_host_draw(host) });
        let px = unsafe { (*host).pixels() };
        let dark = |x: u32, y: u32| px[((y * w + x) * 4) as usize] < 100;
        (dark(60, 50), dark(60, 70), dark(60, 90))
    };
    assert_eq!(ink(host), (true, false, true), "strokes 1 and 3 drawn, 2 erased");

    // The surface goes and comes back (a new host): the same picture, nothing resent.
    unsafe { opennote_canvas_host_free(host) };
    let host2 = unsafe { opennote_canvas_host_offscreen(w, h) };
    set_active_host(host2);
    assert_eq!(ink(host2), (true, false, true), "the new host draws the scene and frame it was given");

    // The note closed: its scene goes.
    let gone = call("canvasSceneBin", json!({ "page": "p", "strokes": [] }), &[]);
    assert_eq!(gone["ok"], true, "{gone}");
    let refused = call("canvasSceneBin", json!({ "page": "p", "strokes": [{ "k": 1 }] }), &[]);
    assert_eq!(refused["missing"], json!([1]), "{refused}");
    unsafe { opennote_canvas_host_free(host2) };
}
