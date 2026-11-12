use crate::ink_width::WIDTH_AHEAD;
use nib::geometry::{ModeledPoint, XY};
use std::f64::consts::PI;

pub const SMOOTH_SIGMA: f64 = 1.6;
pub const CORNER_DEG: f64 = 55.0;

pub fn smooth_settle() -> f64 {
    (6.0 * SMOOTH_SIGMA).max(3.0 * SMOOTH_SIGMA + 1.0f64.max(WIDTH_AHEAD) + 0.5)
}

pub fn settled_index(pts: &[XY]) -> usize {
    let mut back = 0.0;
    let mut i = pts.len().saturating_sub(1);
    let settle = smooth_settle();
    while i > 0 && back < settle {
        back += (pts[i].x - pts[i - 1].x).hypot(pts[i].y - pts[i - 1].y);
        i -= 1;
    }
    i
}

pub fn smooth_line(p: &[ModeledPoint], up_to: usize, from: usize) -> Vec<ModeledPoint> {
    let n = p.len();
    if n < 5 || up_to == 0 {
        return p.to_vec();
    }

    let mut at = vec![0.0; n];
    for i in 1..n {
        at[i] = at[i - 1] + (p[i].x - p[i - 1].x).hypot(p[i].y - p[i - 1].y);
    }

    let mut cuts = vec![0];
    for i in 1..n - 1 {
        let mut a = i;
        let mut b = i;
        while a > 0 && at[i] - at[a] < 1.0 {
            a -= 1;
        }
        while b < n - 1 && at[b] - at[i] < 1.0 {
            b += 1;
        }
        if a == i || b == i {
            continue;
        }
        let t1 = (p[i].y - p[a].y).atan2(p[i].x - p[a].x);
        let t2 = (p[b].y - p[i].y).atan2(p[b].x - p[i].x);
        let mut turn = (t2 - t1).abs();
        if turn > PI {
            turn = 2.0 * PI - turn;
        }
        if (turn * 180.0) / PI > CORNER_DEG && at[i] - at[*cuts.last().unwrap()] > 1.0 {
            cuts.push(i);
        }
    }
    cuts.push(n - 1);

    let mut pts = p.to_vec();
    let sig = SMOOTH_SIGMA;
    let inv = 1.0 / (2.0 * sig * sig);

    for c in 0..cuts.len() - 1 {
        let lo = cuts[c];
        let hi = cuts[c + 1];
        if hi <= from {
            continue;
        }
        let start = (lo + 1).max(from);
        let end = hi.min(up_to);
        for i in start..end {
            let half = (3.0 * sig).min((at[i] - at[lo]).min(at[hi] - at[i]));
            if half <= 0.0 {
                continue;
            }
            let mut sx = 0.0;
            let mut sy = 0.0;
            let mut sp = 0.0;
            let mut ws = 0.0;

            let mut j = i;
            loop {
                if at[i] - at[j] > half {
                    break;
                }
                let dist = at[i] - at[j];
                let w = (-dist * dist * inv).exp();
                sx += p[j].x * w;
                sy += p[j].y * w;
                sp += p[j].p * w;
                ws += w;
                if j == lo {
                    break;
                }
                j -= 1;
            }

            for j in i + 1..=hi {
                if at[j] - at[i] > half {
                    break;
                }
                let dist = at[j] - at[i];
                let w = (-dist * dist * inv).exp();
                sx += p[j].x * w;
                sy += p[j].y * w;
                sp += p[j].p * w;
                ws += w;
            }

            if ws > 0.0 {
                pts[i] = ModeledPoint {
                    x: sx / ws,
                    y: sy / ws,
                    p: sp / ws,
                    t: p[i].t,
                };
            }
        }
    }

    pts
}

pub fn settled_smooth(pts: &[ModeledPoint]) -> Vec<ModeledPoint> {
    let xy: Vec<XY> = pts.iter().map(|p| XY { x: p.x, y: p.y }).collect();
    let idx = settled_index(&xy);
    smooth_line(pts, idx, 0)
}
