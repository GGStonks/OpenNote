//! Shapes reference: recognition and snapping against TypeScript.

use model::{LineStyle, Point, ShapeKind, Stroke};
use serde_json::Value;
use shapes::{detect_shape, snap_stroke};

const TOL: f64 = 1e-4;

fn ensure_reference_json() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../bench/rust-ref/shapes.json"
    );
    if !std::path::Path::new(path).exists() {
        let manifest_dir = env!("CARGO_MANIFEST_DIR");
        let root = std::path::Path::new(manifest_dir).join("../..");
        let status = std::process::Command::new("npx")
            .current_dir(&root)
            .args([
                "esbuild",
                "bench/rustRef.ts",
                "--bundle",
                "--platform=node",
                "--format=esm",
                "--loader:.ttf=empty",
                "--loader:.woff=empty",
                "--loader:.woff2=empty",
                "--log-level=error",
                "--outfile=node_modules/.cache/rust-ref.mjs",
            ])
            .status()
            .expect("failed to execute esbuild");
        assert!(status.success(), "esbuild failed with status {status}");

        let status2 = std::process::Command::new("node")
            .current_dir(&root)
            .args([
                "node_modules/.cache/rust-ref.mjs",
                "bench/rust-ref/shapes.json",
                "--module",
                "shapes",
            ])
            .status()
            .expect("failed to execute node");
        assert!(status2.success(), "node failed with status {status2}");
    }
}

fn reference() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../bench/rust-ref/shapes.json"
    );
    let shapes_ts = concat!(env!("CARGO_MANIFEST_DIR"), "/../../bench/rustref/shapes.ts");
    let needs_regen = match (std::fs::metadata(path), std::fs::metadata(shapes_ts)) {
        (Ok(meta_json), Ok(meta_ts)) => {
            meta_json
                .modified()
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
                < meta_ts
                    .modified()
                    .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
        }
        _ => true,
    };
    if needs_regen {
        let _ = std::fs::remove_file(path);
    }
    ensure_reference_json();
    let text = std::fs::read_to_string(path)
        .unwrap_or_else(|_| panic!("{path} is missing: run bench:rustref to generate shapes.json"));
    serde_json::from_str(&text).expect("shapes.json is JSON")
}

fn nums(v: &Value) -> Vec<f64> {
    v.as_array()
        .map(|a| a.iter().map(|x| x.as_f64().unwrap_or(f64::NAN)).collect())
        .unwrap_or_default()
}

fn rows(v: &Value) -> Vec<[f64; 4]> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|r| {
            let n = nums(r);
            [
                n[0],
                n[1],
                if n.len() > 2 { n[2] } else { 0.0 },
                if n.len() > 3 { n[3] } else { 0.5 },
            ]
        })
        .collect()
}

#[test]
fn shapes_reference_matches_typescript() {
    let refs = reference();
    let strokes = refs["strokes"].as_array().expect("strokes array");
    assert!(!strokes.is_empty(), "the reference has no strokes");
    let mut failures = Vec::new();

    for r in strokes {
        let id = r["id"].as_str().unwrap_or("?");
        let pts4 = rows(&r["points"]);
        let points: Vec<Point> = pts4
            .iter()
            .map(|p| Point {
                x: p[0],
                y: p[1],
                t: Some(p[2]),
                pressure: p[3],
                ..Default::default()
            })
            .collect();

        let width = r["width"].as_f64().unwrap();
        let stroke = Stroke {
            id: id.to_string(),
            tool: "pen".to_string(),
            color: "#000".to_string(),
            width,
            opacity: 1.0,
            line_style: Some(LineStyle::Solid),
            points: points.clone(),
            ..Default::default()
        };

        let snapped = snap_stroke(&stroke);
        let detected = detect_shape(&points);

        // Check regularPolygon decision
        let got_regular = detected.as_ref().and_then(|d| d.regular).unwrap_or(false);
        let want_regular = r["regularPolygon"].as_bool().unwrap_or(false);
        if got_regular != want_regular {
            failures.push(format!(
                "{id}: regularPolygon is {got_regular}, want {want_regular}"
            ));
        }

        // Check detectParabola decision
        let got_parabola = detected
            .as_ref()
            .is_some_and(|d| d.kind == ShapeKind::Curve);
        let want_parabola = r["detectParabola"].as_bool().unwrap_or(false);
        if got_parabola != want_parabola {
            failures.push(format!(
                "{id}: detectParabola is {got_parabola}, want {want_parabola}"
            ));
        }

        // Check snapStroke result
        let want_snap = &r["snap"];
        if want_snap.is_null() {
            if snapped.is_shape == Some(true) {
                failures.push(format!(
                    "{id}: snapped to {:?}, want null",
                    snapped.shape_kind
                ));
            }
        } else {
            if snapped.is_shape != Some(true) {
                failures.push(format!("{id}: snap is null, want {:?}", want_snap["kind"]));
            } else {
                let got_kind = snapped.shape_kind.expect("shape_kind");
                let want_kind: ShapeKind = serde_json::from_value(want_snap["kind"].clone())
                    .expect("valid ShapeKind in want_snap");
                if got_kind != want_kind {
                    failures.push(format!(
                        "{id}: snap kind is {got_kind:?}, want {want_kind:?}"
                    ));
                }

                let want_width = want_snap["width"].as_f64().unwrap();
                if (snapped.width - want_width).abs() > TOL {
                    failures.push(format!(
                        "{id}: snap width is {}, want {}",
                        snapped.width, want_width
                    ));
                }

                let want_pts = want_snap["points"].as_array().unwrap();
                if snapped.points.len() != want_pts.len() {
                    failures.push(format!(
                        "{id}: snap points count is {}, want {}",
                        snapped.points.len(),
                        want_pts.len()
                    ));
                } else {
                    for (i, (gp, wp)) in snapped.points.iter().zip(want_pts).enumerate() {
                        let w_xy = nums(wp);
                        if (gp.x - w_xy[0]).abs() > TOL || (gp.y - w_xy[1]).abs() > TOL {
                            failures.push(format!(
                                "{id}: snap point {i} is ({}, {}), want ({}, {})",
                                gp.x, gp.y, w_xy[0], w_xy[1]
                            ));
                            break;
                        }
                    }
                }
            }
        }
    }

    assert!(
        failures.is_empty(),
        "{} differences:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
