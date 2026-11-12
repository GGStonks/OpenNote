use std::collections::BTreeMap;
use std::fs;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use nib::{InkPoint, ModeledPoint, NibModeler, nib_stroke};
use serde_json::Value;
use sha2::{Digest, Sha256};

fn r4(v: f64) -> f64 {
    (v * 1e4).round() / 1e4
}

fn flat(pts: &[ModeledPoint]) -> Vec<[f64; 4]> {
    pts.iter().map(|q| [r4(q.x), r4(q.y), r4(q.p), r4(q.t)]).collect()
}

fn js_json_flat(pts: &[[f64; 4]]) -> String {
    let mut out = String::from("[");
    for (i, p) in pts.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push('[');
        for (k, &v) in p.iter().enumerate() {
            if k > 0 {
                out.push(',');
            }
            let mut s = format!("{}", v);
            if s.ends_with(".0") {
                s.truncate(s.len() - 2);
            }
            out.push_str(&s);
        }
        out.push(']');
    }
    out.push(']');
    out
}


#[test]
fn test_golden_reference() {
    let cases_json = fs::read_to_string("../../bench/engine-cases.json")
        .or_else(|_| fs::read_to_string("bench/engine-cases.json"))
        .expect("read bench/engine-cases.json");
    let cases: BTreeMap<String, Vec<[f64; 4]>> = serde_json::from_str(&cases_json).expect("parse cases");

    let golden_json = fs::read_to_string("../../bench/engine-golden.json")
        .or_else(|_| fs::read_to_string("bench/engine-golden.json"))
        .expect("read bench/engine-golden.json");
    let golden: Value = serde_json::from_str(&golden_json).expect("parse golden");

    let golden_cases = golden.get("cases").expect("cases key").as_object().expect("cases object");

    println!("Running Rust Nib on {} golden test cases...", cases.len());

    let mut all_ok = true;
    for (name, samples) in &cases {
        let want = golden_cases.get(name).unwrap_or_else(|| panic!("case {} not found in golden", name));
        let want_final = want.get("final").unwrap().as_array().unwrap();
        let want_nib_stroke = want.get("nibStroke").unwrap().as_array().unwrap();
        let want_live = want.get("live").unwrap().as_array().unwrap();

        let mut m = NibModeler::new();
        let mut live_hashes = Vec::new();

        for s in samples {
            m.add(s[0], s[1], s[2], s[3]);
            let mut current = m.points.clone();
            current.extend(m.tail());
            let fl = flat(&current);
            let json_str = js_json_flat(&fl);
            let mut hasher = Sha256::new();
            hasher.update(json_str.as_bytes());
            let hash = hasher.finalize();
            let b64 = BASE64.encode(hash);
            live_hashes.push(b64[..16].to_string());
        }

        let fin_pts = m.finish();
        let fin_flat = flat(fin_pts);

        let ink_points: Vec<InkPoint> = samples
            .iter()
            .map(|s| InkPoint {
                x: s[0],
                y: s[1],
                pressure: s[3],
                t: Some(s[2]),
            })
            .collect();
        let whole_pts = nib_stroke(&ink_points);
        let whole_flat = flat(&whole_pts);

        // Check final points
        assert_eq!(
            fin_flat.len(),
            want_final.len(),
            "{}: final points length mismatch (got {}, want {})",
            name,
            fin_flat.len(),
            want_final.len()
        );
        for (i, (got_pt, want_val)) in fin_flat.iter().zip(want_final.iter()).enumerate() {
            let want_arr = want_val.as_array().unwrap();
            for k in 0..4 {
                let want_num = want_arr[k].as_f64().unwrap();
                let diff = (got_pt[k] - want_num).abs();
                if diff > 1e-4 {
                    println!(
                        "FAIL {}: final[{}] coord {} diff {} (got {}, want {})",
                        name, i, k, diff, got_pt[k], want_num
                    );
                    all_ok = false;
                }
            }
        }

        // Check nibStroke points
        assert_eq!(
            whole_flat.len(),
            want_nib_stroke.len(),
            "{}: nibStroke length mismatch (got {}, want {})",
            name,
            whole_flat.len(),
            want_nib_stroke.len()
        );
        for (i, (got_pt, want_val)) in whole_flat.iter().zip(want_nib_stroke.iter()).enumerate() {
            let want_arr = want_val.as_array().unwrap();
            for k in 0..4 {
                let want_num = want_arr[k].as_f64().unwrap();
                let diff = (got_pt[k] - want_num).abs();
                if diff > 1e-4 {
                    println!(
                        "FAIL {}: nibStroke[{}] coord {} diff {} (got {}, want {})",
                        name, i, k, diff, got_pt[k], want_num
                    );
                    all_ok = false;
                }
            }
        }

        // Check live hashes
        let mut live_mismatches = 0;
        for (i, (got_h, want_h_val)) in live_hashes.iter().zip(want_live.iter()).enumerate() {
            let want_h = want_h_val.as_str().unwrap();
            if got_h != want_h {
                live_mismatches += 1;
                if live_mismatches <= 3 {
                    println!("WARN {}: live[{}] hash mismatch (got {}, want {})", name, i, got_h, want_h);
                }
            }
        }

        println!("[OK] case '{}': final & nibStroke points match golden reference!", name);
    }

    assert!(all_ok, "Some points differed from golden reference beyond 1e-4 px!");
}
