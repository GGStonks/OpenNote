//! `canvasSceneBin` as rustCore.ts sends it: each stroke's points once, then its key alone. A new
//! stroke on a long note must cost its own geometry (`built`), the scene must equal one built from
//! every stroke, a key the canvas does not hold is answered `missing`, and a host made later
//! (Android, back from the background) shows the scene and the frame without the page resending.
//! One test: the library's canvas state is global.
use opennote_native::canvas_service::{attach_offscreen, detach, draw_active, offscreen_pixels};
use opennote_native::{call_framed, frame, unframe};
use serde_json::{json, Value};
use std::sync::Mutex;

static TEST_LOCK: Mutex<()> = Mutex::new(());

fn call(method: &str, meta: Value, data: &[f64]) -> Value {
    let bytes: Vec<u8> = data.iter().flat_map(|v| v.to_le_bytes()).collect();
    let reply = call_framed(method, &frame(&meta.to_string(), &bytes));
    let (m, _) = unframe(&reply).unwrap();
    serde_json::from_str(m).unwrap()
}

/// Stroke `i`: a horizontal pen line at y = 30 + 20 i (page px), 21 points of x, y, pressure, t.
fn stroke(i: usize) -> (Value, Vec<f64>) {
    let y = 30.0 + 20.0 * i as f64;
    let pts: Vec<f64> = (0..=20)
        .flat_map(|j| [20.0 + j as f64 * 5.0, y, 0.5, j as f64 * 8.0])
        .collect();
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
    let _guard = TEST_LOCK.lock().unwrap();
    let (w, h) = (200u32, 200u32);
    assert!(attach_offscreen(w, h), "a GPU on the PC");

    let (heads, data) = full(&[1, 2, 3]);
    let all = call(
        "canvasSceneBin",
        json!({ "page": "p", "strokes": heads }),
        &data,
    );
    assert_eq!(all["ok"], true, "{all}");
    assert_eq!(all["built"], 3, "{all}");
    let caps3 = all["capsules"].as_u64().unwrap();

    // Stroke 4 added: only it is sent and built; the scene is the one of all four.
    let (h4, d4) = full(&[4]);
    let heads = vec![
        json!({ "k": 1 }),
        json!({ "k": 2 }),
        json!({ "k": 3 }),
        h4[0].clone(),
    ];
    let more = call(
        "canvasSceneBin",
        json!({ "page": "p", "strokes": heads }),
        &d4,
    );
    assert_eq!(more["ok"], true, "{more}");
    assert_eq!(more["built"], 1, "{more}");
    let (hf, df) = full(&[1, 2, 3, 4]);
    let again = call("canvasSceneBin", json!({ "page": "q", "strokes": hf }), &df);
    assert_eq!(
        more["capsules"], again["capsules"],
        "the same scene as built from every stroke"
    );
    assert!(more["capsules"].as_u64().unwrap() > caps3);
    call("canvasSceneBin", json!({ "page": "q", "strokes": [] }), &[]);

    // Stroke 2 erased: dropped from what the canvas holds, so its key alone is refused later.
    let less = call(
        "canvasSceneBin",
        json!({ "page": "p", "strokes": [{ "k": 1 }, { "k": 3 }, { "k": 4 }] }),
        &[],
    );
    assert_eq!(less["built"], 0, "{less}");
    let refused = call(
        "canvasSceneBin",
        json!({ "page": "p", "strokes": [{ "k": 1 }, { "k": 2 }] }),
        &[],
    );
    assert_eq!(refused["ok"], false, "{refused}");
    assert_eq!(refused["missing"], json!([2]), "{refused}");

    // The frame: white desk, the strokes at 1:1.
    let fr = call(
        "canvasFrame",
        json!({ "clear": [1, 1, 1, 1], "pages": [{ "page": "p", "tf": [1, 0, 0, 1, 0, 0], "paper": null }] }),
        &[],
    );
    assert_eq!(fr["ok"], true, "{fr}");
    let ink = || {
        assert!(draw_active());
        let px = offscreen_pixels();
        let dark = |x: u32, y: u32| px[((y * w + x) * 4) as usize] < 100;
        (dark(60, 50), dark(60, 70), dark(60, 90))
    };
    assert_eq!(
        ink(),
        (true, false, true),
        "strokes 1 and 3 drawn, 2 erased"
    );

    // The surface goes and comes back (a new host): the same picture, nothing resent.
    detach();
    assert!(attach_offscreen(w, h));
    assert_eq!(
        ink(),
        (true, false, true),
        "the new host draws the scene and frame it was given"
    );

    // The note closed: its scene goes.
    let gone = call("canvasSceneBin", json!({ "page": "p", "strokes": [] }), &[]);
    assert_eq!(gone["ok"], true, "{gone}");
    let refused = call(
        "canvasSceneBin",
        json!({ "page": "p", "strokes": [{ "k": 1 }] }),
        &[],
    );
    assert_eq!(refused["missing"], json!([1]), "{refused}");
    detach();
}

#[test]
fn erase_whole_and_precision_scene_bin() {
    let _guard = TEST_LOCK.lock().unwrap();
    let (w, h) = (200u32, 200u32);
    assert!(attach_offscreen(w, h), "offscreen GPU");

    // 1. Initial 4 strokes
    let (heads, data) = full(&[10, 20, 30, 40]);
    let r1 = call(
        "canvasSceneBin",
        json!({ "page": "erase_page", "strokes": heads, "keep": true }),
        &data,
    );
    assert_eq!(r1["ok"], true, "{r1}");
    assert_eq!(r1["built"], 4, "{r1}");
    let caps_all = r1["capsules"].as_u64().unwrap();
    assert!(caps_all > 0);

    // 2. Whole-stroke erase: remove stroke 20 (keep 10, 30, 40)
    let r2 = call(
        "canvasSceneBin",
        json!({
            "page": "erase_page",
            "strokes": [
                { "k": 10 },
                { "k": 30 },
                { "k": 40 },
            ],
            "keep": true,
        }),
        &[],
    );
    assert_eq!(r2["ok"], true, "{r2}");
    assert_eq!(r2["built"], 0, "no new strokes built, reused held ops");
    let caps_erased = r2["capsules"].as_u64().unwrap();
    assert!(caps_erased < caps_all, "capsules shrank after whole-stroke erase");

    // 3. Precision erase: stroke 30 is cut into 2 split pieces (keys 31 and 32)
    let (s31, pts31) = stroke(31);
    let (s32, pts32) = stroke(32);
    let mut split_data = pts31;
    let n31 = split_data.len() / 4;
    let n32 = pts32.len() / 4;
    split_data.extend(pts32);
    let r3 = call(
        "canvasSceneBin",
        json!({
            "page": "erase_page",
            "strokes": [
                { "k": 10 },
                { "k": 31, "n": n31, "s": s31 },
                { "k": 32, "n": n32, "s": s32 },
                { "k": 40 },
            ],
            "keep": true,
        }),
        &split_data,
    );
    assert_eq!(r3["ok"], true, "{r3}");
    assert_eq!(r3["built"], 2, "built the 2 precision-split stroke pieces");

    // 4. Erase all strokes: page becomes empty with keep: true
    let r4 = call(
        "canvasSceneBin",
        json!({ "page": "erase_page", "strokes": [], "keep": true }),
        &[],
    );
    assert_eq!(r4["ok"], true, "{r4}");
    assert_eq!(r4["capsules"], 0, "all capsules cleared on empty scene");
    detach();
}
