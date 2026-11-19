//! The camera's arithmetic against the TypeScript the page runs (src/editor/viewportMath.ts),
//! to 1e-9. The reference is written by `npm run bench:rustref -- bench/rust-ref/viewport.json
//! --module viewport` (bench/rustref/viewport.ts); null stands for Infinity.

use serde_json::Value;
use viewport::math::*;

const TOL: f64 = 1e-9;

fn reference() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../bench/rust-ref/viewport.json"
    );
    let text = std::fs::read_to_string(path).unwrap_or_else(|_| {
        panic!("{path} is missing: run `npm run bench:rustref -- bench/rust-ref/viewport.json --module viewport`")
    });
    serde_json::from_str(&text).expect("viewport.json")
}

fn num(v: &Value) -> f64 {
    v.as_f64().unwrap_or(f64::INFINITY)
}

fn rows<'a>(r: &'a Value, k: &str) -> &'a Vec<Value> {
    let a = r[k].as_array().unwrap_or_else(|| panic!("no {k}"));
    assert!(!a.is_empty(), "{k} is empty");
    a
}

fn same(what: &str, row: &Value, got: f64, want: f64) {
    assert!(
        (got - want).abs() <= TOL || (got.is_infinite() && want.is_infinite()),
        "{what} {row}: rust {got} ts {want}"
    );
}

#[test]
fn limits_are_the_pages() {
    let r = reference();
    assert_eq!(num(&r["limits"][0]), MIN_ZOOM);
    assert_eq!(num(&r["limits"][1]), MAX_ZOOM);
}

#[test]
fn zoom_clamp_fit_and_pinch() {
    let r = reference();
    for row in rows(&r, "clamp") {
        let a: Vec<f64> = row.as_array().unwrap().iter().map(num).collect();
        same("clampZoom", row, clamp_zoom(a[0], a[1], a[2], a[3]), a[4]);
    }
    for row in rows(&r, "fit") {
        let a: Vec<f64> = row.as_array().unwrap().iter().map(num).collect();
        same("fitWidthZoom", row, fit_width_zoom(a[0], a[1]), a[2]);
    }
    for row in rows(&r, "pinch") {
        let a: Vec<f64> = row.as_array().unwrap().iter().map(num).collect();
        same(
            "pinchZoom",
            row,
            pinch_zoom(a[0], a[1], a[2], a[3], a[4]),
            a[5],
        );
    }
}

#[test]
fn snap_rebase_and_sub_pixel() {
    let r = reference();
    for row in rows(&r, "snap") {
        assert_eq!(
            snaps_to_fit(num(&row[0]), num(&row[1])),
            row[2].as_bool().unwrap(),
            "snapsToFit {row}"
        );
    }
    for row in rows(&r, "rebase") {
        assert_eq!(
            should_rebase(num(&row[0]), num(&row[1])),
            row[2].as_bool().unwrap(),
            "shouldRebase {row}"
        );
    }
    for row in rows(&r, "sub") {
        same("subPixel", row, sub_pixel(num(&row[0])), num(&row[1]));
    }
}

#[test]
fn glides_step_for_step() {
    let r = reference();
    for row in rows(&r, "glides") {
        let (vx0, vy0) = (num(&row[0]), num(&row[1]));
        let dts: Vec<f64> = row[2].as_array().unwrap().iter().map(num).collect();
        let want: Vec<f64> = row[3].as_array().unwrap().iter().map(num).collect();
        let (mut x, mut y, mut vx, mut vy, mut i) = (0.0, 0.0, vx0, vy0, 0usize);
        if vx0.hypot(vy0) >= MOMENTUM_MIN_SPEED {
            while vx.hypot(vy) > MOMENTUM_STOP_SPEED && i < 5000 {
                let (dx, dy, nvx, nvy) = momentum_step(vx, vy, dts[i % dts.len()]);
                i += 1;
                x -= dx;
                y -= dy;
                vx = nvx;
                vy = nvy;
            }
        }
        same("glide x", row, x, want[0]);
        same("glide y", row, y, want[1]);
        assert_eq!(i as f64, want[2], "glide steps {row}");
    }
}

#[test]
fn release_velocity_and_easing() {
    let r = reference();
    for row in rows(&r, "velocity") {
        let h: Vec<(f64, f64, f64)> = row[0]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| (num(&p[0]), num(&p[1]), num(&p[2])))
            .collect();
        let (vx, vy) = release_velocity(&h);
        same("releaseVelocity x", row, vx, num(&row[1][0]));
        same("releaseVelocity y", row, vy, num(&row[1][1]));
    }
    for row in rows(&r, "bezier") {
        let c: Vec<f64> = row[0].as_array().unwrap().iter().map(num).collect();
        same(
            "cubicBezier",
            row,
            cubic_bezier(c[0], c[1], c[2], c[3], num(&row[1])),
            num(&row[2]),
        );
    }
    for row in rows(&r, "pull") {
        same("pullLeft", row, pull_left(num(&row[0])), num(&row[1]));
    }
}

#[test]
fn anchors_and_pages() {
    let r = reference();
    for row in rows(&r, "place") {
        let b: Vec<f64> = row[0].as_array().unwrap().iter().map(num).collect();
        let a: Vec<f64> = row[2].as_array().unwrap().iter().map(num).collect();
        let want: Vec<f64> = row[3].as_array().unwrap().iter().map(num).collect();
        let sb = ScrollBox {
            client_w: b[0],
            client_h: b[1],
            content_w: b[2],
            content_h: b[3],
        };
        let p = place_anchor(
            &sb,
            num(&row[1]),
            Anchor {
                cx: a[0],
                cy: a[1],
                sx: a[2],
                sy: a[3],
            },
        );
        same("placeAnchor scrollLeft", row, p.scroll_left, want[0]);
        same("placeAnchor scrollTop", row, p.scroll_top, want[1]);
        same("placeAnchor dx", row, p.dx, want[2]);
        same("placeAnchor dy", row, p.dy, want[3]);
    }
    for row in rows(&r, "sheets") {
        let tops: Vec<f64> = row[0].as_array().unwrap().iter().map(num).collect();
        assert_eq!(
            sheet_index_at_top(&tops, num(&row[1])) as f64,
            num(&row[2]),
            "sheetIndexAtTop {row}"
        );
    }
}
