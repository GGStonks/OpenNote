//! The Rust ink pipeline against the TypeScript app's own output, stroke by stroke.
//!
//! The reference is written by the TypeScript code (`npm run bench:rustref -- bench/rust-ref/ink.json`,
//! see the header of `bench/rustRef.ts`): real recorded pen strokes, and for each the points given
//! to the engine, the modelled line, the widths and the drawn line (`strokeGeometry`). Every stage
//! must match to 1e-4 page px, and so must the drawn line of the same stroke as other kinds of
//! stroke (`kinds`: ballpoint, highlighter, shape, stored modelled lines). Every stage
//! must match to 1e-4 page px (the file keeps 9 significant digits); a stroke that differs is
//! reported by stage and stroke id and the test fails.
//!
//! Not compared yet: the live line, the dash runs and the precision eraser (also in the file).

use ink::{engine_points, ink_widths, stroke_geometry, stroke_width};
use model::Stroke;
use nib::geometry::InkPoint;
use nib::nib::nib_stroke;
use serde_json::{json, Value};

const TOL: f64 = 1e-4;

fn reference() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../bench/rust-ref/ink.json");
    let text = std::fs::read_to_string(path)
        .unwrap_or_else(|_| panic!("{path} is missing: run `npm run bench:rustref -- bench/rust-ref/ink.json`"));
    serde_json::from_str(&text).expect("ink.json is JSON")
}

fn nums(v: &Value) -> Vec<f64> {
    v.as_array().map(|a| a.iter().map(|x| x.as_f64().unwrap_or(f64::NAN)).collect()).unwrap_or_default()
}

/// [x, y, t, pressure] rows.
fn rows(v: &Value) -> Vec<[f64; 4]> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|r| {
            let n = nums(r);
            [n[0], n[1], n[2], n[3]]
        })
        .collect()
}

/// The first difference beyond the tolerance (positions, widths, pressures absolute; times relative).
fn diff_rows(name: &str, got: &[[f64; 4]], want: &[[f64; 4]]) -> Option<String> {
    if got.len() != want.len() {
        return Some(format!("{name}: {} points, want {}", got.len(), want.len()));
    }
    for (i, (g, w)) in got.iter().zip(want).enumerate() {
        let t_tol = TOL.max(w[2].abs() * 1e-8);
        let bad = (g[0] - w[0]).abs() > TOL
            || (g[1] - w[1]).abs() > TOL
            || (g[2] - w[2]).abs() > t_tol
            || (g[3] - w[3]).abs() > TOL;
        if bad {
            return Some(format!("{name}: point {i} is {g:?}, want {w:?}"));
        }
    }
    None
}

fn diff_nums(name: &str, got: &[f64], want: &[f64]) -> Option<String> {
    if got.len() != want.len() {
        return Some(format!("{name}: {} values, want {}", got.len(), want.len()));
    }
    got.iter()
        .zip(want)
        .position(|(g, w)| (g - w).abs() > TOL)
        .map(|i| format!("{name}: value {i} is {}, want {}", got[i], want[i]))
}

fn geometry_diff(name: &str, g: &ink::InkGeometry, want: &Value) -> Vec<String> {
    let mut out = Vec::new();
    let g4: Vec<[f64; 4]> = g.pts.iter().map(|p| [p.x, p.y, p.t, p.p]).collect();
    out.extend(diff_rows(&format!("{name}.pts"), &g4, &rows(&want["pts"])));
    match (&g.widths, want["widths"].is_null()) {
        (Some(w), false) => out.extend(diff_nums(&format!("{name}.widths"), w, &nums(&want["widths"]))),
        (None, true) => {}
        (got, _) => out.push(format!("{name}.widths: present {}, want {}", got.is_some(), !want["widths"].is_null())),
    }
    out.extend(diff_nums(&format!("{name}.width"), &[g.width], &[want["width"].as_f64().unwrap()]));
    out
}

/// A reference stroke as another kind (`kinds.<name>.stroke`), its own points or the stroke's.
fn kind_of(base: &Value, k: &Value) -> Stroke {
    let src = if k["points"].is_null() { &base["points"] } else { &k["points"] };
    let points: Vec<Value> = rows(src).iter().map(|p| json!({ "x": p[0], "y": p[1], "t": p[2], "pressure": p[3] })).collect();
    let mut s = json!({ "id": "ref", "tool": k["tool"], "color": "#000", "width": base["width"], "opacity": 1, "lineStyle": "solid", "points": points });
    for (key, v) in [("penStyle", &k["penStyle"]), ("modeled", &k["modeled"])] {
        if !v.is_null() {
            s[key] = v.clone();
        }
    }
    if k["isShape"].as_bool() == Some(true) {
        s["isShape"] = json!(true);
    }
    if k["penEnd"].as_bool() == Some(true) {
        s["penEnd"] = json!(true);
    }
    serde_json::from_value(s).expect("a stroke")
}

fn stroke_of(r: &Value) -> Stroke {
    let points: Vec<Value> = rows(&r["points"])
        .iter()
        .map(|p| json!({ "x": p[0], "y": p[1], "t": p[2], "pressure": p[3] }))
        .collect();
    let mut s = json!({
        "id": "ref", "tool": "pen", "color": "#000", "width": r["width"], "opacity": 1,
        "penStyle": "fountain", "lineStyle": "solid", "points": points,
    });
    if r["penEndFlag"].as_bool() == Some(true) {
        s["penEnd"] = json!(true);
    }
    serde_json::from_value(s).expect("a stroke")
}

