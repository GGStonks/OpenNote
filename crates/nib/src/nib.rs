use crate::geometry::{InkPoint, ModeledPoint, XY, has_real_pressure, sample_times};

#[derive(Clone, Copy, Debug)]
pub struct NibParams {
    pub arc: f64,
    pub min_half: f64,
    pub max_half: f64,
    pub chord: f64,
    pub speed_win: f64,
    pub press_half: f64,
    pub attack: f64,
    pub release: f64,
    pub lift_force: f64,
    pub lift_ms: f64,
    pub lift_px: f64,
    pub step: f64,
}

pub const DEFAULT_NIB: NibParams = NibParams {
    arc: 5.0,
    min_half: 14.0,
    max_half: 70.0,
    chord: 6.0,
    speed_win: 8.0,
    press_half: 14.0,
    attack: 24.0,
    release: 60.0,
    lift_force: 0.6,
    lift_ms: 40.0,
    lift_px: 18.0,
    step: 0.5,
};

#[derive(Clone, Copy, Debug)]
struct Raw {
    x: f64,
    y: f64,
    t: f64,
    f: f64,
}

#[derive(Clone, Copy, Debug)]
struct Anchor {
    x: f64,
    y: f64,
    t: f64,
    p: f64,
    h: f64,
    cr: f64,
}

#[inline]
fn tricube(u: f64) -> f64 {
    let v = u.abs();
    let a = 1.0 - v * v * v;
    if a <= 0.0 {
        0.0
    } else {
        a * a * a
    }
}

#[derive(Clone, Debug)]
pub struct NibModeler {
    pub points: Vec<ModeledPoint>,
    raw: Vec<Raw>,
    anchors: Vec<Anchor>,
    emitted: usize,
    t0: f64,
    env: f64,
    attack_force: f64,
    forces: Vec<f64>,
    params: NibParams,
}

impl Default for NibModeler {
    fn default() -> Self {
        Self::new()
    }
}

impl NibModeler {
    pub fn new() -> Self {
        Self::with_params(DEFAULT_NIB)
    }

    pub fn with_params(params: NibParams) -> Self {
        Self {
            points: Vec::new(),
            raw: Vec::new(),
            anchors: Vec::new(),
            emitted: 0,
            t0: f64::NAN,
            env: -1.0,
            attack_force: -1.0,
            forces: Vec::new(),
            params,
        }
    }

    pub fn add(&mut self, x: f64, y: f64, t: f64, p: f64) {
        if self.t0.is_nan() {
            self.t0 = t;
        }
        let mut tt = t - self.t0;
        if let Some(last) = self.raw.last() {
            if tt <= last.t {
                tt = last.t + 0.25;
            }
        }
        let f = if p > 0.0 { p.min(1.0) } else { 0.0 };
        self.raw.push(Raw { x, y, t: tt, f });

        if f > 0.0 {
            let idx = match self.forces.binary_search_by(|val| val.partial_cmp(&f).unwrap()) {
                Ok(i) => i,
                Err(i) => i,
            };
            self.forces.insert(idx, f);
        }

        self.settle(false);
    }

    pub fn finish(&mut self) -> &[ModeledPoint] {
        let new_len = self.ink_end().max(self.anchors.len()).max(1);
        self.raw.truncate(new_len);
        self.settle(true);
        self.emit(true);
        &self.points
    }

    fn ink_end(&self) -> usize {
        let n = self.raw.len();
        if self.forces.is_empty() {
            return n;
        }
        let mut k = n;
        while k > 1 && !(self.raw[k - 1].f > 0.0) {
            k -= 1;
        }
        if k < 4 {
            return k;
        }

        let t_end = self.raw[k - 1].t;
        let mut s = k - 1;
        while s > 0
            && self.raw[s - 1].f > 0.0
            && self.raw[s - 1].f >= self.raw[s].f * 0.97
            && (t_end - self.raw[s - 1].t) <= self.params.lift_ms
        {
            s -= 1;
        }

        let limit = self.params.lift_force * self.raw[s].f;
        let mut len = 0.0;
        while k > (s + 1).max(2) {
            let i = k - 1;
            if self.raw[i].f >= limit {
                break;
            }
            len += (self.raw[i].x - self.raw[i - 1].x).hypot(self.raw[i].y - self.raw[i - 1].y);
            if len > self.params.lift_px {
                break;
            }
            k -= 1;
        }
        k
    }

