use ink::{
    dist_to_polyline, erase_strokes_partial, stroke_geometry, SampleDensifier,
};
use model::{LineStyle, PenStyle, Point, Stroke};
use nib::geometry::XY;
use serde_json::Value;
use std::f64::consts::PI;
use std::fs;
use std::path::Path;

struct RecordedStroke {
    samples: Vec<[f64; 7]>,
    width: f64,
    source: Option<String>,
}

fn load_recordings() -> Vec<(String, Vec<RecordedStroke>)> {
    let dir = Path::new("../../bench/recordings");
    let dir = if dir.exists() {
        dir
    } else {
        Path::new("bench/recordings")
    };

    let mut entries: Vec<_> = fs::read_dir(dir)
        .expect("bench/recordings should exist")
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("json"))
        // The four October 2026 recordings (292 pen strokes) the expected numbers below were
        // measured on with the TypeScript benches: later recordings change the totals.
        .filter(|e| e.file_name().to_str().is_some_and(|n| n.starts_with("pen-202610")))
        .collect();
    entries.sort_by_key(|e| e.path());

    let mut out = Vec::new();
    for entry in entries {
        let content = fs::read_to_string(entry.path()).expect("read recording file");
        let val: Value = serde_json::from_str(&content).expect("parse json");
        let mut strokes = Vec::new();
        if let Some(arr) = val.get("strokes").and_then(|s| s.as_array()) {
            for s in arr {
                let tool = s.get("tool").and_then(|t| t.as_str()).unwrap_or("pen");
                if tool != "pen" {
                    continue;
                }
                let width = s.get("width").and_then(|w| w.as_f64()).unwrap_or(1.5);
                let source = s
                    .get("source")
                    .and_then(|src| src.as_str())
                    .map(|s| s.to_string());
                let mut samples = Vec::new();
                if let Some(sam_arr) = s.get("samples").and_then(|s| s.as_array()) {
                    for row in sam_arr {
                        let r = row.as_array().unwrap();
                        let x = r[0].as_f64().unwrap();
                        let y = r[1].as_f64().unwrap();
                        let t = r[2].as_f64().unwrap();
                        let p = r[3].as_f64().unwrap();
                        let id = if r.len() > 4 {
                            r[4].as_f64().unwrap()
                        } else {
                            0.0
                        };
                        let alt = if r.len() > 5 {
                            r[5].as_f64().unwrap()
                        } else {
                            0.0
                        };
                        let az = if r.len() > 6 {
                            r[6].as_f64().unwrap()
                        } else {
                            0.0
                        };
                        samples.push([x, y, t, p, id, alt, az]);
                    }
                }
                strokes.push(RecordedStroke {
                    samples,
                    width,
                    source,
                });
            }
        }
        let fname = entry.file_name().to_string_lossy().to_string();
        out.push((fname, strokes));
    }
    out
}