#[test]
fn ink_pipeline_matches_typescript() {
    let refs = reference();
    let strokes = refs["strokes"].as_array().expect("strokes");
    assert!(!strokes.is_empty(), "the reference has no strokes");
    let mut failures = Vec::new();
    for r in strokes {
        let id = r["id"].as_str().unwrap_or("?");
        let s = stroke_of(r);
        let mut fail = |msg: Option<String>| {
            if let Some(m) = msg {
                failures.push(format!("{id}: {m}"));
            }
        };

        let eng = engine_points(&s);
        let eng4: Vec<[f64; 4]> = eng.iter().map(|p| [p.x, p.y, p.t.unwrap_or(0.0), p.pressure]).collect();
        fail(diff_rows("enginePoints", &eng4, &rows(&r["enginePoints"])));

        let ink: Vec<InkPoint> = eng.iter().map(|p| InkPoint { x: p.x, y: p.y, pressure: p.pressure, t: p.t }).collect();
        let modeled = nib_stroke(&ink);
        let m4: Vec<[f64; 4]> = modeled.iter().map(|p| [p.x, p.y, p.t, p.p]).collect();
        fail(diff_rows("modeled", &m4, &rows(&r["modeled"])));

        if !r["widths"].is_null() {
            fail(diff_nums("widths", &ink_widths(&modeled, stroke_width(&s)), &nums(&r["widths"])));
        }

        for m in geometry_diff("geometry", &stroke_geometry(&s), &r["geometry"]) {
            fail(Some(m));
        }
        for (name, k) in r["kinds"].as_object().expect("kinds") {
            for m in geometry_diff(&format!("kinds.{name}"), &stroke_geometry(&kind_of(r, &k["stroke"])), &k["geometry"]) {
                fail(Some(m));
            }
        }
    }
    assert!(failures.is_empty(), "{} differences:\n{}", failures.len(), failures.join("\n"));
}

/// The densifier and the live line (SmoothLiveStroke, what the shells draw while the pen is down),
/// replayed from the recorded samples as bench/rustRef.ts does: the densified points, and the live
/// line at the stroke's middle sample and its last, to 1e-4 px.
#[test]
fn densify_and_live_line_match_typescript() {
    use ink::{SampleDensifier, SmoothLiveStroke};
    use model::Point;
    let refs = reference();
    let mut failures = Vec::new();
    let mut compared = 0;
    for r in refs["strokes"].as_array().unwrap() {
        let id = r["id"].as_str().unwrap_or("?");
        let real = r["realPressure"].as_bool().unwrap();
        let width = stroke_width(&stroke_of(r));
        let lives: Vec<&Value> = r["live"].as_array().unwrap().iter().collect();
        let mut dens = SampleDensifier::new();
        let mut live = SmoothLiveStroke::new();
        let mut points: Vec<[f64; 4]> = Vec::new();
        for (k, s) in r["samples"].as_array().unwrap().iter().enumerate() {
            let s = nums(s); // x, y, t, force
            let pt = Point { x: s[0], y: s[1], pressure: if s[3] > 0.0 { s[3] } else { 0.0 }, t: Some(s[2]), ..Default::default() };
            for q in dens.push(pt) {
                points.push([q.x, q.y, q.t.unwrap_or(s[2]), q.pressure]);
                live.add(q.x, q.y, q.t.unwrap_or(s[2]), if real { q.pressure } else { 0.5 });
            }
            for l in lives.iter().filter(|l| l["sample"].as_u64() == Some(k as u64)) {
                let line = live.line(width, l["variable"].as_bool().unwrap());
                let xy = |v: &[nib::geometry::ModeledPoint]| -> Vec<[f64; 4]> { v.iter().map(|p| [p.x, p.y, 0.0, 0.0]).collect() };
                let want_xy = |v: &Value| -> Vec<[f64; 4]> { v.as_array().unwrap().iter().map(|p| { let p = nums(p); [p[0], p[1], 0.0, 0.0] }).collect() };
                let tag = format!("live@{k}");
                failures.extend(diff_rows(&format!("{tag}.final"), &xy(&line.final_pts), &want_xy(&l["final"])).map(|m| format!("{id}: {m}")));
                failures.extend(diff_nums(&format!("{tag}.finalW"), &line.final_w, &nums(&l["finalW"])).map(|m| format!("{id}: {m}")));
                failures.extend(diff_rows(&format!("{tag}.rest"), &xy(&line.rest_pts), &want_xy(&l["rest"])).map(|m| format!("{id}: {m}")));
                failures.extend(diff_nums(&format!("{tag}.restW"), &line.rest_w, &nums(&l["restW"])).map(|m| format!("{id}: {m}")));
                compared += 1;
            }
        }
        // The reference's points end with the pen end (Stroke.penEnd) when the stroke has one.
        let mut want = rows(&r["points"]);
        if r["penEndFlag"].as_bool() == Some(true) {
            want.pop();
        }
        failures.extend(diff_rows("densified", &points, &want).map(|m| format!("{id}: {m}")));
    }
    assert!(compared >= 60, "only {compared} live lines compared");
    assert!(failures.is_empty(), "{} differences:\n{}", failures.len(), failures.join("\n"));
}