    pub fn tail(&self) -> Vec<ModeledPoint> {
        if self.raw.is_empty() {
            return Vec::new();
        }
        let n = self.ink_end();
        let mut provisional: Vec<Anchor> = Vec::new();
        let mut env = self.env;
        let latest = self.raw.last().unwrap().t;

        for i in self.anchors.len()..n {
            let a = self.fit_anchor(i, &provisional, env);
            env = a.p;
            let q = self.provisional(a.x, a.y, self.raw[i].x, self.raw[i].y, a.t, a.h, latest);
            provisional.push(Anchor {
                x: q.x,
                y: q.y,
                ..a
            });
        }

        let all: Vec<Anchor> = if provisional.is_empty() {
            self.anchors.clone()
        } else {
            self.anchors.iter().cloned().chain(provisional).collect()
        };

        let mut out: Vec<ModeledPoint> = Vec::new();
        for i in self.emitted.max(1)..all.len() {
            let lat = if i >= self.anchors.len().saturating_sub(1) {
                Some(latest)
            } else {
                None
            };
            self.segment(&all, i, true, &mut out, lat);
        }

        if self.emitted == 0 && !all.is_empty() {
            out.insert(0, self.point(&all[0]));
        }

        out
    }

    fn speed_at(&self, i: usize) -> f64 {
        let r = &self.raw;
        let ti = r[i].t;
        let mut a = i;
        let mut b = i;
        while a > 0 && ti - r[a - 1].t <= self.params.speed_win {
            a -= 1;
        }
        while b < r.len() - 1 && r[b + 1].t - ti <= self.params.speed_win {
            b += 1;
        }
        let dt = r[b].t - r[a].t;
        if dt > 0.0 {
            (r[b].x - r[a].x).hypot(r[b].y - r[a].y) / dt
        } else {
            0.0
        }
    }

    fn half_window(&self, i: usize) -> f64 {
        let v = self.speed_at(i);
        self.params.min_half.max(self.params.max_half.min(if v > 0.0 {
            self.params.arc / v
        } else {
            self.params.max_half
        }))
    }

    fn settle(&mut self, final_flag: bool) {
        if self.raw.is_empty() {
            return;
        }
        let latest = self.raw.last().unwrap().t;
        let end = if final_flag {
            self.raw.len()
        } else {
            self.ink_end()
        };

        while self.anchors.len() < end {
            let i = self.anchors.len();
            if !final_flag {
                let ti = self.raw[i].t;
                if latest < ti + self.params.speed_win {
                    break;
                }
                if latest < ti + self.half_window(i).max(self.params.press_half) {
                    break;
                }
                if ti < self.params.attack && latest < self.params.attack + self.params.press_half {
                    break;
                }
            }
            let a = self.fit_anchor(i, &[], self.env);
            self.env = a.p;
            self.anchors.push(a);
        }
        self.emit(false);
    }