#[test]
fn test_bench_overshoot() {
    let recs = load_recordings();
    let mut over = Vec::new();
    let mut n05 = 0;
    let mut n1 = 0;
    let mut n2 = 0;
    let mut total = 0;

    for (_file, strokes) in &recs {
        for s in strokes {
            let mut pts: Vec<Point> = Vec::new();
            let mut dens = SampleDensifier::new();
            for sample in &s.samples {
                let pt = Point {
                    x: sample[0],
                    y: sample[1],
                    pressure: if sample[3] > 0.0 { sample[3] } else { 0.0 },
                    t: Some(sample[2]),
                    alt: Some(sample[5]),
                    az: Some(sample[6]),
                };
                for q in dens.push(pt) {
                    pts.push(q);
                }
            }
            if pts.len() < 3 {
                continue;
            }
            let stroke = Stroke {
                id: "x".to_string(),
                tool: "pen".to_string(),
                color: "#000".to_string(),
                width: s.width,
                opacity: 1.0,
                points: pts,
                line_style: Some(LineStyle::Solid),
                pen_style: Some(PenStyle::Fountain),
                is_shape: None,
                closed: None,
                shape_kind: None,
                fill: None,
                fill_color: None,
                fill_opacity: None,
                arrow: None,
                modeled: None,
                pen_end: None,
                rotation: None,
                created_at: Some(0.0),
                highlight_alpha: None,
                dash_offset: None,
                fill_only: None,
            };
            let g = stroke_geometry(&stroke);
            let raw: Vec<XY> = s
                .samples
                .iter()
                .filter(|q| q[3] > 0.0)
                .map(|q| XY { x: q[0], y: q[1] })
                .collect();
            if raw.len() < 2 {
                continue;
            }

            let mut m = 0.0f64;
            for q in &g.pts {
                let (d, _) = dist_to_polyline(XY { x: q.x, y: q.y }, &raw);
                if d > m {
                    m = d;
                }
            }
            total += 1;
            if m > 0.5 {
                n05 += 1;
            }
            if m > 1.0 {
                n1 += 1;
            }
            if m > 2.0 {
                n2 += 1;
            }
            over.push(m);
        }
    }

    over.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median = over[over.len() / 2];
    let p95 = over[(over.len() as f64 * 0.95) as usize];
    let worst = *over.last().unwrap();

    println!(
        "densified: {} strokes | ink farther than 0.5/1/2 px: {}/{}/{} | median {:.2} px, p95 {:.2} px, worst {:.2} px",
        total, n05, n1, n2, median, p95, worst
    );

    assert_eq!(total, 292, "Should have 292 pen strokes");
    // OpenNote 2.9.4-rs.10 figures with ink liftoff fix
    assert_eq!(n05, 57, "n05 should match TS bench");
    assert_eq!(n1, 10, "n1 should match TS bench");
    assert_eq!(n2, 3, "n2 should match TS bench");
    assert!((median - 0.29).abs() <= 0.02, "Median should be ~0.29 px");
    assert!((p95 - 0.67).abs() <= 0.05, "p95 should be ~0.67 px");
    assert!((worst - 3.55).abs() <= 0.05, "worst should be ~3.55 px");
}

#[test]
fn test_bench_leadend() {
    let recs = load_recordings();
    let mut after = Vec::new();
    let mut strokes_count = 0;

    for (_file, strokes) in &recs {
        for s in strokes {
            let mut pts: Vec<Point> = Vec::new();
            let mut dens = SampleDensifier::new();
            for sample in &s.samples {
                let pt = Point {
                    x: sample[0],
                    y: sample[1],
                    pressure: if sample[3] > 0.0 { sample[3] } else { 0.0 },
                    t: Some(sample[2]),
                    alt: Some(sample[5]),
                    az: Some(sample[6]),
                };
                for q in dens.push(pt) {
                    pts.push(q);
                }
            }
            if pts.len() < 3 {
                continue;
            }
            strokes_count += 1;

            // lead at lift
            let mut deliveries: Vec<Vec<[f64; 7]>> = Vec::new();
            for q in &s.samples {
                if let Some(last) = deliveries.last_mut() {
                    if (last[0][4] - q[4]).abs() < 1e-6 {
                        last.push(*q);
                        continue;
                    }
                }
                deliveries.push(vec![*q]);
            }
            let lead = if deliveries.len() >= 3 {
                let move_del = &deliveries[deliveries.len() - 2];
                let newest = move_del.last().unwrap();
                if newest[3] > 0.02 {
                    Some(*newest)
                } else {
                    None
                }
            } else {
                None
            };

            if let Some(lead_pt) = lead {
                let mut stroke_pts = pts.clone();
                stroke_pts.push(Point {
                    x: lead_pt[0],
                    y: lead_pt[1],
                    t: Some(lead_pt[2]),
                    pressure: lead_pt[3],
                    alt: Some(lead_pt[5]),
                    az: Some(lead_pt[6]),
                });
                let stroke = Stroke {
                    id: "x".to_string(),
                    tool: "pen".to_string(),
                    color: "#000".to_string(),
                    width: s.width,
                    opacity: 1.0,
                    points: stroke_pts,
                    line_style: Some(LineStyle::Solid),
                    pen_style: Some(PenStyle::Fountain),
                    is_shape: None,
                    closed: None,
                    shape_kind: None,
                    fill: None,
                    fill_color: None,
                    fill_opacity: None,
                    arrow: None,
                    modeled: None,
                    pen_end: Some(true),
                    rotation: None,
                    created_at: Some(0.0),
                    highlight_alpha: None,
                    dash_offset: None,
                    fill_only: None,
                };
                let g = stroke_geometry(&stroke);
                let e = g.pts.last().unwrap();
                let gap = (lead_pt[0] - e.x).hypot(lead_pt[1] - e.y);
                after.push(gap);
            }
        }
    }

    after.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median = after[after.len() / 2];
    let p90 = after[(after.len() as f64 * 0.90) as usize];
    let p99 = after[(after.len() as f64 * 0.99) as usize];
    let max = *after.last().unwrap();

    println!(
        "{} pen strokes, {} with a lead at lift",
        strokes_count,
        after.len()
    );
    println!(
        "lead to stroke end with pen end: median {:.2}, p90 {:.2}, p99 {:.2}, max {:.2} page px",
        median, p90, p99, max
    );

    assert_eq!(strokes_count, 292);
    assert_eq!(after.len(), 215);
    assert!(median <= 0.01, "Median gap should be 0.00");
    assert!(p90 <= 0.04, "p90 gap should be <= 0.04");
    assert!(max <= 0.06, "Max gap should be <= 0.06");
}

