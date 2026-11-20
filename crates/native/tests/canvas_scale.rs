//! A note of 10,000 pages on the native canvas (rust/DECISIONS.md ADR-007, docs/rust-native-canvas.md
//! "Scale"): the frame comes compact (each sheet's box and paper, its ink the scene `note:sheet`),
//! a frame draws only the placements in view, the canvas names the pages near the view it does not
//! have (`missing`, in view first), a page entering the view shows its paper until its ink comes
//! and its time to ink is measured, and memory stays within the budgets: scenes leave the GPU
//! beyond its budget (never one in view) and the bridge lets go of scenes beyond its own, telling
//! the page (`dropped`) and asking for them again when they come near.
//! One test: the library's canvas state is global.
use opennote_native::canvas_service::{attach_offscreen, draw_active, offscreen_pixels};
use opennote_native::{call_framed, frame, unframe};
use serde_json::{json, Value};

fn call(method: &str, meta: Value, data: &[f64]) -> Value {
    let bytes: Vec<u8> = data.iter().flat_map(|v| v.to_le_bytes()).collect();
    let reply = call_framed(method, &frame(&meta.to_string(), &bytes));
    let (m, _) = unframe(&reply).unwrap();
    serde_json::from_str(m).unwrap()
}

const PAGES: usize = 10_000;
const PAGE_W: f64 = 816.0;
const PAGE_H: f64 = 1056.0;

/// Page `p`'s strokes: `n` pen lines down the page (surface px), keys from `p * 1000`.
fn page_strokes(p: usize, n: usize) -> (Vec<Value>, Vec<f64>) {
    let mut heads = Vec::new();
    let mut data = Vec::new();
    for i in 0..n {
        let y = p as f64 * PAGE_H + 80.0 + 30.0 * i as f64;
        let pts: Vec<f64> = (0..=40)
            .flat_map(|j| {
                [
                    60.0 + j as f64 * 16.0,
                    y + (j % 3) as f64,
                    0.5,
                    j as f64 * 8.0,
                ]
            })
            .collect();
        let s = json!({ "id": format!("s{p}_{i}"), "createdAt": i, "tool": "pen", "color": "#000000", "width": 3, "opacity": 1, "penStyle": "fountain", "lineStyle": "solid" });
        heads.push(json!({ "k": p * 1000 + i, "n": pts.len() / 4, "s": s }));
        data.extend(pts);
    }
    (heads, data)
}

fn send_page(p: usize, n: usize) -> Value {
    let (heads, data) = page_strokes(p, n);
    call(
        "canvasSceneBin",
        json!({ "page": format!("note:sh{p}"), "strokes": heads, "keep": true }),
        &data,
    )
}

/// The surface placed so that page `p`'s top is at the view's top (scale k, device px).
fn place_at(p: f64, k: f64) {
    let r = call(
        "canvasFrame",
        json!({ "surface": [k, 0.0, -p * PAGE_H * k], "keep": true }),
        &[],
    );
    assert_eq!(r["frame"], true, "{r}");
}

fn stats() -> Value {
    call("canvasStats", json!({}), &[])
}

fn ids(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_str().unwrap().to_string())
        .collect()
}

