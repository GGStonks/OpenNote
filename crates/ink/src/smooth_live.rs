use crate::ink_width::{ink_widths, width_behind};
use crate::smoothing::{smooth_line, smooth_settle};
use nib::geometry::{ModeledPoint, XY};
use nib::nib::NibModeler;

pub struct LiveResult {
    pub final_pts: Vec<ModeledPoint>,
    pub final_w: Vec<f64>,
    pub rest_pts: Vec<ModeledPoint>,
    pub rest_w: Vec<f64>,
}

#[derive(Clone, Debug, Default)]
pub struct SmoothLiveStroke {
    pub model: NibModeler,
    final_pts: Vec<ModeledPoint>,
    final_w: Vec<f64>,
}

impl SmoothLiveStroke {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add(&mut self, x: f64, y: f64, t: f64, pressure: f64) {
        self.model.add(x, y, t, pressure);
    }

    pub fn line(&mut self, width: f64, variable: bool) -> LiveResult {
        let widths_of = |seq: &[ModeledPoint]| -> Vec<f64> {
            if variable {
                ink_widths(seq, width)
            } else {
                vec![width; seq.len()]
            }
        };

        let raw = &self.model.points;
        let done = self.final_pts.len();

        let raw_xy: Vec<XY> = raw.iter().map(|p| XY { x: p.x, y: p.y }).collect();
        let settle = smooth_settle();
        let mut back = 0.0;
        let mut up_to = raw_xy.len().saturating_sub(1);
        while up_to > 0 && back < settle {
            back += (raw_xy[up_to].x - raw_xy[up_to - 1].x)
                .hypot(raw_xy[up_to].y - raw_xy[up_to - 1].y);
            up_to -= 1;
        }
        let up_to = done.max(up_to);

        let window = smooth_settle().max(width_behind()) + 3.0;

        if up_to > done {
            let mut from = done;
            let mut back = 0.0;
            while from > 0 && back < window {
                back += (raw[from].x - raw[from - 1].x).hypot(raw[from].y - raw[from - 1].y);
                from -= 1;
            }
            let seg = &raw[from..];
            let seg_w = widths_of(seg);
            let g_pts = smooth_line(seg, up_to - from, done - from);
            for i in done..up_to {
                self.final_pts.push(g_pts[i - from]);
                self.final_w.push(seg_w[i - from]);
            }
        }

        let mut rest_pts = if up_to < raw.len() {
            raw[up_to..].to_vec()
        } else {
            Vec::new()
        };
        let rest_w = if !rest_pts.is_empty() {
            let mut from = up_to;
            let mut back = 0.0;
            while from > 0 && back < width_behind() {
                back += (raw[from].x - raw[from - 1].x).hypot(raw[from].y - raw[from - 1].y);
                from -= 1;
            }
            let tail = self.model.tail();
            let mut all_seg = raw[from..].to_vec();
            all_seg.extend(tail.iter().copied());
            let all_w = widths_of(&all_seg);
            let take = all_seg.len() - (up_to - from);
            rest_pts.extend(tail);
            all_w[all_w.len() - take..].to_vec()
        } else {
            let tail = self.model.tail();
            let _tail_len = tail.len();
            let w = widths_of(&tail);
            rest_pts.extend(tail);
            w
        };

        LiveResult {
            final_pts: self.final_pts.clone(),
            final_w: self.final_w.clone(),
            rest_pts,
            rest_w,
        }
    }
}