fn end_reversal(line: &[XY], len: usize) -> f64 {
    let mut pts: Vec<XY> = Vec::new();
    let mut acc = 0.0;
    for (i, p) in line.iter().enumerate() {
        if i == 0 {
            pts.push(line[0]);
            continue;
        }
        let a = line[i - 1];
        let b = *p;
        let l = (b.x - a.x).hypot(b.y - a.y);
        let mut t = 1.0 - acc;
        while t <= l {
            pts.push(XY {
                x: a.x + ((b.x - a.x) * t) / l,
                y: a.y + ((b.y - a.y) * t) / l,
            });
            t += 1.0;
        }
        acc = (acc + l) % 1.0;
    }

    let n = pts.len();
    let mut worst = 0.0f64;
    let start = 3.max(n.saturating_sub(1 + len));
    let end = n.saturating_sub(3);
    for i in start..end {
        let ax = pts[i].x - pts[i - 3].x;
        let ay = pts[i].y - pts[i - 3].y;
        let bx = pts[i + 3].x - pts[i].x;
        let by = pts[i + 3].y - pts[i].y;
        let la = ax.hypot(ay);
        let lb = bx.hypot(by);
        if la < 0.5 || lb < 0.5 {
            continue;
        }
        let cos_val = ((ax * bx + ay * by) / (la * lb)).clamp(-1.0, 1.0);
        let deg = (cos_val.acos() * 180.0) / PI;
        if deg > worst {
            worst = deg;
        }
    }
    worst
}

#[test]
fn test_bench_hooks() {
    let recs = load_recordings();
    let mut total = 0;
    let mut now_hooks = 0;

    for (_file, strokes) in &recs {
        for (i, s) in strokes.iter().enumerate() {
            if s.samples.len() < 6 {
                continue;
            }
            total += 1;
            let mut pts: Vec<Point> = Vec::new();
            let mut dens = SampleDensifier::new();
            let is_web = s.source.as_deref() == Some("web");
            let lift = if is_web
                && s.samples.len() > 1
                && s.samples.last().unwrap()[3] == 0.0
            {
                Some(*s.samples.last().unwrap())
            } else {
                None
            };

            let src_samples = if lift.is_some() {
                &s.samples[0..s.samples.len() - 1]
            } else {
                &s.samples[..]
            };

            for row in src_samples {
                let pt = Point {
                    x: row[0],
                    y: row[1],
                    t: Some(row[2]),
                    pressure: if row[3] > 0.0 { row[3] } else { 0.0 },
                    alt: Some(row[5]),
                    az: Some(row[6]),
                };
                for q in dens.push(pt) {
                    pts.push(q);
                }
            }
            if let Some(l) = lift {
                pts.push(Point {
                    x: l[0],
                    y: l[1],
                    t: Some(l[2]),
                    pressure: 0.0,
                    alt: Some(l[5]),
                    az: Some(l[6]),
                });
            }

            let stroke = Stroke {
                id: format!("s{}", i),
                tool: "pen".to_string(),
                color: "#000".to_string(),
                width: s.width,
                opacity: 1.0,
                points: pts.clone(),
                line_style: Some(LineStyle::Solid),
                pen_style: Some(PenStyle::Fountain),
                is_shape: None,
                closed: None,
                shape_kind: None,
                fill: None,
                fill_color: None,
                fill_opacity: None,
                arrow: None,
                modeled: None,
                pen_end: None,
                rotation: None,
                created_at: Some(0.0),
                highlight_alpha: None,
                dash_offset: None,
                fill_only: None,
            };

            let g = stroke_geometry(&stroke);
            let g_xy: Vec<XY> = g.pts.iter().map(|p| XY { x: p.x, y: p.y }).collect();
            let g_rev = end_reversal(&g_xy, 15);

            let mut pen_pts: Vec<Point> = Vec::new();
            let mut pen_dens = SampleDensifier::new();
            for row in s.samples.iter().filter(|q| q[3] > 0.0) {
                let pt = Point {
                    x: row[0],
                    y: row[1],
                    t: Some(row[2]),
                    pressure: row[3],
                    alt: Some(row[5]),
                    az: Some(row[6]),
                };
                for q in pen_dens.push(pt) {
                    pen_pts.push(q);
                }
            }
            let pen_xy: Vec<XY> = pen_pts.iter().map(|p| XY { x: p.x, y: p.y }).collect();
            let pen_rev = end_reversal(&pen_xy, 15);

            if g_rev > 120.0 && pen_rev < 90.0 {
                now_hooks += 1;
            }
        }
    }

    println!(
        "{} recorded pen strokes: line ends turning back where pen did not: {}",
        total, now_hooks
    );
    assert_eq!(total, 275);
    assert_eq!(now_hooks, 0, "Hooks reduced to 0 with liftoff turn cos = 0.0");
}

