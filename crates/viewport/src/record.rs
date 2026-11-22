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
    /// How far behind the newest camera the drawn one was (ms of camera time: the page's DOM
    /// latency the canvas matches), p50 and max, and the ticks the canvas went on alone because
    /// the page's DOM had fallen further behind (docs/rust-native-canvas.md, "One piece").
    pub trail_p50: f64,
    pub trail_max: f64,
    pub alone: usize,
    /// The display link as the shell last saw it: its interval, and how far ahead of the frame's
    /// presentation the tick ran (ms; 0 when the shell does not say).
    pub link_ms: f64,
    pub lead_ms: f64,
    /// Where the render thread's ticks went (ms): the whole tick (camera, uploads, the draw and
    /// its wait for a drawable), p95 and longest; the camera's own step (its lock included) and
    /// the scene uploads, longest. A tick over a frame misses the display's next refresh.
    pub work_p95: f64,
    pub work_max: f64,
    pub camera_max: f64,
    pub upload_max: f64,
    /// The longest wait for a drawable (ms; the display's, not the CPU's), the ticks skipped
    /// because the GPU had not finished the previous frame (`gpuLate`) or to drain frames queued
    /// ahead of the display (`drained`), and the longest display-link interval seen (`linkMax`:
    /// over `linkMs` the display ran slower than asked).
    pub acquire_max: f64,
    pub gpu_late: u64,
    pub drained: u64,
    pub link_max: f64,
    /// The longest wait for the canvas's lock (ms; held by the page's calls).
    pub lock_max: f64,
    /// Ticks where the camera moved but the canvas's camera did not (it waits for the page's DOM,
    /// ADR-008): a refresh shown twice while the fingers move. The other ticks not `drawn` had
    /// nothing new (fingers down before a pinch engages, the end of a glide).
    pub held: u64,
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
    trail: Vec<f64>,
    alone: usize,
    work: Vec<f64>,
    camera_max: f64,
    upload_max: f64,
    acquire_max: f64,
    gpu_late: u64,
    drained: u64,
    link_max: f64,
    lock_max: f64,
    held: u64,
}

impl GestureRecorder {
    /// Starts at `t_ms`, the zoom then `z0`; `events` / `rebases`: the viewport's counters now;
    /// `hz`: the display's best rate (0 when the shell did not say).
    pub fn new(t_ms: f64, z0: f64, events: u64, rebases: u64, hz: f64) -> Self {
        GestureRecorder {
            start: t_ms,
            // Sized for a long gesture at 120 Hz: no allocation on the render thread's ticks.
            ticks: Vec::with_capacity(4096),
            drawn: 0,
            z0,
            events0: events,
            rebases0: rebases,
            glide: false,
            hz,
            trail: Vec::with_capacity(4096),
            alone: 0,
            work: Vec::with_capacity(4096),
            camera_max: 0.0,
            upload_max: 0.0,
            acquire_max: 0.0,
            gpu_late: 0,
            drained: 0,
            link_max: 0.0,
            lock_max: 0.0,
            held: 0,
        }
    }

    /// The camera moved this tick but the canvas's did not.
    pub fn held(&mut self, held: bool) {
        self.held += u64::from(held);
    }

    /// What the tick drew: `trail_ms` behind the newest camera, `alone` when the page's DOM was
    /// too far behind to be followed.
    pub fn placed(&mut self, trail_ms: f64, alone: bool) {
        if trail_ms.is_finite() {
            self.trail.push(trail_ms.max(0.0));
        }
        self.alone += usize::from(alone);
    }

    /// A display tick at `t_ms`; `drawn`: the canvas drew a frame in it.
    pub fn tick(&mut self, t_ms: f64, drawn: bool) {
        self.ticks.push(t_ms);
        if drawn {
            self.drawn += 1;
        }
    }

    /// The last tick's time on the render thread (ms): all of it, the camera's step, the uploads.
    pub fn work(&mut self, total: f64, camera: f64, upload: f64) {
        if total.is_finite() {
            self.work.push(total.max(0.0));
        }
        self.camera_max = self.camera_max.max(camera);
        self.upload_max = self.upload_max.max(upload);
    }

    /// How the tick's draw was paced: its wait for the canvas's lock and for a drawable (ms),
    /// skipped because the GPU was still on the previous frame, skipped to drain the display's
    /// queue.
    pub fn pace(&mut self, lock_ms: f64, acquire_ms: f64, gpu_late: bool, drained: bool) {
        if lock_ms.is_finite() {
            self.lock_max = self.lock_max.max(lock_ms);
        }
        if acquire_ms.is_finite() {
            self.acquire_max = self.acquire_max.max(acquire_ms);
        }
        self.gpu_late += u64::from(gpu_late);
        self.drained += u64::from(drained);
    }

    /// The display link's interval at a tick (ms).
    pub fn link(&mut self, duration_ms: f64) {
        if duration_ms.is_finite() {
            self.link_max = self.link_max.max(duration_ms);
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

    pub fn events0(&self) -> u64 {
        self.events0
    }

    pub fn ticks_len(&self) -> usize {
        self.ticks.len()
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
        let mut trail = self.trail.clone();
        trail.sort_by(|a, b| a.total_cmp(b));
        let trail_at = |q: f64| {
            trail
                .get((((trail.len() as f64) * q) as usize).min(trail.len().saturating_sub(1)))
                .copied()
                .unwrap_or(0.0)
        };
        let mut work = self.work.clone();
        work.sort_by(|a, b| a.total_cmp(b));
        let work_at = |q: f64| {
            work.get((((work.len() as f64) * q) as usize).min(work.len().saturating_sub(1)))
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
            trail_p50: r(trail_at(0.5)),
            trail_max: r(trail_at(1.0)),
            alone: self.alone,
            link_ms: 0.0,
            lead_ms: 0.0,
            work_p95: r(work_at(0.95)),
            work_max: r(work_at(1.0)),
            camera_max: r(self.camera_max),
            upload_max: r(self.upload_max),
            acquire_max: r(self.acquire_max),
            gpu_late: self.gpu_late,
            drained: self.drained,
            link_max: r(self.link_max),
            lock_max: r(self.lock_max),
            held: self.held,
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
    fn where_the_ticks_waited() {
        let mut r = GestureRecorder::new(0.0, 1.0, 0, 0, 120.0);
        r.pace(0.1, 0.02, false, false);
        r.pace(0.3, 8.41, false, false);
        r.pace(0.0, 0.0, false, true);
        r.pace(0.0, 0.0, true, false);
        r.link(8.33);
        r.link(16.67);
        r.held(true);
        r.held(false);
        r.tick(0.0, true);
        r.tick(8.3, false);
        let s = r.finish(1, 20.0, 1.0, 2, 0);
        assert_eq!((s.acquire_max, s.lock_max, s.link_max), (8.4, 0.3, 16.7));
        assert_eq!((s.gpu_late, s.drained, s.held), (1, 1, 1));
    }

    #[test]
    fn no_ticks_no_numbers() {
        let s = GestureRecorder::new(5.0, 1.0, 0, 0, 0.0).finish(1, 10.0, 1.0, 0, 0);
        assert_eq!((s.frames, s.fps, s.p95, s.ms), (0, 0.0, 0.0, 5.0));
    }
}
