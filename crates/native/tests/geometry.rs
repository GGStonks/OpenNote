//! `geometry` through the framed entry point, as the shells call it, against the TypeScript app's
//! own drawn lines (bench/rust-ref/ink.json, `npm run bench:rustref -- bench/rust-ref/ink.json`):
//! every reference stroke and its other kinds in one request, each line to 1e-4 px.

use opennote_native::{call_framed, frame, unframe};
use serde_json::{json, Value};

fn reference() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../bench/rust-ref/ink.json");
    let text = std::fs::read_to_string(path)
        .unwrap_or_else(|_| panic!("{path} is missing: run `npm run bench:rustref -- bench/rust-ref/ink.json`"));
    serde_json::from_str(&text).unwrap()
}

fn nums(v: &Value) -> Vec<f64> {
    v.as_array().unwrap().iter().map(|x| x.as_f64().unwrap()).collect()
}

#[test]
fn geometry_through_the_bridge_matches_typescript() {
    let refs = reference();
    let mut heads = Vec::new();
    let mut data: Vec<u8> = Vec::new();
    let mut want: Vec<&Value> = Vec::new();
    for r in refs["strokes"].as_array().unwrap() {
        let mut cases = vec![(json!({ "tool": "pen", "penStyle": "fountain", "isShape": false, "modeled": null, "penEnd": r["penEndFlag"] }), &r["points"], &r["geometry"])];
        for k in r["kinds"].as_object().unwrap().values() {
            let st = &k["stroke"];
            let pts = if st["points"].is_null() { &r["points"] } else { &st["points"] };
            cases.push((st.clone(), pts, &k["geometry"]));
        }
        for (st, pts, geo) in cases {
            let rows = pts.as_array().unwrap();
            for row in rows {
                let v = nums(row); // x, y, t, pressure
                for x in [v[0], v[1], v[3], v[2]] {
                    data.extend_from_slice(&x.to_le_bytes());
                }
            }
            heads.push(json!({ "tool": st["tool"], "penStyle": st["penStyle"], "isShape": st["isShape"], "modeled": st["modeled"], "penEnd": st["penEnd"], "width": r["width"], "n": rows.len() }));
            want.push(geo);
        }
    }
    let reply = call_framed("geometry", &frame(&json!({ "strokes": heads }).to_string(), &data));
    let (meta, out) = unframe(&reply).unwrap();
    let meta: Value = serde_json::from_str(meta).unwrap();
    assert!(meta["error"].is_null(), "error: {}", meta["error"]);
    let vals: Vec<f64> = out.chunks_exact(8).map(|c| f64::from_le_bytes(c.try_into().unwrap())).collect();
    let mut at = 0;
    let mut bad = Vec::new();
    for (i, (m, geo)) in meta["strokes"].as_array().unwrap().iter().zip(&want).enumerate() {
        let n = m["n"].as_u64().unwrap() as usize;
        let rows = geo["pts"].as_array().unwrap();
        if n != rows.len() {
            bad.push(format!("line {i}: {n} points, want {}", rows.len()));
        }
        for (k, row) in rows.iter().enumerate().take(n) {
            let w = nums(row); // x, y, t, pressure
            let g = &vals[at + k * 4..at + k * 4 + 4]; // x, y, t, p
            if (g[0] - w[0]).abs() > 1e-4 || (g[1] - w[1]).abs() > 1e-4 || (g[3] - w[3]).abs() > 1e-4 {
                bad.push(format!("line {i} point {k}: {g:?}, want {w:?}"));
                break;
            }
        }
        at += n * 4;
        if m["widths"].as_bool().unwrap() {
            let ws = nums(&geo["widths"]);
            if vals[at..at + n].iter().zip(&ws).any(|(g, w)| (g - w).abs() > 1e-4) {
                bad.push(format!("line {i}: widths differ"));
            }
            at += n;
        } else if !geo["widths"].is_null() {
            bad.push(format!("line {i}: no widths"));
        }
        if (m["width"].as_f64().unwrap() - geo["width"].as_f64().unwrap()).abs() > 1e-4 {
            bad.push(format!("line {i}: width differs"));
        }
    }
    assert_eq!(at, vals.len(), "data left over");
    assert!(want.len() > 200, "only {} lines", want.len());
    assert!(bad.is_empty(), "{} differences:\n{}", bad.len(), bad.join("\n"));
    println!("{} lines, Rust {:.1} ms", want.len(), meta["ms"].as_f64().unwrap());
}

#[test]
fn bad_requests_come_back_as_errors() {
    for (method, req) in [("geometry", frame("{", &[])), ("nope", frame("{}", &[])), ("geometry", vec![1, 0])] {
        let reply = call_framed(method, &req);
        let (meta, _) = unframe(&reply).unwrap();
        let meta: Value = serde_json::from_str(meta).unwrap();
        assert!(meta["error"].is_string(), "{method}: {meta}");
    }
}
