//! Smart Pen reference: hold-to-snap and pure state machine against TypeScript.

use std::collections::BTreeSet;
use model::{NotePage, Point, ShapeKind, Stroke};
use serde_json::Value;
use shapes::{
    adjust_snapped_shape, erase_along_snapped_points, ShapeMode, SnapAdjust, SmartPen,
    SmartPenConfig, SmartPenTool,
};
use nib::geometry::XY;

const TOL: f64 = 1e-4;

fn ensure_reference_json() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../bench/rust-ref/smartpen.json");
    if !std::path::Path::new(path).exists() {
        let manifest_dir = env!("CARGO_MANIFEST_DIR");
        let root = std::path::Path::new(manifest_dir).join("../..");
        let status = std::process::Command::new("npm")
            .current_dir(&root)
            .args([
                "run",
                "bench:rustref",
                "--",
                "bench/rust-ref/smartpen.json",
                "--module",
                "smartpen",
            ])
            .status()
            .expect("failed to execute npm run bench:rustref");
        assert!(status.success(), "bench:rustref failed with status {status}");
    }
}

fn reference() -> Value {
    ensure_reference_json();
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../bench/rust-ref/smartpen.json");
    let text = std::fs::read_to_string(path)
        .unwrap_or_else(|_| panic!("{path} is missing: run bench:rustref to generate smartpen.json"));
    serde_json::from_str(&text).expect("smartpen.json is valid JSON")
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
fn smart_pen_reference_matches_typescript() {
    let refs = reference();
    let strokes = refs["strokes"].as_array().expect("strokes array");
    assert!(!strokes.is_empty(), "the reference has no strokes");

    let all_page_strokes: Vec<Stroke> = refs["pageStrokes"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .map(|s| serde_json::from_value(s.clone()).expect("valid page stroke"))
                .collect()
        })
        .unwrap_or_default();

    let mut failures = Vec::new();
    let mut differing_cases = BTreeSet::new();
    let mut snapped_count = 0;

    for r in strokes {
        let id = r["id"].as_str().unwrap_or("?");
        let tool_str = r["tool"].as_str().unwrap_or("pen");
        let samples = rows(&r["samples"]);
        let width = r["width"].as_f64().unwrap_or(2.0);

        let tool = match tool_str {
            "highlighter" => SmartPenTool::Highlighter,
            "eraser" => SmartPenTool::Eraser,
            "lasso" => SmartPenTool::Lasso,
            "shape" | "curve" => SmartPenTool::Shape(ShapeMode::Curve),
            _ => SmartPenTool::Pen,
        };

        let file_prefix = if let Some(idx) = id.find('#') {
            &id[..idx]
        } else {
            ""
        };
        let case_strokes: Vec<Stroke> = if file_prefix.is_empty() {
            all_page_strokes.clone()
        } else {
            all_page_strokes
                .iter()
                .filter(|s| !s.id.starts_with(file_prefix))
                .cloned()
                .collect()
        };
        let page = NotePage {
            id: format!("page_{file_prefix}"),
            page_number: 1,
            strokes: case_strokes,
            latex_blocks: Vec::new(),
            text_blocks: None,
            image_blocks: None,
        };

        let is_curve = matches!(tool, SmartPenTool::Shape(ShapeMode::Curve));

        if is_curve {
            // 1. Replay with 0.5s rest (500 ms) - must snap if shape detected!
            let mut pen50 = SmartPen::new(SmartPenConfig {
                tool,
                width,
                ..Default::default()
            });
            for s in &samples {
                pen50.add_sample(s[0], s[1], s[2], s[3]);
            }
            pen50.feed_rest(500.0, 20.0);

            let want50 = &r["rest500"];
            let want_snapped50 = want50["snapped"].as_bool().unwrap_or(false);
            if pen50.is_snapped() != want_snapped50 {
                differing_cases.insert(id.to_string());
                failures.push(format!("{id} (0.5s rest): is_snapped is {}, want {want_snapped50}", pen50.is_snapped()));
            }

            let want_sample50 = want50["sample"].as_u64().map(|v| v as usize);
            if pen50.snapped_sample() != want_sample50 {
                differing_cases.insert(id.to_string());
                failures.push(format!("{id} (0.5s rest): snapped_sample is {:?}, want {:?}", pen50.snapped_sample(), want_sample50));
            }

            if want_snapped50 {
                snapped_count += 1;
                let want_stroke = &want50["stroke"];
                if let Some(snapped_st) = pen50.snapped_stroke() {
                    let want_kind: ShapeKind = serde_json::from_value(want_stroke["kind"].clone())
                        .expect("valid ShapeKind in want_stroke");
                    if snapped_st.shape_kind != Some(want_kind) {
                        differing_cases.insert(id.to_string());
                        failures.push(format!("{id}: shape_kind is {:?}, want {:?}", snapped_st.shape_kind, Some(want_kind)));
                    }

                    let want_closed = want_stroke["closed"].as_bool().unwrap();
                    if snapped_st.closed != Some(want_closed) {
                        differing_cases.insert(id.to_string());
                        failures.push(format!("{id}: closed is {:?}, want {want_closed}", snapped_st.closed));
                    }

                    let want_w = want_stroke["width"].as_f64().unwrap();
                    if (snapped_st.width - want_w).abs() > TOL {
                        differing_cases.insert(id.to_string());
                        failures.push(format!("{id}: width is {}, want {want_w}", snapped_st.width));
                    }

                    let want_pts = want_stroke["points"].as_array().unwrap();
                    if snapped_st.points.len() != want_pts.len() {
                        differing_cases.insert(id.to_string());
                        failures.push(format!("{id}: points len is {}, want {}", snapped_st.points.len(), want_pts.len()));
                    } else {
                        for (i, (gp, wp)) in snapped_st.points.iter().zip(want_pts).enumerate() {
                            let w_xy = nums(wp);
                            if (gp.x - w_xy[0]).abs() > TOL || (gp.y - w_xy[1]).abs() > TOL {
                                differing_cases.insert(id.to_string());
                                failures.push(format!("{id}: point {i} is ({}, {}), want ({}, {})", gp.x, gp.y, w_xy[0], w_xy[1]));
                                break;
                            }
                        }
                    }
                } else {
                    differing_cases.insert(id.to_string());
                    failures.push(format!("{id} (0.5s rest): snapped_stroke is None, want some"));
                }
            }

            // 2. Replay with 0.3s rest (300 ms) - must NOT snap!
            let mut pen30 = SmartPen::new(SmartPenConfig {
                tool,
                width,
                ..Default::default()
            });
            for s in &samples {
                pen30.add_sample(s[0], s[1], s[2], s[3]);
            }
            pen30.feed_rest(300.0, 20.0);

            let want30 = &r["rest300"];
            let want_snapped30 = want30["snapped"].as_bool().unwrap_or(false);
            if pen30.is_snapped() != want_snapped30 {
                differing_cases.insert(id.to_string());
                failures.push(format!("{id} (0.3s rest): is_snapped is {}, want {want_snapped30}", pen30.is_snapped()));
            }
            let want_sample30 = want30["sample"].as_u64().map(|v| v as usize);
            if pen30.snapped_sample() != want_sample30 {
                differing_cases.insert(id.to_string());
                failures.push(format!("{id} (0.3s rest): snapped_sample is {:?}, want {:?}", pen30.snapped_sample(), want_sample30));
            }
        } else {
            // 1. Replay with 1.1s rest (1100 ms)
            let mut pen11 = SmartPen::new(SmartPenConfig {
                tool,
                width,
                ..Default::default()
            });
            for s in &samples {
                pen11.add_sample(s[0], s[1], s[2], s[3]);
            }
            pen11.feed_rest(1100.0, 20.0);

            let want11 = &r["rest1100"];
            let want_snapped11 = want11["snapped"].as_bool().unwrap_or(false);
            if pen11.is_snapped() != want_snapped11 {
                differing_cases.insert(id.to_string());
                failures.push(format!("{id} (1.1s rest): is_snapped is {}, want {want_snapped11}", pen11.is_snapped()));
            }

            let want_sample11 = want11["sample"].as_u64().map(|v| v as usize);
            if pen11.snapped_sample() != want_sample11 {
                differing_cases.insert(id.to_string());
                failures.push(format!("{id} (1.1s rest): snapped_sample is {:?}, want {:?}", pen11.snapped_sample(), want_sample11));
            }

            if want_snapped11 {
                snapped_count += 1;
                let want_stroke = &want11["stroke"];
                if let Some(snapped_st) = pen11.snapped_stroke() {
                    let want_kind: ShapeKind = serde_json::from_value(want_stroke["kind"].clone())
                        .expect("valid ShapeKind in want_stroke");
                    if snapped_st.shape_kind != Some(want_kind) {
                        differing_cases.insert(id.to_string());
                        failures.push(format!("{id}: shape_kind is {:?}, want {:?}", snapped_st.shape_kind, Some(want_kind)));
                    }

                    let want_closed = want_stroke["closed"].as_bool().unwrap();
                    if snapped_st.closed != Some(want_closed) {
                        differing_cases.insert(id.to_string());
                        failures.push(format!("{id}: closed is {:?}, want {want_closed}", snapped_st.closed));
                    }

                    let want_w = want_stroke["width"].as_f64().unwrap();
                    if (snapped_st.width - want_w).abs() > TOL {
                        differing_cases.insert(id.to_string());
                        failures.push(format!("{id}: width is {}, want {want_w}", snapped_st.width));
                    }

                    let want_pts = want_stroke["points"].as_array().unwrap();
                    if snapped_st.points.len() != want_pts.len() {
                        differing_cases.insert(id.to_string());
                        failures.push(format!("{id}: points len is {}, want {}", snapped_st.points.len(), want_pts.len()));
                    } else {
                        for (i, (gp, wp)) in snapped_st.points.iter().zip(want_pts).enumerate() {
                            let w_xy = nums(wp);
                            if (gp.x - w_xy[0]).abs() > TOL || (gp.y - w_xy[1]).abs() > TOL {
                                differing_cases.insert(id.to_string());
                                failures.push(format!("{id}: point {i} is ({}, {}), want ({}, {})", gp.x, gp.y, w_xy[0], w_xy[1]));
                                break;
                            }
                        }
                    }
                } else {
                    differing_cases.insert(id.to_string());
                    failures.push(format!("{id} (1.1s rest): snapped_stroke is None, want some"));
                }
            }

            if tool == SmartPenTool::Eraser {
                let (erased, put_back) = pen11.erase_along_snapped_on_page(&page);
                let want_erased: Vec<String> = want11["erased"]
                    .as_array()
                    .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
                    .unwrap_or_default();
                let want_put_back: Vec<String> = want11["putBack"]
                    .as_array()
                    .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
                    .unwrap_or_default();

                if erased != want_erased {
                    differing_cases.insert(id.to_string());
                    failures.push(format!("{id} (eraser erased): got {:?}, want {:?}", erased, want_erased));
                }
                if put_back != want_put_back {
                    differing_cases.insert(id.to_string());
                    failures.push(format!("{id} (eraser putBack): got {:?}, want {:?}", put_back, want_put_back));
                }
            }

            if tool == SmartPenTool::Lasso {
                let selected = pen11.lasso_select_on_page(&page);
                let want_selected: Vec<String> = want11["selectedIds"]
                    .as_array()
                    .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
                    .unwrap_or_default();

                if selected != want_selected {
                    differing_cases.insert(id.to_string());
                    failures.push(format!("{id} (lasso selectedIds): got {:?}, want {:?}", selected, want_selected));
                }
            }

            // 2. Replay with 0.3s rest (300 ms) - must NOT snap!
            let mut pen30 = SmartPen::new(SmartPenConfig {
                tool,
                width,
                ..Default::default()
            });
            for s in &samples {
                pen30.add_sample(s[0], s[1], s[2], s[3]);
            }
            pen30.feed_rest(300.0, 20.0);

            let want30 = &r["rest300"];
            let want_snapped30 = want30["snapped"].as_bool().unwrap_or(false);
            if pen30.is_snapped() != want_snapped30 {
                differing_cases.insert(id.to_string());
                failures.push(format!("{id} (0.3s rest): is_snapped is {}, want {want_snapped30}", pen30.is_snapped()));
            }
            let want_sample30 = want30["sample"].as_u64().map(|v| v as usize);
            if pen30.snapped_sample() != want_sample30 {
                differing_cases.insert(id.to_string());
                failures.push(format!("{id} (0.3s rest): snapped_sample is {:?}, want {:?}", pen30.snapped_sample(), want_sample30));
            }
        }
    }

    assert!(snapped_count > 0, "expected at least some strokes to snap");
    assert!(
        failures.is_empty(),
        "Differing case IDs ({}): {:?}\n{} differences:\n{}",
        differing_cases.len(),
        differing_cases,
        failures.len(),
        failures.join("\n")
    );
}