#[test]
fn test_bench_look() {
    let recs = load_recordings();
    let mut dev = Vec::new();
    let mut range = Vec::new();
    let mut w_sum = 0.0;
    let mut w_n = 0;
    let mut strokes_count = 0;
    let mut rough_sum = 0.0;
    let mut rough_n = 0;
    let mut ripple_sum = 0.0;
    let mut ripple_n = 0;
    let ripple_px = 3.0;

    for (_file, strokes) in &recs {
        for s in strokes {
            let mut pts: Vec<Point> = Vec::new();
            let mut dens = SampleDensifier::new();
            for sample in &s.samples {
                let pt = Point {
                    x: sample[0],
                    y: sample[1],
                    pressure: if sample[3] > 0.0 { sample[3] } else { 0.0 },
                    t: Some(sample[2]),
                    alt: Some(sample[5]),
                    az: Some(sample[6]),
                };
                for q in dens.push(pt) {
                    pts.push(q);
                }
            }
            if pts.len() < 3 {
                continue;
            }

            let stroke = Stroke {
                id: "x".to_string(),
                tool: "pen".to_string(),
                color: "#000".to_string(),
                width: s.width,
                opacity: 1.0,
                points: pts,
                line_style: Some(LineStyle::Solid),
                pen_style: Some(PenStyle::Fountain),
                is_shape: None,
                closed: None,
                shape_kind: None,
                fill: None,
                fill_color: None,
                fill_opacity: None,
                arrow: None,
                modeled: None,
                pen_end: None,
                rotation: None,
                created_at: Some(0.0),
                highlight_alpha: None,
                dash_offset: None,
                fill_only: None,
            };

            let g = stroke_geometry(&stroke);
            let raw: Vec<XY> = s
                .samples
                .iter()
                .filter(|q| q[3] > 0.0)
                .map(|q| XY { x: q[0], y: q[1] })
                .collect();
            if raw.len() < 2 || g.pts.len() < 3 {
                continue;
            }
            strokes_count += 1;

            let mut m = 0.0f64;
            for q in &g.pts {
                let (d, _) = dist_to_polyline(XY { x: q.x, y: q.y }, &raw);
                if d > m {
                    m = d;
                }
            }
            dev.push(m);

            let g_xy: Vec<XY> = g.pts.iter().map(|p| XY { x: p.x, y: p.y }).collect();
            let (w_s, w_cnt) = ink::wobble(&g_xy);
            w_sum += w_s;
            w_n += w_cnt;

            if let Some(widths) = &g.widths {
                let max_w = widths.iter().fold(0.0f64, |a, &b| a.max(b));
                let min_w = widths.iter().fold(f64::INFINITY, |a, &b| a.min(b));
                range.push(max_w / 1e-6f64.max(min_w));

                let at = ink::arcs(&g_xy);
                for i in 1..g.pts.len() - 1 {
                    let h1 = at[i] - at[i - 1];
                    let h2 = at[i + 1] - at[i];
                    if h1 < 0.05 || h2 < 0.05 {
                        continue;
                    }
                    let d2 = ((widths[i + 1] - widths[i]) / h2 - (widths[i] - widths[i - 1]) / h1)
                        / ((h1 + h2) / 2.0);
                    rough_sum += (d2 / g.width).powi(2);
                    rough_n += 1;
                }

                for i in 0..g.pts.len() {
                    let mut sw = 0.0;
                    let mut ww = 0.0;
                    let mut j = i;
                    loop {
                        if at[i] - at[j] > 2.0 * ripple_px {
                            break;
                        }
                        let e = (-((at[i] - at[j]).powi(2)) / (2.0 * ripple_px * ripple_px)).exp();
                        sw += widths[j] * e;
                        ww += e;
                        if j == 0 {
                            break;
                        }
                        j -= 1;
                    }
                    for j in i + 1..g.pts.len() {
                        if at[j] - at[i] > 2.0 * ripple_px {
                            break;
                        }
                        let e = (-((at[j] - at[i]).powi(2)) / (2.0 * ripple_px * ripple_px)).exp();
                        sw += widths[j] * e;
                        ww += e;
                    }
                    if at[i] < 2.0 * ripple_px || at[g.pts.len() - 1] - at[i] < 2.0 * ripple_px {
                        continue;
                    }
                    ripple_sum += ((widths[i] - sw / ww) / g.width).powi(2);
                    ripple_n += 1;
                }
            }
        }
    }

    dev.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let dev_median = dev[dev.len() / 2];
    let dev_p95 = dev[(dev.len() as f64 * 0.95) as usize];

    range.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let range_median = range[range.len() / 2];
    let range_p95 = range[(range.len() as f64 * 0.95) as usize];

    let wobble_val = (w_sum / w_n as f64).sqrt() * 1000.0;
    let nervous_val = (rough_sum / rough_n as f64).sqrt() * 1000.0;
    let ripple_pct = (ripple_sum / ripple_n as f64).sqrt() * 100.0;

    println!("{} recorded pen strokes", strokes_count);
    println!(
        "accuracy   ink to pen path: median {:.2} px, p95 {:.2} px",
        dev_median, dev_p95
    );
    println!("wobble     {:.1} mrad/px^2", wobble_val);
    println!(
        "width      widest/narrowest: median {:.2}x, p95 {:.2}x",
        range_median, range_p95
    );
    println!("nervous    width roughness {:.2}", nervous_val);
    println!("ripple     width jitter {:.2}%", ripple_pct);

    // OpenNote 2.9.4-rs.12 figures (npm run bench:look on the same recordings).
    assert_eq!(strokes_count, 292);
    assert!((dev_median - 0.29).abs() <= 0.02);
    assert!((dev_p95 - 0.67).abs() <= 0.05);
    assert!((wobble_val - 39.4).abs() <= 0.6, "Wobble should be ~39.4");
    assert!((range_median - 1.66).abs() <= 0.03);
    assert!((range_p95 - 2.34).abs() <= 0.05);
    assert!((nervous_val - 34.69).abs() <= 0.6);
    assert!((ripple_pct - 2.00).abs() <= 0.05);
}

