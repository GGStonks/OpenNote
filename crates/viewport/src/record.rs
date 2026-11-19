//! Each gesture's frames (docs/rust-native-canvas.md N5): from the second finger down until the
//! camera rests (fingers up, momentum and the pull's release done), the render thread's ticks
//! and the frames it drew. Summarised for the crash report's `pinch` entry (`gl: 'rust'`, as
//! useViewport's logPinch), with the display's best rate beside the rate achieved.

use serde::Serialize;

/// A gesture's frames as the crash report shows them.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GestureSummary {
    /// Counts the gestures of the run.
    pub id: u64,
    /// From the second finger to rest.
    pub ms: f64,
    /// Display ticks (intervals measured) and frames the canvas drew in them.
    pub frames: usize,
    pub drawn: u64,
    /// Ticks per second achieved, and the display's best rate.
    pub fps: f64,
    pub hz: f64,
    /// Tick intervals (ms): median, 95th percentile, longest; intervals over 1.5 frames of the
    /// display's best rate.
    pub p50: f64,
    pub p95: f64,
    pub max: f64,
    pub slow: usize,
    /// Finger events, rebases, the zoom at the start and at rest, whether it glided.
    pub events: u64,
    pub rebases: u64,
    pub z0: f64,
    pub z: f64,
    pub glide: bool,
}

/// One gesture being recorded.
#[derive(Clone, Debug)]
pub struct GestureRecorder {
    start: f64,
    ticks: Vec<f64>,
    drawn: u64,
    z0: f64,
    events0: u64,
    rebases0: u64,
    glide: bool,
    hz: f64,
}

impl GestureRecorder {
    /// Starts at `t_ms`, the zoom then `z0`; `events` / `rebases`: the viewport's counters now;
    /// `hz`: the display's best rate (0 when the shell did not say).
    pub fn new(t_ms: f64, z0: f64, events: u64, rebases: u64, hz: f64) -> Self {
        GestureRecorder {
            start: t_ms,
            ticks: Vec::new(),
            drawn: 0,
            z0,
            events0: events,
            rebases0: rebases,
            glide: false,
            hz,
        }
    }

    /// A display tick at `t_ms`; `drawn`: the canvas drew a frame in it.
    pub fn tick(&mut self, t_ms: f64, drawn: bool) {
        self.ticks.push(t_ms);
        if drawn {
            self.drawn += 1;
        }
    }

    /// The canvas drew a frame in the last tick.
    pub fn drew(&mut self) {
        self.drawn += 1;
    }

    /// The camera glided after the fingers lifted.
    pub fn glided(&mut self) {
        self.glide = true;
    }

    /// The summary at rest (`t_ms`), zoom `z`, the viewport's counters then.
    pub fn finish(&self, id: u64, t_ms: f64, z: f64, events: u64, rebases: u64) -> GestureSummary {
        let mut gaps: Vec<f64> = self.ticks.windows(2).map(|w| w[1] - w[0]).collect();
        gaps.sort_by(|a, b| a.total_cmp(b));
        let span = match (self.ticks.first(), self.ticks.last()) {
            (Some(a), Some(b)) if b > a => b - a,
            _ => 0.0,
        };
        let r = |v: f64| (v * 10.0).round() / 10.0;
        let at = |q: f64| {
            gaps.get(((gaps.len() as f64) * q) as usize)
                .copied()
                .unwrap_or(0.0)
        };
        let frame = if self.hz > 0.0 {
            1000.0 / self.hz
        } else {
            1000.0 / 60.0
        };
        GestureSummary {
            id,
            ms: r(t_ms - self.start),
            frames: gaps.len(),
            drawn: self.drawn,
            fps: if span > 0.0 {
                r(gaps.len() as f64 * 1000.0 / span)
            } else {
                0.0
            },
            hz: self.hz,
            p50: r(gaps.get(gaps.len() / 2).copied().unwrap_or(0.0)),
            p95: r(at(0.95)),
            max: r(gaps.last().copied().unwrap_or(0.0)),
            slow: gaps.iter().filter(|g| **g > frame * 1.5).count(),
            events: events.saturating_sub(self.events0),
            rebases: rebases.saturating_sub(self.rebases0),
            z0: (self.z0 * 100.0).round() / 100.0,
            z: (z * 100.0).round() / 100.0,
            glide: self.glide,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_120_hz_gesture_with_one_dropped_frame() {
        let mut r = GestureRecorder::new(0.0, 1.0, 10, 0, 120.0);
        let mut t = 0.0;
        for i in 0..121 {
            r.tick(t, i % 2 == 0);
            t += if i == 60 {
                2.0 * 1000.0 / 120.0
            } else {
                1000.0 / 120.0
            };
        }
        let s = r.finish(3, 1000.0, 2.0, 30, 1);
        assert_eq!(s.frames, 120);
        assert_eq!(s.drawn, 61);
        assert!((s.fps - 119.0).abs() < 1.0, "{}", s.fps);
        assert_eq!(s.p50, 8.3);
        assert_eq!(s.max, 16.7);
        assert_eq!(s.slow, 1);
        assert_eq!((s.events, s.rebases, s.z0, s.z, s.id), (20, 1, 1.0, 2.0, 3));
    }

    #[test]
    fn no_ticks_no_numbers() {
        let s = GestureRecorder::new(5.0, 1.0, 0, 0, 0.0).finish(1, 10.0, 1.0, 0, 0);
        assert_eq!((s.frames, s.fps, s.p95, s.ms), (0, 0.0, 0.0, 5.0));
    }
}