#[test]
fn test_regular_square_adjust() {
    let base = vec![
        Point { x: 100.0, y: 100.0, pressure: 0.5, t: None, alt: None, az: None },
        Point { x: 200.0, y: 100.0, pressure: 0.5, t: None, alt: None, az: None },
        Point { x: 200.0, y: 200.0, pressure: 0.5, t: None, alt: None, az: None },
        Point { x: 100.0, y: 200.0, pressure: 0.5, t: None, alt: None, az: None },
    ];
    let adj = SnapAdjust {
        kind: ShapeKind::Rectangle,
        base,
        closed: true,
        pen0: XY { x: 200.0, y: 200.0 },
        regular: true,
    };

    let adjusted = adjust_snapped_shape(&adj, XY { x: 250.0, y: 250.0 });
    assert_eq!(adjusted.len(), 4);

    let side0 = (adjusted[1].x - adjusted[0].x).hypot(adjusted[1].y - adjusted[0].y);
    let side1 = (adjusted[2].x - adjusted[1].x).hypot(adjusted[2].y - adjusted[1].y);
    let side2 = (adjusted[3].x - adjusted[2].x).hypot(adjusted[3].y - adjusted[2].y);
    let side3 = (adjusted[0].x - adjusted[3].x).hypot(adjusted[0].y - adjusted[3].y);

    assert!((side0 - side1).abs() < 1e-6, "square sides must be equal: {side0} vs {side1}");
    assert!((side1 - side2).abs() < 1e-6, "square sides must be equal: {side1} vs {side2}");
    assert!((side2 - side3).abs() < 1e-6, "square sides must be equal: {side2} vs {side3}");
}