#[test]
fn a_long_note_costs_what_is_on_screen() {
    let (w, h) = (400u32, 600u32);
    assert!(attach_offscreen(w, h), "a GPU on the PC");
    let k = w as f64 / PAGE_W;
    let sheets: Vec<Value> = (0..PAGES)
        .map(|p| json!({ "id": format!("sh{p}"), "b": [0.0, p as f64 * PAGE_H, PAGE_W, PAGE_H], "p": 0 }))
        .collect();
    let r = call(
        "canvasFrame",
        json!({ "clear": [0.2, 0.2, 0.2, 1], "papers": [{ "style": 0, "base": [1, 1, 1, 1] }], "sheets": sheets, "ink": "note", "surface": [k, 0.0, 0.0] }),
        &[],
    );
    assert_eq!(r["ok"], true, "{r}");

    // Far down the note: nothing sent yet. The papers in view are drawn, the page names what it
    // misses, the page in view first.
    place_at(7_000.25, k);
    draw_active();
    let st = stats();
    let pg = &st["pages"];
    assert!(
        pg["drawn"].as_u64().unwrap() <= 4,
        "only what is in view is drawn: {pg}"
    );
    assert_eq!(pg["visibleMissing"], 2, "{pg}");
    let (missing, _) = opennote_native::canvas_service::missing();
    assert_eq!(
        &missing[..2],
        &["note:sh7000".to_string(), "note:sh7001".to_string()],
        "{missing:?}"
    );
    assert!(
        missing.len() >= 3 && missing.len() <= 8,
        "near pages, not the note: {missing:?}"
    );
    // The paper is drawn meanwhile (never black, never another page's ink).
    let px = offscreen_pixels();
    let c = (300 * w as usize + 200) * 4;
    assert!(
        px[c] > 240 && px[c + 1] > 240,
        "paper in view: {:?}",
        &px[c..c + 4]
    );

    // The page sends them: drawn, and their time to ink measured.
    for p in [7000, 7001, 6999, 7002] {
        let r = send_page(p, 12);
        assert_eq!(r["built"], 12, "{r}");
    }
    draw_active();
    let st = stats();
    let pg = &st["pages"];
    assert_eq!(pg["visibleMissing"], 0, "{pg}");
    assert!(pg["inkCompleteMs"].as_f64().unwrap() > 0.0, "{pg}");
    assert!(pg["inkWait"]["n"].as_u64().unwrap() >= 2, "{pg}");
    let caps_page = pg["drawnCapsules"].as_u64().unwrap();
    assert!(caps_page > 0, "{pg}");
    assert!(!opennote_native::canvas_service::missing()
        .0
        .contains(&"note:sh7000".to_string()));
    // A page without ink is sent known-empty: nothing asked for.
    call(
        "canvasSceneBin",
        json!({ "page": "note:sh7003", "strokes": [], "keep": true }),
        &[],
    );
    draw_active();
    assert!(!opennote_native::canvas_service::missing()
        .0
        .contains(&"note:sh7003".to_string()));

    // GPU memory: a budget of 1 MB and a fling through 300 pages, each page sent as it comes in
    // view. What is on the GPU stays near the budget (never what was flung through).
    call("canvasBudget", json!({ "gpuMB": 1, "cpuMB": 1000 }), &[]);
    let mut worst_gpu: f64 = 0.0;
    let mut sent = 0;
    for step in 0..300 {
        let p = 100 + step;
        place_at(p as f64, k);
        draw_active();
        for id in opennote_native::canvas_service::missing().0 {
            let n: usize = id.trim_start_matches("note:sh").parse().unwrap();
            send_page(n, 12);
            sent += 1;
        }
        draw_active();
        let pg = stats()["pages"].clone();
        worst_gpu = worst_gpu.max(pg["gpuMB"].as_f64().unwrap());
        assert_eq!(
            pg["visibleMissing"], 0,
            "every page in view inked at once: {pg}"
        );
    }
    let pg = stats()["pages"].clone();
    assert!(sent >= 300, "{sent}");
    assert!(
        worst_gpu <= 1.6,
        "GPU within its budget (and what is in view): {worst_gpu} MB, {pg}"
    );
    assert!(pg["evictions"].as_u64().unwrap() > 0, "{pg}");
    assert!(pg["resident"].as_u64().unwrap() < 40, "{pg}");

    // The bridge's memory: a budget of 0.5 MB lets go of the pages far behind, and says so.
    let r = call("canvasBudget", json!({ "gpuMB": 1, "cpuMB": 0.5 }), &[]);
    let mut dropped = ids(&r["dropped"]);
    let r = send_page(401, 12);
    dropped.extend(ids(&r["dropped"]));
    assert!(
        dropped.contains(&"note:sh100".to_string()),
        "the oldest went: {dropped:?}"
    );
    assert!(
        !dropped
            .iter()
            .any(|d| d == "note:sh399" || d == "note:sh400"),
        "never one near the view: {dropped:?}"
    );
    let pg = stats()["pages"].clone();
    // What is near the view stays whatever the budget (it is drawn now or next): only that is kept.
    assert!(pg["held"].as_u64().unwrap() <= 12, "{pg}");
    assert!(pg["strokesKept"].as_u64().unwrap() <= 12 * 12, "{pg}");
    // Back to a page that went: the canvas asks for it again.
    place_at(100.25, k);
    draw_active();
    assert_eq!(
        opennote_native::canvas_service::missing()
            .0
            .first()
            .map(String::as_str),
        Some("note:sh100")
    );

    // The note closed: its scenes go.
    call("canvasBudget", json!({}), &[]);
    let r = call("canvasForget", json!({ "prefix": "note" }), &[]);
    assert!(r["forgotten"].as_u64().unwrap() > 0, "{r}");
    draw_active();
    assert_eq!(stats()["scenes"], 0);
}
