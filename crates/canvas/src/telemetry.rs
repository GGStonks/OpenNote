//! Frame pacing and GPU telemetry ring buffer (last 240 frames).
//!
//! Tracks frame delta time, CPU preparation duration, GPU encode time, bytes uploaded,
//! and draw call count, providing statistical summaries (p50, p95, p99, max, dropped %).

pub const TELEMETRY_CAPACITY: usize = 240;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct FrameSample {
    pub frame_dt_us: u64,
    pub cpu_prepare_us: u64,
    pub gpu_encode_us: u64,
    pub bytes_uploaded: u64,
    pub draw_calls: u32,
}

#[derive(Clone, Debug)]
pub struct FrameStats {
    samples: Vec<FrameSample>,
    capacity: usize,
    head: usize,
    count: usize,
    target_budget_us: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct StatsSummary {
    pub p50_cpu_us: f64,
    pub p95_cpu_us: f64,
    pub p99_cpu_us: f64,
    pub max_cpu_us: u64,
    pub p50_dt_us: f64,
    pub p95_dt_us: f64,
    pub p99_dt_us: f64,
    pub max_dt_us: u64,
    pub avg_bytes_uploaded: f64,
    pub avg_draw_calls: f64,
    pub dropped_frame_pct: f64,
}

impl Default for FrameStats {
    fn default() -> Self {
        Self::new(TELEMETRY_CAPACITY, 8333) // default to 120 Hz (8.33 ms)
    }
}

impl FrameStats {
    pub fn new(capacity: usize, target_budget_us: u64) -> Self {
        Self {
            samples: vec![FrameSample::default(); capacity],
            capacity,
            head: 0,
            count: 0,
            target_budget_us,
        }
    }

    pub fn set_target_budget_us(&mut self, us: u64) {
        self.target_budget_us = us;
    }

    pub fn record(&mut self, sample: FrameSample) {
        self.samples[self.head] = sample;
        self.head = (self.head + 1) % self.capacity;
        if self.count < self.capacity {
            self.count += 1;
        }
    }

    pub fn len(&self) -> usize {
        self.count
    }

    pub fn is_empty(&self) -> bool {
        self.count == 0
    }

    pub fn active_samples(&self) -> Vec<FrameSample> {
        let mut out = Vec::with_capacity(self.count);
        if self.count < self.capacity {
            out.extend_from_slice(&self.samples[..self.count]);
        } else {
            // In ring order: oldest to newest
            out.extend_from_slice(&self.samples[self.head..]);
            out.extend_from_slice(&self.samples[..self.head]);
        }
        out
    }

    pub fn summarize(&self) -> StatsSummary {
        if self.count == 0 {
            return StatsSummary::default();
        }

        let samples = self.active_samples();
        let n = samples.len();

        let mut cpu_times: Vec<u64> = samples.iter().map(|s| s.cpu_prepare_us).collect();
        let mut dt_times: Vec<u64> = samples.iter().map(|s| s.frame_dt_us).collect();
        cpu_times.sort_unstable();
        dt_times.sort_unstable();

        let percentile = |slice: &[u64], p: f64| -> f64 {
            if slice.is_empty() {
                return 0.0;
            }
            let idx = ((slice.len() - 1) as f64 * p).round() as usize;
            slice[idx.min(slice.len() - 1)] as f64
        };

        let total_bytes: u64 = samples.iter().map(|s| s.bytes_uploaded).sum();
        let total_draws: u32 = samples.iter().map(|s| s.draw_calls).sum();
        let dropped = samples
            .iter()
            .filter(|s| s.frame_dt_us > self.target_budget_us)
            .count();

        StatsSummary {
            p50_cpu_us: percentile(&cpu_times, 0.50),
            p95_cpu_us: percentile(&cpu_times, 0.95),
            p99_cpu_us: percentile(&cpu_times, 0.99),
            max_cpu_us: *cpu_times.last().unwrap_or(&0),
            p50_dt_us: percentile(&dt_times, 0.50),
            p95_dt_us: percentile(&dt_times, 0.95),
            p99_dt_us: percentile(&dt_times, 0.99),
            max_dt_us: *dt_times.last().unwrap_or(&0),
            avg_bytes_uploaded: total_bytes as f64 / n as f64,
            avg_draw_calls: total_draws as f64 / n as f64,
            dropped_frame_pct: (dropped as f64 / n as f64) * 100.0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_buffer_recording_and_summary() {
        let mut stats = FrameStats::new(10, 8333);
        assert_eq!(stats.len(), 0);

        for i in 1..=15 {
            stats.record(FrameSample {
                frame_dt_us: 8000 + i * 50,
                cpu_prepare_us: 500 + i * 20,
                gpu_encode_us: 300,
                bytes_uploaded: 1024,
                draw_calls: 2,
            });
        }
        assert_eq!(stats.len(), 10);
        let summary = stats.summarize();
        assert!(summary.p50_cpu_us > 0.0);
        assert!(summary.p99_cpu_us >= summary.p50_cpu_us);
        assert_eq!(summary.avg_draw_calls, 2.0);
        assert_eq!(summary.avg_bytes_uploaded, 1024.0);
    }
}