#[test]
fn test_erase_along_snapped() {
    let pts = vec![
        Point { x: 0.0, y: 0.0, pressure: 0.5, t: None, alt: None, az: None },
        Point { x: 100.0, y: 0.0, pressure: 0.5, t: None, alt: None, az: None },
    ];
    let eraser_size = 16.0;
    let path = erase_along_snapped_points(&pts, false, eraser_size);
    assert!(path.len() >= 10);
    for i in 1..path.len() {
        let step = (path[i].x - path[i - 1].x).hypot(path[i].y - path[i - 1].y);
        assert!(step <= eraser_size * 0.5 + 1e-6);
    }
}

#[test]
fn test_smart_curve_threshold() {
    // Smart curve mode uses SHAPE_HOLD_MS = 450 ms
    let mut pen = SmartPen::new(SmartPenConfig {
        tool: SmartPenTool::Shape(ShapeMode::Curve),
        ..Default::default()
    });

    // Draw a straight line of 10 points over 100 ms
    for i in 0..10 {
        pen.add_sample(i as f64 * 10.0, 50.0, i as f64 * 10.0, 0.5);
    }

    // Rest 300 ms -> should NOT snap (300 < 450)
    pen.feed_rest(300.0, 20.0);
    assert!(!pen.is_snapped());

    // Rest another 200 ms (total 500 ms >= 450) -> should snap!
    pen.feed_rest(200.0, 20.0);
    assert!(pen.is_snapped());
}