#[test]
fn test_precision_eraser() {
    let mut id_counter = 0;
    let make_id = move || {
        id_counter += 1;
        format!("e_{}", id_counter)
    };

    // Create a horizontal line from (10, 50) to (110, 50)
    let stroke = Stroke {
        id: "line1".to_string(),
        tool: "pen".to_string(),
        color: "#000".to_string(),
        width: 2.0,
        opacity: 1.0,
        points: vec![
            Point {
                x: 10.0,
                y: 50.0,
                pressure: 0.5,
                t: None,
                alt: None,
                az: None,
            },
            Point {
                x: 110.0,
                y: 50.0,
                pressure: 0.5,
                t: None,
                alt: None,
                az: None,
            },
        ],
        line_style: None,
        pen_style: None,
        is_shape: Some(true),
        closed: Some(false),
        shape_kind: Some(model::ShapeKind::Line),
        fill: None,
        fill_color: None,
        fill_opacity: None,
        arrow: None,
        modeled: None,
        pen_end: None,
        rotation: None,
        created_at: Some(1.0),
        highlight_alpha: None,
        dash_offset: None,
        fill_only: None,
    };

    // Erase at (60, 50) with radius 10
    let (pieces, changed) = erase_strokes_partial(&[stroke], 60.0, 50.0, 10.0, make_id, None);
    assert!(changed, "Should have cut the stroke");
    assert_eq!(pieces.len(), 2, "Should have split into 2 pieces");
    // Left piece ends near x=50, right piece starts near x=70
    assert!(pieces[0].points.last().unwrap().x < 60.0);
    assert!(pieces[1].points.first().unwrap().x > 60.0);
}
