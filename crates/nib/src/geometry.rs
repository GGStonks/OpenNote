#[cfg(feature = "serde")]
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
pub struct XY {
    pub x: f64,
    pub y: f64,
}

impl XY {
    pub fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
pub struct InkPoint {
    pub x: f64,
    pub y: f64,
    pub pressure: f64,
    pub t: Option<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
pub struct ModeledPoint {
    pub x: f64,
    pub y: f64,
    pub p: f64,
    pub t: f64,
}

impl ModeledPoint {
    pub fn new(x: f64, y: f64, p: f64, t: f64) -> Self {
        Self { x, y, p, t }
    }
}

pub fn sample_times(points: &[InkPoint]) -> Vec<f64> {
    let mut out = Vec::with_capacity(points.len());
    for i in 0..points.len() {
        let p = &points[i];
        if let Some(t) = p.t {
            if i == 0 || points[i - 1].t.is_some() {
                out.push(t);
                continue;
            }
        }
        if i == 0 {
            out.push(0.0);
        } else {
            let prev_t = out[i - 1];
            let prev_p = &points[i - 1];
            let dist = (p.x - prev_p.x).js_hypot(p.y - prev_p.y);
            out.push(prev_t + (4.0f64).max(dist / 0.4));
        }
    }
    out
}

pub fn has_real_pressure(points: &[InkPoint]) -> bool {
    points.iter().any(|p| p.pressure != 0.5 && p.pressure > 0.0)
}

pub fn pressure_width(base: f64, pressure: f64) -> f64 {
    let p = pressure.clamp(0.0, 1.0);
    base * (0.72 + 0.58 * p.powf(0.7))
}

pub fn thin_modeled(pts: &[ModeledPoint], min: f64) -> Vec<ModeledPoint> {
    if pts.len() < 3 {
        return pts.to_vec();
    }
    let mut out = Vec::with_capacity(pts.len());
    out.push(pts[0]);
    for i in 1..pts.len() - 1 {
        let last = out.last().unwrap();
        if (pts[i].x - last.x).js_hypot(pts[i].y - last.y) >= min {
            out.push(pts[i]);
        }
    }
    out.push(*pts.last().unwrap());
    out
}

/// `Math.hypot` as the JavaScript engines compute it (JavaScriptCore and V8 alike: scaled by the
/// larger value, Kahan-summed squares), not libm's `f64::hypot`. The two differ in the last bit,
/// which is enough to flip a comparison of two equal gaps (the smoothing's window, a corner cut)
/// and move a point of the drawn line by a fraction of a pixel: every port of a TypeScript
/// `Math.hypot` calls this, so the Rust line is the app's line.
pub trait JsMath {
    fn js_hypot(self, y: f64) -> f64;
}

impl JsMath for f64 {
    #[inline]
    fn js_hypot(self, y: f64) -> f64 {
        let x = self;
        if x.is_infinite() || y.is_infinite() {
            return f64::INFINITY;
        }
        if x.is_nan() || y.is_nan() {
            return f64::NAN;
        }
        let max = x.abs().max(y.abs());
        if max == 0.0 {
            return 0.0;
        }
        let (mut sum, mut compensation) = (0.0f64, 0.0f64);
        for v in [x, y] {
            let n = v / max;
            let summand = n * n - compensation;
            let preliminary = sum + summand;
            compensation = (preliminary - sum) - summand;
            sum = preliminary;
        }
        sum.sqrt() * max
    }
}
