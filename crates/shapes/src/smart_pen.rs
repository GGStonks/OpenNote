use std::collections::HashMap;
use std::f64::consts::PI;

use ink::{ink_geometry, stroke_hit_test, stroke_width, SampleDensifier};
use model::{LineStyle, NotePage, PenStyle, Point, ShapeKind, Stroke};
use nib::geometry::{JsMath, XY};

use crate::edit::{drag_handle, ellipse_points, HandleRole, ShapeHandle};
use crate::recognition::{detect_shape, SnappedShape};
use crate::selection::{lasso_select_page, PageSelection};

pub const PEN_HOLD_MS: f64 = 1000.0;
pub const SHAPE_HOLD_MS: f64 = 450.0;
pub const STANDSTILL_DIST: f64 = 3.0;

pub const PX_PER_CM: f64 = 96.0 / 2.54;
pub const POINT_SNAP: f64 = 20.0;
pub const EDGE_SNAP: f64 = 16.0;
pub const CLOSE_DISTANCE: f64 = 18.0;
pub const CIRCLE_LOCK: f64 = 30.0;
pub const GRID_SNAP: f64 = 12.0;
pub const VERTEX_RELEASE: f64 = 40.0;
const AXIS_SNAP: f64 = (4.0 * PI) / 180.0;
const MAX_INTERSECTIONS: usize = 4000;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum SmartPenTool {
    Pen,
    Highlighter,
    Eraser,
    Lasso,
    Shape(ShapeMode),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ShapeMode {
    Curve,
    Line,
    Rectangle,
    Ellipse,
    Point,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PenSample {
    pub x: f64,
    pub y: f64,
    pub t: f64,
    pub pressure: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SnapAdjust {
    pub kind: ShapeKind,
    pub base: Vec<Point>,
    pub closed: bool,
    pub pen0: XY,
    pub regular: bool,
}

fn p_like(p: XY, like: &Point) -> Point {
    Point {
        x: p.x,
        y: p.y,
        pressure: like.pressure,
        t: like.t,
        alt: like.alt,
        az: like.az,
    }
}

fn centroid(pts: &[Point]) -> XY {
    if pts.is_empty() {
        return XY { x: 0.0, y: 0.0 };
    }
    let mut x = 0.0;
    let mut y = 0.0;
    for p in pts {
        x += p.x;
        y += p.y;
    }
    XY {
        x: x / pts.len() as f64,
        y: y / pts.len() as f64,
    }
}

fn dist(a: XY, b: XY) -> f64 {
    (a.x - b.x).js_hypot(a.y - b.y)
}

fn mid(a: XY, b: XY) -> XY {
    XY {
        x: (a.x + b.x) / 2.0,
        y: (a.y + b.y) / 2.0,
    }
}

fn project(p: XY, a: XY, b: XY) -> XY {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let l2 = dx * dx + dy * dy;
    if l2 == 0.0 {
        return a;
    }
    let t = (((p.x - a.x) * dx + (p.y - a.y) * dy) / l2).clamp(0.0, 1.0);
    XY {
        x: a.x + t * dx,
        y: a.y + t * dy,
    }
}

fn intersect(p1: XY, p2: XY, p3: XY, p4: XY) -> Option<XY> {
    let d = (p1.x - p2.x) * (p3.y - p4.y) - (p1.y - p2.y) * (p3.x - p4.x);
    if d.abs() < 1e-9 {
        return None;
    }
    let t = ((p1.x - p3.x) * (p3.y - p4.y) - (p1.y - p3.y) * (p3.x - p4.x)) / d;
    let u = -((p1.x - p2.x) * (p1.y - p3.y) - (p1.y - p2.y) * (p1.x - p3.x)) / d;
    if !(0.0..=1.0).contains(&t) || !(0.0..=1.0).contains(&u) {
        return None;
    }
    Some(XY {
        x: p1.x + t * (p2.x - p1.x),
        y: p1.y + t * (p2.y - p1.y),
    })
}

/// Median width calculated by `ink_geometry` and adjusted for `is_shape`.
pub fn snap_width(stroke: &Stroke) -> f64 {
    let g = ink_geometry(&stroke.points, stroke);
    let ws = if let Some(mut w) = g.widths {
        w.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        w
    } else {
        Vec::new()
    };
    let drawn = if !ws.is_empty() {
        ws[ws.len() >> 1]
    } else {
        g.width
    };
    let mut shape_style = stroke.clone();
    shape_style.is_shape = Some(true);
    (drawn / stroke_width(&shape_style)) * stroke.width
}

/// Sizing adjusted shape according to `SnapAdjust`, preserving regularity if specified.
pub fn adjust_snapped_shape(a: &SnapAdjust, pen: XY) -> Vec<Point> {
    let pts = &a.base;
    if pts.is_empty() {
        return Vec::new();
    }
    match a.kind {
        ShapeKind::Line => {
            let s0 = pts[0];
            let mut end = pen;
            let ang = (pen.y - s0.y).atan2(pen.x - s0.x);
            for t in [0.0, PI / 2.0, PI, -PI / 2.0, -PI] {
                if (ang - t).abs() < AXIS_SNAP {
                    end = if t.sin().abs() > 0.5 {
                        XY { x: s0.x, y: pen.y }
                    } else {
                        XY { x: pen.x, y: s0.y }
                    };
                }
            }
            vec![
                pts[0],
                p_like(end, if pts.len() > 1 { &pts[1] } else { &pts[0] }),
            ]
        }
        ShapeKind::Arrow => {
            let as_stroke = Stroke {
                id: String::new(),
                tool: "pen".to_string(),
                points: pts.clone(),
                is_shape: Some(true),
                shape_kind: Some(ShapeKind::Arrow),
                closed: Some(a.closed),
                ..Default::default()
            };
            let handle = ShapeHandle {
                x: if pts.len() > 1 { pts[1].x } else { pts[0].x },
                y: if pts.len() > 1 { pts[1].y } else { pts[0].y },
                role: HandleRole::Vertex,
                index: 1,
                anchor: None,
            };
            drag_handle(&as_stroke, &handle, pen).points
        }
        ShapeKind::Circle | ShapeKind::Ellipse => {
            let c = centroid(pts);
            let n = pts.len();
            let ua = XY {
                x: pts[0].x - c.x,
                y: pts[0].y - c.y,
            };
            let ra = ua.x.js_hypot(ua.y).max(1.0);
            let qb = pts[((n as f64 / 4.0).round() as usize) % n];
            let rb = (qb.x - c.x).js_hypot(qb.y - c.y).max(1.0);
            let u = XY {
                x: ua.x / ra,
                y: ua.y / ra,
            };
            let v = XY { x: -u.y, y: u.x };

            if a.kind == ShapeKind::Circle {
                let k = (pen.x - c.x).js_hypot(pen.y - c.y)
                    / (a.pen0.x - c.x).js_hypot(a.pen0.y - c.y).max(1.0);
                return ellipse_points(
                    c,
                    XY {
                        x: ua.x * k,
                        y: ua.y * k,
                    },
                    ra * k,
                    n,
                );
            }

            let along = |q: XY, d: XY| ((q.x - c.x) * d.x + (q.y - c.y) * d.y).abs();
            let su = along(pen, u) / along(a.pen0, u).max(0.35 * ra);
            let sv = along(pen, v) / along(a.pen0, v).max(0.35 * rb);
            let na = (ra * su).max(2.0);
            let nb = (rb * sv).max(2.0);
            ellipse_points(
                c,
                XY {
                    x: u.x * na,
                    y: u.y * na,
                },
                nb,
                n,
            )
        }
        ShapeKind::Rectangle => {
            let c = centroid(pts);
            if a.regular {
                let k = (pen.x - c.x).js_hypot(pen.y - c.y)
                    / (a.pen0.x - c.x).js_hypot(a.pen0.y - c.y).max(4.0);
                return pts
                    .iter()
                    .map(|q| {
                        p_like(
                            XY {
                                x: c.x + (q.x - c.x) * k,
                                y: c.y + (q.y - c.y) * k,
                            },
                            q,
                        )
                    })
                    .collect();
            }
            if pts.len() < 2 {
                return pts.clone();
            }
            let l = (pts[1].x - pts[0].x).js_hypot(pts[1].y - pts[0].y).max(1.0);
            let u = XY {
                x: (pts[1].x - pts[0].x) / l,
                y: (pts[1].y - pts[0].y) / l,
            };
            let v = XY { x: -u.y, y: u.x };
            let loc = |q: XY| XY {
                x: (q.x - c.x) * u.x + (q.y - c.y) * u.y,
                y: (q.x - c.x) * v.x + (q.y - c.y) * v.y,
            };
            let mut hw = 1.0f64;
            let mut hh = 1.0f64;
            for q in pts {
                let lq = loc(XY { x: q.x, y: q.y });
                hw = hw.max(lq.x.abs());
                hh = hh.max(lq.y.abs());
            }
            let p0 = loc(a.pen0);
            let p1 = loc(pen);
            let sx = p1.x.abs() / p0.x.abs().max(0.35 * hw);
            let sy = p1.y.abs() / p0.y.abs().max(0.35 * hh);
            pts.iter()
                .map(|q| {
                    let lq = loc(XY { x: q.x, y: q.y });
                    let x = lq.x * sx;
                    let y = lq.y * sy;
                    p_like(
                        XY {
                            x: c.x + x * u.x + y * v.x,
                            y: c.y + x * u.y + y * v.y,
                        },
                        q,
                    )
                })
                .collect()
        }
        _ => {
            let c = if a.closed {
                centroid(pts)
            } else {
                XY {
                    x: pts[0].x,
                    y: pts[0].y,
                }
            };
            let d0 = XY {
                x: a.pen0.x - c.x,
                y: a.pen0.y - c.y,
            };
            let d1 = XY {
                x: pen.x - c.x,
                y: pen.y - c.y,
            };
            let l0 = d0.x.js_hypot(d0.y);
            if l0 < 4.0 {
                return pts.clone();
            }
            let k = d1.x.js_hypot(d1.y) / l0;
            let rot = d1.y.atan2(d1.x) - d0.y.atan2(d0.x);
            let cs = rot.cos() * k;
            let sn = rot.sin() * k;
            pts.iter()
                .map(|q| {
                    p_like(
                        XY {
                            x: c.x + (q.x - c.x) * cs - (q.y - c.y) * sn,
                            y: c.y + (q.x - c.x) * sn + (q.y - c.y) * cs,
                        },
                        q,
                    )
                })
                .collect()
        }
    }
}

/// Generates points along the snapped shape for the eraser to clear.
pub fn erase_along_snapped_points(points: &[Point], closed: bool, eraser_size: f64) -> Vec<Point> {
    if points.is_empty() {
        return Vec::new();
    }
    let mut pts = points.to_vec();
    if closed && pts.len() > 1 {
        pts.push(pts[0]);
    }
    let step = (eraser_size * 0.5).max(1.0);
    let mut at = vec![pts[0]];
    for i in 1..pts.len() {
        let a = pts[i - 1];
        let b = pts[i];
        let m = ((b.x - a.x).js_hypot(b.y - a.y) / step).ceil().max(1.0) as usize;
        for k in 1..=m {
            let frac = k as f64 / m as f64;
            at.push(Point {
                x: a.x + (b.x - a.x) * frac,
                y: a.y + (b.y - a.y) * frac,
                pressure: 0.5,
                t: None,
                alt: None,
                az: None,
            });
        }
    }
    at
}

/// Evaluates `eraseAlongSnapped` on a given `NotePage`.
/// Returns `(erased_stroke_ids, put_back_stroke_ids)`.
/// - `erased`: strokes hit by the snapped shape outline.
/// - `put_back`: strokes hit by the drawn line before snapping.
pub fn erase_along_snapped_page(
    snapped_points: &[Point],
    closed: bool,
    drawn_points: &[XY],
    eraser_size: f64,
    page: &NotePage,
) -> (Vec<String>, Vec<String>) {
    let mut put_back = Vec::new();
    let mut erased = Vec::new();

    let path = erase_along_snapped_points(snapped_points, closed, eraser_size);

    for stroke in &page.strokes {
        let hit_drawn = drawn_points
            .iter()
            .any(|s| stroke_hit_test(stroke, s.x, s.y, eraser_size));
        if hit_drawn {
            put_back.push(stroke.id.clone());
        }

        let hit_snapped = path
            .iter()
            .any(|p| stroke_hit_test(stroke, p.x, p.y, eraser_size));
        if hit_snapped {
            erased.push(stroke.id.clone());
        }
    }

    put_back.sort();
    erased.sort();
    (erased, put_back)
}

/// Performs lasso selection of page items using the snapped shape boundary.
pub fn lasso_select_with_snapped_shape(points: &[Point], page: &NotePage) -> PageSelection {
    let lasso_xy: Vec<XY> = points.iter().map(|p| XY { x: p.x, y: p.y }).collect();
    lasso_select_page(&lasso_xy, page)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Edge {
    pub a: XY,
    pub b: XY,
    pub owner: usize,
}

#[derive(Clone, Debug, Default)]
pub struct SnapCache {
    pub points: Vec<XY>,
    pub intersections: Vec<XY>,
    pub edges: Vec<Edge>,
    pub grid: Option<f64>,
    pub edge_index: Option<HashMap<String, Vec<usize>>>,
}

pub fn build_snap_cache(strokes: &[Stroke], grid: Option<f64>) -> SnapCache {
    let mut points = Vec::new();
    let mut edges = Vec::new();

    for (owner, s) in strokes.iter().enumerate() {
        if s.is_shape != Some(true) || s.tool != "pen" || s.points.is_empty() {
            continue;
        }
        let pts = &s.points;
        let closed = s.closed.unwrap_or(false) && pts.len() > 2;
        let kind = s.shape_kind.unwrap_or(ShapeKind::Polyline);

        if kind == ShapeKind::Point {
            points.push(XY {
                x: pts[0].x,
                y: pts[0].y,
            });
            continue;
        }
        if kind == ShapeKind::Ellipse || kind == ShapeKind::Circle {
            let n = pts.len();
            points.push(centroid(pts));
            for k in 0..8 {
                let idx = ((k * n) as f64 / 8.0).round() as usize % n;
                points.push(XY {
                    x: pts[idx].x,
                    y: pts[idx].y,
                });
            }
            for i in 0..n {
                let next = (i + 1) % n;
                edges.push(Edge {
                    a: XY {
                        x: pts[i].x,
                        y: pts[i].y,
                    },
                    b: XY {
                        x: pts[next].x,
                        y: pts[next].y,
                    },
                    owner,
                });
            }
            continue;
        }

        let verts = if kind == ShapeKind::Arrow && pts.len() >= 2 {
            &pts[0..2]
        } else {
            pts.as_slice()
        };

        let mut segs = Vec::new();
        for i in 1..verts.len() {
            segs.push((
                XY {
                    x: verts[i - 1].x,
                    y: verts[i - 1].y,
                },
                XY {
                    x: verts[i].x,
                    y: verts[i].y,
                },
            ));
        }
        if closed && kind != ShapeKind::Arrow && !verts.is_empty() {
            segs.push((
                XY {
                    x: verts[verts.len() - 1].x,
                    y: verts[verts.len() - 1].y,
                },
                XY {
                    x: verts[0].x,
                    y: verts[0].y,
                },
            ));
        }

        for (a, b) in &segs {
            points.push(mid(*a, *b));
            edges.push(Edge {
                a: *a,
                b: *b,
                owner,
            });
        }
        for v in verts {
            points.push(XY { x: v.x, y: v.y });
        }
        if closed {
            points.push(centroid(verts));
        }
    }

    let mut intersections = Vec::new();
    'outer: for i in 0..edges.len() {
        let e = edges[i];
        for j in (i + 1)..edges.len() {
            let f = edges[j];
            if f.owner == e.owner {
                continue;
            }
            if let Some(p) = intersect(e.a, e.b, f.a, f.b) {
                if let Some(last) = intersections.last() {
                    if dist(*last, p) < 0.5 {
                        continue;
                    }
                }
                intersections.push(p);
                if intersections.len() >= MAX_INTERSECTIONS {
                    break 'outer;
                }
            }
        }
    }

    SnapCache {
        points,
        intersections,
        edges,
        grid,
        edge_index: None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SnapTarget {
    pub at: XY,
    pub is_grid: bool,
    pub via_point: bool,
}

pub fn find_snap_kind(
    cache: &SnapCache,
    p: XY,
    zoom: f64,
    avoid: Option<XY>,
) -> Option<SnapTarget> {
    let k = 1.0 / zoom.max(0.3);
    let point_thr = POINT_SNAP * k;
    let edge_thr = EDGE_SNAP * k;
    let release = VERTEX_RELEASE * k;

    let mut best: Option<XY> = None;
    let mut via_point = true;
    let mut score = f64::INFINITY;

    for &q in &cache.intersections {
        let d = dist(p, q);
        if d < point_thr && d < score {
            best = Some(q);
            score = d;
            via_point = true;
        }
    }
    for &q in &cache.points {
        let d = dist(p, q);
        if d < point_thr && (d - 0.8 * k) < score {
            best = Some(q);
            score = d - 0.8 * k;
            via_point = true;
        }
    }
    for e in &cache.edges {
        let min_x = e.a.x.min(e.b.x) - edge_thr;
        let max_x = e.a.x.max(e.b.x) + edge_thr;
        let min_y = e.a.y.min(e.b.y) - edge_thr;
        let max_y = e.a.y.max(e.b.y) + edge_thr;
        if p.x < min_x || p.x > max_x || p.y < min_y || p.y > max_y {
            continue;
        }
        let q = project(p, e.a, e.b);
        if let Some(av) = avoid {
            if dist(q, av) < release {
                continue;
            }
        }
        let d = dist(p, q);
        if d < edge_thr && (d + 0.5 * k) < score {
            best = Some(q);
            score = d + 0.5 * k;
            via_point = false;
        }
    }

    if let Some(b) = best {
        return Some(SnapTarget {
            at: b,
            is_grid: false,
            via_point,
        });
    }

    if let Some(g) = cache.grid {
        let q = XY {
            x: (p.x / g).round() * g,
            y: (p.y / g).round() * g,
        };
        if dist(p, q) < (g * 0.3).min(GRID_SNAP * k) {
            return Some(SnapTarget {
                at: q,
                is_grid: true,
                via_point: true,
            });
        }
    }

    None
}

pub fn find_snap(cache: &SnapCache, p: XY, zoom: f64) -> Option<XY> {
    find_snap_kind(cache, p, zoom, None).map(|t| t.at)
}

#[derive(Clone, Debug)]
pub struct SmartPenConfig {
    pub tool: SmartPenTool,
    pub color: String,
    pub width: f64,
    pub pen_style: PenStyle,
    pub line_style: LineStyle,
    pub eraser_size: f64,
    pub hold_threshold_ms: Option<f64>,
    pub zoom: f64,
}

impl Default for SmartPenConfig {
    fn default() -> Self {
        Self {
            tool: SmartPenTool::Pen,
            color: "#000".to_string(),
            width: 2.0,
            pen_style: PenStyle::Fountain,
            line_style: LineStyle::Solid,
            eraser_size: 16.0,
            hold_threshold_ms: None,
            zoom: 1.0,
        }
    }
}

/// Pure SmartPen state machine fed timestamped samples with no clock of its own.
pub struct SmartPen {
    config: SmartPenConfig,
    points: Vec<Point>,
    samples: Vec<PenSample>,
    densifier: SampleDensifier,

    last_move: Option<XY>,
    last_move_t: f64,
    hold_threshold_ms: f64,

    snapped: bool,
    snapped_sample: Option<usize>,
    snapped_shape: Option<SnappedShape>,
    snapped_stroke: Option<Stroke>,
    adjust: Option<SnapAdjust>,
    erased_path: Option<Vec<Point>>,
    pub drawn_samples: Vec<XY>,
}

impl SmartPen {
    pub fn new(config: SmartPenConfig) -> Self {
        let threshold = config.hold_threshold_ms.unwrap_or(match config.tool {
            SmartPenTool::Shape(ShapeMode::Curve) => SHAPE_HOLD_MS,
            _ => PEN_HOLD_MS,
        });

        Self {
            config,
            points: Vec::new(),
            samples: Vec::new(),
            densifier: SampleDensifier::new(),
            last_move: None,
            last_move_t: 0.0,
            hold_threshold_ms: threshold,
            snapped: false,
            snapped_sample: None,
            snapped_shape: None,
            snapped_stroke: None,
            adjust: None,
            erased_path: None,
            drawn_samples: Vec::new(),
        }
    }

    pub fn is_snapped(&self) -> bool {
        self.snapped
    }

    pub fn snapped_sample(&self) -> Option<usize> {
        self.snapped_sample
    }

    pub fn snapped_stroke(&self) -> Option<&Stroke> {
        self.snapped_stroke.as_ref()
    }

    pub fn snapped_shape(&self) -> Option<&SnappedShape> {
        self.snapped_shape.as_ref()
    }

    pub fn adjust(&self) -> Option<&SnapAdjust> {
        self.adjust.as_ref()
    }

    pub fn erased_path(&self) -> Option<&[Point]> {
        self.erased_path.as_deref()
    }

    pub fn points(&self) -> &[Point] {
        &self.points
    }

    pub fn samples(&self) -> &[PenSample] {
        &self.samples
    }

    pub fn add_sample(&mut self, x: f64, y: f64, t: f64, pressure: f64) -> bool {
        let sample_idx = self.samples.len();
        self.samples.push(PenSample { x, y, t, pressure });

        // 1. Densify points
        if !self.snapped {
            self.drawn_samples.push(XY { x, y });
            let pt_in = Point {
                x,
                y,
                pressure: if pressure > 0.0 { pressure } else { 0.0 },
                t: Some(t),
                alt: None,
                az: None,
            };
            for q in self.densifier.push(pt_in) {
                self.points.push(q);
            }
        }

        // 2. First sample setup
        let last_move = match self.last_move {
            None => {
                self.last_move = Some(XY { x, y });
                self.last_move_t = t;
                return false;
            }
            Some(lm) => lm,
        };

        // 3. Movement check
        let d = (x - last_move.x).js_hypot(y - last_move.y);
        if d > STANDSTILL_DIST {
            self.last_move = Some(XY { x, y });
            self.last_move_t = t;
            if self.snapped {
                if let Some(ref adj) = self.adjust {
                    let adjusted = adjust_snapped_shape(adj, XY { x, y });
                    if let Some(ref mut st) = self.snapped_stroke {
                        st.points = adjusted.clone();
                    }
                    if self.config.tool == SmartPenTool::Eraser {
                        let closed = self
                            .snapped_shape
                            .as_ref()
                            .map(|s| s.closed)
                            .unwrap_or(false);
                        self.erased_path = Some(erase_along_snapped_points(
                            &adjusted,
                            closed,
                            self.config.eraser_size,
                        ));
                    }
                }
            }
            return false;
        }

        // 4. Standstill check (hold to snap)
        if !self.snapped
            && (t - self.last_move_t >= self.hold_threshold_ms)
            && self.points.len() >= 6
        {
            if let Some(shape) = detect_shape(&self.points) {
                self.snapped = true;
                self.snapped_sample = Some(sample_idx);
                self.snapped_shape = Some(shape.clone());

                let stroke_w = if self.config.tool == SmartPenTool::Pen {
                    let s = Stroke {
                        points: self.points.clone(),
                        width: self.config.width,
                        tool: "pen".to_string(),
                        pen_style: Some(self.config.pen_style),
                        ..Default::default()
                    };
                    snap_width(&s)
                } else {
                    self.config.width
                };

                let tool_name = match self.config.tool {
                    SmartPenTool::Highlighter => "highlighter",
                    SmartPenTool::Eraser => "eraser",
                    SmartPenTool::Lasso => "lasso",
                    SmartPenTool::Shape(_) => "shape",
                    _ => "pen",
                };

                self.snapped_stroke = Some(Stroke {
                    id: format!("snapped-{}", sample_idx),
                    points: shape.points.clone(),
                    closed: Some(shape.closed),
                    shape_kind: Some(shape.kind),
                    is_shape: Some(true),
                    width: stroke_w,
                    tool: tool_name.to_string(),
                    color: self.config.color.clone(),
                    opacity: 1.0,
                    line_style: Some(self.config.line_style),
                    pen_style: Some(self.config.pen_style),
                    ..Default::default()
                });

                self.adjust = Some(SnapAdjust {
                    kind: shape.kind,
                    base: shape.points.clone(),
                    closed: shape.closed,
                    pen0: XY { x, y },
                    regular: shape.regular.unwrap_or(false),
                });

                if self.config.tool == SmartPenTool::Eraser {
                    self.erased_path = Some(erase_along_snapped_points(
                        &shape.points,
                        shape.closed,
                        self.config.eraser_size,
                    ));
                }

                return true;
            }
        }

        false
    }

    pub fn feed_rest(&mut self, duration_ms: f64, step_ms: f64) {
        if let Some(last) = self.samples.last().copied() {
            let n_steps = (duration_ms / step_ms).floor() as usize;
            for i in 1..=n_steps {
                let t = last.t + i as f64 * step_ms;
                self.add_sample(last.x, last.y, t, last.pressure);
            }
        }
    }

    pub fn finish(&self) -> Option<Stroke> {
        if let Some(ref st) = self.snapped_stroke {
            Some(st.clone())
        } else if !self.points.is_empty() {
            Some(Stroke {
                id: "stroke".to_string(),
                points: self.points.clone(),
                width: self.config.width,
                tool: match self.config.tool {
                    SmartPenTool::Highlighter => "highlighter".to_string(),
                    SmartPenTool::Eraser => "eraser".to_string(),
                    SmartPenTool::Lasso => "lasso".to_string(),
                    SmartPenTool::Shape(_) => "shape".to_string(),
                    _ => "pen".to_string(),
                },
                color: self.config.color.clone(),
                opacity: 1.0,
                line_style: Some(self.config.line_style),
                pen_style: Some(self.config.pen_style),
                ..Default::default()
            })
        } else {
            None
        }
    }

    /// Evaluates `eraseAlongSnapped` on a given `NotePage`.
    /// Returns `(erased_stroke_ids, put_back_stroke_ids)`.
    /// - `erased`: strokes hit by the snapped shape outline.
    /// - `put_back`: strokes hit by the drawn line before snapping.
    pub fn erase_along_snapped_on_page(&self, page: &NotePage) -> (Vec<String>, Vec<String>) {
        if !self.snapped {
            return (Vec::new(), Vec::new());
        }
        let eraser_size = self.config.eraser_size;
        let mut put_back = Vec::new();
        let mut erased = Vec::new();

        let path = self.erased_path.clone().unwrap_or_else(|| {
            if let Some(ref shape) = self.snapped_shape {
                erase_along_snapped_points(&shape.points, shape.closed, eraser_size)
            } else {
                Vec::new()
            }
        });

        for stroke in &page.strokes {
            let hit_drawn = self
                .drawn_samples
                .iter()
                .any(|s| stroke_hit_test(stroke, s.x, s.y, eraser_size));
            if hit_drawn {
                put_back.push(stroke.id.clone());
            }

            let hit_snapped = path
                .iter()
                .any(|p| stroke_hit_test(stroke, p.x, p.y, eraser_size));
            if hit_snapped {
                erased.push(stroke.id.clone());
            }
        }

        put_back.sort();
        erased.sort();
        (erased, put_back)
    }

    /// Evaluates lasso selection on a given `NotePage` using the snapped shape boundary.
    /// Returns the selected stroke IDs.
    pub fn lasso_select_on_page(&self, page: &NotePage) -> Vec<String> {
        if !self.snapped {
            return Vec::new();
        }
        if let Some(ref st) = self.snapped_stroke {
            let mut ids = lasso_select_with_snapped_shape(&st.points, page).stroke_ids;
            ids.sort();
            ids
        } else {
            Vec::new()
        }
    }
}
