use nib::geometry::JsMath;
use nib::geometry::ModeledPoint;
use std::f64::consts::PI;

pub const PRESSURE_SIGMA: f64 = 2.0;
const DIR_PX: f64 = 3.0;
const DIR_SIGMA: f64 = 2.5;
pub const WIDTH_AHEAD: f64 = 3.0 * PRESSURE_SIGMA;
pub const WIDTH_BEHIND: f64 = 3.0 * PRESSURE_SIGMA; // max(6.0, 3 + 7.5 = 10.5) -> 10.5 actually!

pub const NIB_RATIO: f64 = 1.9;
pub const NIB_ANGLE: f64 = 28.0;

const WRITING_DIRECTIONS: [f64; 12] = [
    0.104, 0.04, 0.042, 0.053, 0.05, 0.067, 0.085, 0.082, 0.127, 0.134, 0.105, 0.111,
];

pub fn width_behind() -> f64 {
    (3.0 * PRESSURE_SIGMA).max(DIR_PX + 3.0 * DIR_SIGMA)
}

fn nib_extent(ux: f64, uy: f64) -> f64 {
    let a = (NIB_ANGLE * PI) / 180.0;
    let ex = a.cos();
    let ey = -a.sin();
    let along = ux * ex + uy * ey;
    let across = ux * -ey + uy * ex;
    (across * across * NIB_RATIO * NIB_RATIO + along * along).sqrt()
}

pub fn nib_norm() -> f64 {
    let mut s = 0.0;
    for (k, &h) in WRITING_DIRECTIONS.iter().enumerate() {
        let a = ((7.5 + 15.0 * k as f64) * PI) / 180.0;
        s += h * nib_extent(a.cos(), a.sin());
    }
    1.0 / s
}

pub fn nib_factor(dx: f64, dy: f64) -> f64 {
    let l = dx.js_hypot(dy);
    if l > 1e-6 {
        nib_extent(dx / l, dy / l) * nib_norm()
    } else {
        1.0
    }
}

pub fn pressure_factor(pressure: f64) -> f64 {
    let p = pressure.clamp(0.0, 1.0);
    let p = if p == 0.0 { 0.5 } else { p };
    0.61 + 0.94 * p.powf(0.68)
}

pub fn ink_widths(pts: &[ModeledPoint], base: f64) -> Vec<f64> {
    let n = pts.len();
    if n == 0 {
        return Vec::new();
    }
    let mut at = vec![0.0; n];
    for i in 1..n {
        at[i] = at[i - 1] + (pts[i].x - pts[i - 1].x).js_hypot(pts[i].y - pts[i - 1].y);
    }

    let mut raw = vec![0.0; n];
    let mut a = 0;
    for i in 0..n {
        if at[i] >= DIR_PX {
            while at[i] - at[a + 1] >= DIR_PX {
                a += 1;
            }
            raw[i] = nib_factor(pts[i].x - pts[a].x, pts[i].y - pts[a].y);
        } else {
            raw[i] = if at[i] > 0.3 {
                nib_factor(pts[i].x - pts[0].x, pts[i].y - pts[0].y)
            } else {
                1.0
            };
        }
    }

    let dinv = 1.0 / (2.0 * DIR_SIGMA * DIR_SIGMA);
    let pinv = 1.0 / (2.0 * PRESSURE_SIGMA * PRESSURE_SIGMA);
    let mut out = vec![0.0; n];
    let mut d0 = 0;
    let mut p0 = 0;
    let mut p1 = 0;

    for i in 0..n {
        while at[i] - at[d0] > 3.0 * DIR_SIGMA {
            d0 += 1;
        }
        let mut sd = 0.0;
        let mut wd = 0.0;
        for j in d0..=i {
            let d = at[i] - at[j];
            let w = (-d * d * dinv).exp();
            sd += raw[j] * w;
            wd += w;
        }

        while at[i] - at[p0] > WIDTH_AHEAD {
            p0 += 1;
        }
        if p1 < i {
            p1 = i;
        }
        while p1 + 1 < n && at[p1 + 1] - at[i] <= WIDTH_AHEAD {
            p1 += 1;
        }
        let mut sp = 0.0;
        let mut wp = 0.0;
        for j in p0..=p1 {
            let d = at[j] - at[i];
            let w = (-d * d * pinv).exp();
            sp += pts[j].p * w;
            wp += w;
        }

        out[i] = base * pressure_factor(sp / wp) * (sd / wd);
    }
    out
}