    fn fit_anchor(&self, i: usize, _pending: &[Anchor], prev_env: f64) -> Anchor {
        let r = &self.raw;
        let ti = r[i].t;
        let h = self.half_window(i);
        let cr = self.params.chord.max(1.2 * self.speed_at(i) * h);
        let pos = self.smooth_at(ti, r[i].x, r[i].y, i, h, cr);

        let mut pa = i;
        let mut pb = i;
        while pa > 0 && ti - r[pa - 1].t < self.params.press_half {
            pa -= 1;
        }
        while pb < r.len() - 1 && r[pb + 1].t - ti < self.params.press_half {
            pb += 1;
        }

        let mut sw = 0.0;
        let mut sf = 0.0;
        for j in pa..=pb {
            if !(r[j].f > 0.0) {
                continue;
            }
            let w = tricube((r[j].t - ti) / self.params.press_half) + 1e-6;
            sw += w;
            sf += w * r[j].f;
        }

        let mut p = if sw > 0.0 {
            sf / sw
        } else if prev_env >= 0.0 {
            prev_env
        } else {
            0.5
        };

        if ti < self.params.attack {
            p = p.max(self.landing_force());
        }

        if prev_env >= 0.0 && p < prev_env {
            let dt = if i > 0 { ti - r[i - 1].t } else { 0.0 };
            p = p + (prev_env - p) * (-dt / self.params.release).exp();
        }

        Anchor {
            x: pos.x,
            y: pos.y,
            t: ti,
            p,
            h,
            cr,
        }
    }

    fn smooth_at(&self, t: f64, cx: f64, cy: f64, c: usize, h: f64, cr: f64) -> XY {
        let r = &self.raw;
        let cr2 = cr * cr;
        let near = |j: usize| {
            let dx = r[j].x - cx;
            let dy = r[j].y - cy;
            dx * dx + dy * dy < cr2
        };

        let mut a = c;
        let mut b = c;
        while a > 0 && (t - r[a - 1].t < h) && near(a - 1) {
            a -= 1;
        }
        while b < r.len() - 1 && (r[b + 1].t - t < h) && near(b + 1) {
            b += 1;
        }

        fit_at(r, a, b, t, h, cx, cy, cr)
    }

    fn landing_force(&self) -> f64 {
        if self.attack_force >= 0.0 {
            return self.attack_force;
        }
        let r = &self.raw;
        let mut fs = Vec::new();
        for s in r {
            if s.t > self.params.attack + self.params.press_half {
                break;
            }
            if s.f > 0.0 {
                fs.push(s.f);
            }
        }
        if fs.is_empty() {
            return 0.0;
        }
        fs.sort_by(|x, y| x.partial_cmp(y).unwrap());
        let idx = (fs.len() - 1).min(((fs.len() as f64) * 0.75).floor() as usize);
        let v = fs[idx];
        v
    }

    fn point(&self, a: &Anchor) -> ModeledPoint {
        ModeledPoint {
            x: a.x,
            y: a.y,
            p: a.p,
            t: a.t,
        }
    }

    fn emit(&mut self, final_flag: bool) {
        if self.anchors.is_empty() {
            return;
        }
        if self.emitted == 0 {
            self.points.push(self.point(&self.anchors[0]));
            self.emitted = 1;
        }
        let mut new_points = Vec::new();
        while self.emitted < self.anchors.len() && (final_flag || self.emitted + 1 < self.anchors.len()) {
            let last_seg = final_flag && self.emitted == self.anchors.len() - 1;
            self.segment(&self.anchors, self.emitted, last_seg, &mut new_points, None);
            self.emitted += 1;
        }
        self.points.extend(new_points);
    }

    fn segment(
        &self,
        anchors: &[Anchor],
        i: usize,
        _last: bool,
        out: &mut Vec<ModeledPoint>,
        latest: Option<f64>,
    ) {
        let p1 = &anchors[i - 1];
        let p2 = &anchors[i];
        let r = &self.raw;
        let len = (p2.x - p1.x).hypot(p2.y - p1.y);
        let n = 1.max((len / self.params.step).ceil() as usize);

        for s in 1..n {
            let f = s as f64 / n as f64;
            let t = p1.t + (p2.t - p1.t) * f;
            let cx = r[i - 1].x + (r[i].x - r[i - 1].x) * f;
            let cy = r[i - 1].y + (r[i].y - r[i - 1].y) * f;
            let h = p1.h + (p2.h - p1.h) * f;
            let cr = p1.cr + (p2.cr - p1.cr) * f;
            let mut q = self.smooth_at(t, cx, cy, if f < 0.5 { i - 1 } else { i }, h, cr);
            if let Some(lat) = latest {
                q = self.provisional(q.x, q.y, cx, cy, t, h, lat);
            }
            out.push(ModeledPoint::new(q.x, q.y, p1.p + (p2.p - p1.p) * f, t));
        }
        out.push(self.point(p2));
    }

