//! Native live ink (live.rs) fed the reference strokes' samples as a shell would send them: the
//! line must be the TypeScript app's live line (bench/rust-ref/ink.json, `live`) at the stroke's
//! middle and last sample, to 1e-4 px. Identity placement (page px = view px), so this checks the
//! session's own steps (time, pressure, first sample, densifier, model, the update's split into
//! settled and rest); crates/ink/tests/reference.rs checks the model itself.
use opennote_native::{opennote_live_add, opennote_live_free, opennote_live_new, opennote_live_update};
use serde_json::Value;

#[test]
fn live_session_draws_the_typescript_live_line() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../bench/rust-ref/ink.json");
    let refs: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("run npm run bench:rustref -- bench/rust-ref/ink.json")).unwrap();
    let nums = |v: &Value| -> Vec<f64> { v.as_array().unwrap().iter().map(|x| x.as_f64().unwrap()).collect() };
    let (mut compared, mut bad) = (0, Vec::new());
    for r in refs["strokes"].as_array().unwrap() {
        if !r["realPressure"].as_bool().unwrap() {
            continue; // shells only send the Pencil's force
        }
        let samples: Vec<Vec<f64>> = r["samples"].as_array().unwrap().iter().map(|s| nums(s)).collect();
        let width = r["width"].as_f64().unwrap() * 1.4; // strokeWidth: the fountain pen
        let t0 = samples[0][2];
        // Shell time in s with offset 0: page time t (ms) = t_s * 1000; start = the first sample's.
        let params = [0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 0.0, (t0 / 1000.0) * 1000.0, 0.0, 0.0, 1.0, width, 1.0];
        let h = unsafe { opennote_live_new(params.as_ptr(), params.len()) };
        let mut line: Vec<[f64; 3]> = Vec::new();
        for (k, s) in samples.iter().enumerate() {
            assert!(unsafe { opennote_live_add(h, s[0], s[1], s[3], s[2] / 1000.0) });
            let (mut fresh, mut n) = (0usize, 0usize);
            let p = unsafe { opennote_live_update(h, &mut fresh, &mut n) };
            let pts = unsafe { std::slice::from_raw_parts(p, n * 3) };
            // The shell keeps settled points and replaces the rest, as for a `u` message.
            let settled = line.len() - line.iter().rev().take_while(|q| q[2] < 0.0).count();
            line.truncate(settled);
            line.extend(pts.chunks(3).take(fresh).map(|c| [c[0], c[1], c[2]]));
            line.extend(pts.chunks(3).skip(fresh).map(|c| [c[0], c[1], -c[2]]));
            for l in r["live"].as_array().unwrap().iter().filter(|l| l["sample"].as_u64() == Some(k as u64)) {
                let want: Vec<(f64, f64, f64)> = ["final", "rest"].iter().flat_map(|key| {
                    let w = nums(&l[format!("{key}W")]);
                    l[*key].as_array().unwrap().iter().zip(w).map(|(p, w)| { let p = nums(p); (p[0], p[1], w / 2.0) }).collect::<Vec<_>>()
                }).collect();
                let got: Vec<(f64, f64, f64)> = line.iter().map(|q| (q[0], q[1], q[2].abs())).collect();
                compared += 1;
                if got.len() != want.len() {
                    bad.push(format!("{} @{k}: {} points, want {}", r["id"], got.len(), want.len()));
                } else if let Some(i) = got.iter().zip(&want).position(|(g, w)| (g.0 - w.0).abs() > 1e-4 || (g.1 - w.1).abs() > 1e-4 || (g.2 - w.2).abs() > 1e-4) {
                    bad.push(format!("{} @{k}: point {i} {:?}, want {:?}", r["id"], got[i], want[i]));
                }
            }
        }
        unsafe { opennote_live_free(h) };
    }
    assert!(compared >= 40, "only {compared} lines compared");
    assert!(bad.is_empty(), "{} differences:\n{}", bad.len(), bad.join("\n"));
    println!("{compared} live lines match");
}
