use nib::geometry::JsMath;
use crate::ink_width::WIDTH_AHEAD;
use nib::geometry::{ModeledPoint, XY};
use std::f64::consts::PI;

pub const SMOOTH_SIGMA: f64 = 1.6;
pub const CORNER_DEG: f64 = 55.0;
pub const CORNER_CHORD: f64 = 2.5;

// The smoothing is as wide as the pen's samples are apart there (SIGMA_PER_GAP times the gap, from
// SMOOTH_SIGMA_MIN up to SMOOTH_SIGMA): it rounds off the engine's corners at the samples and
// leaves the hand's own line alone (OpenNote 2.9.4, `smoothSigma` in src/ink/strokeRenderer.ts).
// The gap is the line's speed (over SPEED_PX either side, from the modelled points' times) times
// the Pencil's sample interval.
const SIGMA_PER_GAP: f64 = 1.25;
const SMOOTH_SIGMA_MIN: f64 = 0.25;
const SAMPLE_MS: f64 = 1000.0 / 240.0;
const SPEED_PX: f64 = 2.0;

/// The smoothing width at point i of p (`at`: arc length).
fn smooth_sigma(p: &[ModeledPoint], at: &[f64], i: usize) -> f64 {
    let (mut a, mut b) = (i, i);
    while a > 0 && at[i] - at[a] < SPEED_PX {
        a -= 1;
    }
    while b < p.len() - 1 && at[b] - at[i] < SPEED_PX {
        b += 1;
    }
    let dt = p[b].t - p[a].t;
    if !(dt > 0.0) {
        return SMOOTH_SIGMA;
    }
    let gap = ((at[b] - at[a]) / dt) * SAMPLE_MS;
    SMOOTH_SIGMA_MIN.max(SMOOTH_SIGMA.min(SIGMA_PER_GAP * gap))
}

pub fn smooth_settle() -> f64 {
    (6.0 * SMOOTH_SIGMA).max(3.0 * SMOOTH_SIGMA + 1.0f64.max(WIDTH_AHEAD) + 0.5)
}

pub fn settled_index(pts: &[XY]) -> usize {
    let mut back = 0.0;
    let mut i = pts.len().saturating_sub(1);
    let settle = smooth_settle();
    while i > 0 && back < settle {
        back += (pts[i].x - pts[i - 1].x).js_hypot(pts[i].y - pts[i - 1].y);
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
        at[i] = at[i - 1] + (p[i].x - p[i - 1].x).js_hypot(p[i].y - p[i - 1].y);
    }

    let mut cuts = vec![0];
    for i in 1..n - 1 {
        let mut a = i;
        let mut b = i;
        while a > 0 && at[i] - at[a] < CORNER_CHORD {
            a -= 1;
        }
        while b < n - 1 && at[b] - at[i] < CORNER_CHORD {
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

    for c in 0..cuts.len() - 1 {
        let lo = cuts[c];
        let hi = cuts[c + 1];
        if hi <= from {
            continue;
        }
        let start = (lo + 1).max(from);
        let end = hi.min(up_to);
        for i in start..end {
            let sig = smooth_sigma(p, &at, i);
            let inv = 1.0 / (2.0 * sig * sig);
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