    fn provisional(&self, fx: f64, fy: f64, rx: f64, ry: f64, t: f64, h: f64, latest: f64) -> XY {
        let c = (0.0f64).max((1.0f64).min((latest - t) / (1e-6f64).max(h)));
        let k = c * c * (3.0 - 2.0 * c);
        XY::new(rx + (fx - rx) * k, ry + (fy - ry) * k)
    }
}

fn fit_at(r: &[Raw], a: usize, b: usize, tc: f64, h: f64, cx: f64, cy: f64, cr: f64) -> XY {
    if a == b {
        return XY::new(r[a].x, r[a].y);
    }
    let mut before = 0;
    let mut after = 0;
    for j in a..=b {
        if r[j].t < tc - 1e-6 {
            before += 1;
        } else if r[j].t > tc + 1e-6 {
            after += 1;
        }
    }
    let degree = if before >= 2 && after >= 2 { 2 } else { 1 };
    poly_fit0(r, a, b, tc, h, degree, cx, cy, cr)
}

fn poly_fit0(
    r: &[Raw],
    a: usize,
    b: usize,
    tc: f64,
    h: f64,
    degree: usize,
    nx: f64,
    ny: f64,
    nr: f64,
) -> XY {
    let m = degree + 1;
    let w2 = 2 * m - 1;
    let cols = m + 2;

    let mut s = [0.0f64; 5];
    let mut x_rhs = [0.0f64; 3];
    let mut y_rhs = [0.0f64; 3];

    for j in a..=b {
        let u = (r[j].t - tc) / h;
        let mut w = tricube(u * 0.999);
        let ex = r[j].x - nx;
        let ey = r[j].y - ny;
        w *= tricube((0.999 * (ex * ex + ey * ey).sqrt()) / nr);
        w += 1e-9;
        let mut pw = w;
        for k in 0..w2 {
            s[k] += pw;
            if k < m {
                x_rhs[k] += pw * r[j].x;
                y_rhs[k] += pw * r[j].y;
            }
            pw *= u;
        }
    }

    let mut a_mat = [0.0f64; 15]; // 3 rows * 5 cols
    for i in 0..m {
        for k in 0..m {
            a_mat[i * cols + k] = s[i + k];
        }
        a_mat[i * cols + m] = x_rhs[i];
        a_mat[i * cols + m + 1] = y_rhs[i];
    }

    for c in 0..m {
        let mut piv = c;
        for rr in c + 1..m {
            if a_mat[rr * cols + c].abs() > a_mat[piv * cols + c].abs() {
                piv = rr;
            }
        }
        if a_mat[piv * cols + c].abs() < 1e-10 {
            // Degenerate (all samples at one time): weighted mean.
            return XY::new(x_rhs[0] / s[0], y_rhs[0] / s[0]);
        }
        if piv != c {
            for k in 0..cols {
                let tmp = a_mat[c * cols + k];
                a_mat[c * cols + k] = a_mat[piv * cols + k];
                a_mat[piv * cols + k] = tmp;
            }
        }
        for rr in 0..m {
            if rr == c {
                continue;
            }
            let factor = a_mat[rr * cols + c] / a_mat[c * cols + c];
            for k in c..cols {
                a_mat[rr * cols + k] -= factor * a_mat[c * cols + k];
            }
        }
    }

    XY::new(a_mat[m] / a_mat[0], a_mat[m + 1] / a_mat[0])
}

pub fn nib_stroke(points: &[InkPoint]) -> Vec<ModeledPoint> {
    if points.is_empty() {
        return Vec::new();
    }
    let mut m = NibModeler::new();
    let times = sample_times(points);
    let real = has_real_pressure(points);
    for (i, p) in points.iter().enumerate() {
        m.add(p.x, p.y, times[i], if real { p.pressure } else { 0.5 });
    }
    m.finish().to_vec()
}
