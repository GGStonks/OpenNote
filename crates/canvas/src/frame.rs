//! What the page shows this frame. TypeScript counterpart: the `canvasFrame` message CanvasPage.tsx
//! sends every animation frame the page moved (`rustSetCanvasFrame` in src/services/rustCore.ts):
//! the desk colour, then one placement per visible sheet (its paper, no scene) and the strokes'
//! placement (the page's scene, no paper), each with its transform from page px to device px.
//!
//! The page's numbers reach the GPU only through `drawable_tf` / `Paper::is_drawable`: a
//! placement whose transform is not finite or is degenerate (zoom far outside what the page
//! allows, a page millions of px away) is skipped, a paper that is not a finite positive box is
//! left out; nothing else in the frame changes.

use crate::gpu::GpuScene;
use crate::paper::Paper;
use crate::scene::Transform;
use renderer::color::Rgba;
use serde::Deserialize;

/// Device px per page px a placement may have: zoom 0.05 at dpr 1 is 0.05, zoom 60 at dpr 3 is
/// 180; outside [1e-4, 1e4] a transform is a mistake, and drawn it overflows the shaders' floats.
pub const MIN_PX: f32 = 1e-4;
pub const MAX_PX: f32 = 1e4;
/// How far (device px) a placement's origin may lie from the surface; further it shows nothing
/// and its coordinates lose all precision in f32.
pub const MAX_OFFSET: f32 = 1e8;

/// Whether `tf` can be drawn: every coefficient finite, its scale within [`MIN_PX`, `MAX_PX`],
/// not collapsed to a line, its origin within [`MAX_OFFSET`].
pub fn drawable_tf(tf: &Transform) -> bool {
    let all = [tf.a, tf.b, tf.c, tf.d, tf.ox, tf.oy];
    if !all.iter().all(|v| v.is_finite()) {
        return false;
    }
    let det = (tf.a * tf.d - tf.b * tf.c).abs();
    if !det.is_finite() || det < MIN_PX * MIN_PX {
        return false;
    }
    let px = det.sqrt();
    let col = (tf.a * tf.a + tf.b * tf.b)
        .sqrt()
        .max((tf.c * tf.c + tf.d * tf.d).sqrt());
    px <= MAX_PX && col <= MAX_PX && tf.ox.abs() <= MAX_OFFSET && tf.oy.abs() <= MAX_OFFSET
}

/// A colour with every channel finite and within 0..1 (NaN as 0).
pub fn clamp_rgba(c: Rgba) -> Rgba {
    let f = |v: f32| {
        if v.is_finite() {
            v.clamp(0.0, 1.0)
        } else {
            0.0
        }
    };
    Rgba {
        r: f(c.r),
        g: f(c.g),
        b: f(c.b),
        a: f(c.a),
    }
}

/// One page of a frame: its scene through its transform, over its paper.
pub struct PageDraw<'a> {
    pub scene: &'a GpuScene,
    pub tf: Transform,
    pub paper: Option<Paper>,
}

/// What one frame shows: the desk colour (None: see-through) and the pages on it.
pub struct Frame<'a> {
    pub clear: Option<Rgba>,
    pub pages: Vec<PageDraw<'a>>,
}

/// A page as the frame shows it: the scene `page` (empty: a sheet's paper alone) through `tf`.
#[derive(Clone, Debug, PartialEq)]
pub struct PagePlacement {
    pub page: String,
    pub tf: Transform,
    pub paper: Option<Paper>,
    /// Where it sits on the page's surface (surface px), when the frame says where the surface is:
    /// then its transform follows the surface's (`FrameSpec::place`).
    pub at: Option<[f64; 2]>,
}

/// The page's frame as sent (`canvasFrame`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FrameSpec {
    pub clear: Option<Rgba>,
    pub pages: Vec<PagePlacement>,
    /// Where the page's surface was drawn (device px: scale, left, top), f64, as the page sent it.
    pub surface: Option<[f64; 3]>,
    /// Where `place` last put it.
    pub placed: Option<[f64; 3]>,
}

impl FrameSpec {
    /// The frame as drawn: placements that cannot be drawn left out, papers that cannot be drawn
    /// dropped, the desk colour clamped. Also how many placements were left out.
    pub fn drawable(&self) -> (FrameSpec, usize) {
        let mut skipped = 0;
        let pages = self
            .pages
            .iter()
            .filter(|p| {
                let ok = drawable_tf(&p.tf);
                skipped += usize::from(!ok);
                ok
            })
            .map(|p| PagePlacement {
                page: p.page.clone(),
                tf: p.tf,
                paper: p.paper.filter(Paper::is_drawable),
                at: p.at,
            })
            .collect();
        (
            FrameSpec {
                clear: self.clear.map(clamp_rgba),
                pages,
                surface: self.surface,
                placed: self.placed,
            },
            skipped,
        )
    }

    /// Every placement that sits on the surface (`at`) placed from one surface transform: scale
    /// `k`, the surface's corner (`x`, `y`), device px. Computed in f64 down to each transform's
    /// own numbers, so the paper of every sheet and the ink keep exactly their places on the
    /// surface whatever the camera (one transform for all, ADR-008). In place: nothing is made.
    /// True when anything changed.
    pub fn place(&mut self, k: f64, x: f64, y: f64) -> bool {
        if !(k.is_finite() && x.is_finite() && y.is_finite() && k > 0.0) {
            return false;
        }
        let mut changed = self.placed != Some([k, x, y]);
        self.placed = Some([k, x, y]);
        for p in &mut self.pages {
            let Some([ax, ay]) = p.at else { continue };
            let tf = Transform {
                a: k as f32,
                b: 0.0,
                c: 0.0,
                d: k as f32,
                ox: (x + ax * k) as f32,
                oy: (y + ay * k) as f32,
            };
            if tf != p.tf {
                p.tf = tf;
                changed = true;
            }
        }
        changed
    }

    /// The largest gap (device px) between a placement with paper and where the surface's
    /// transform puts its `at` (the ink's frame of reference): 0 when they are one transform.
    pub fn paper_gap(&self) -> f64 {
        let Some([k, x, y]) = self.placed.or(self.surface) else {
            return 0.0;
        };
        self.pages
            .iter()
            .filter(|p| p.paper.is_some())
            .filter_map(|p| p.at.map(|a| (p.tf, a)))
            .map(|(tf, [ax, ay])| {
                (tf.ox as f64 - (x + ax * k))
                    .abs()
                    .max((tf.oy as f64 - (y + ay * k)).abs())
                    .max((tf.a as f64 - k).abs() * 1000.0)
            })
            .fold(0.0, f64::max)
    }

    /// The frame moved on screen: every placement followed by `p -> s p + (dx, dy)` (device px).
    /// 2.9.6 placed the page's last frame at the Rust camera this way (ADR-006); kept for tests.
    pub fn moved(&self, s: f64, dx: f64, dy: f64) -> FrameSpec {
        let m = |v: f32| (v as f64 * s) as f32;
        FrameSpec {
            clear: self.clear,
            pages: self
                .pages
                .iter()
                .map(|p| PagePlacement {
                    page: p.page.clone(),
                    tf: Transform {
                        a: m(p.tf.a),
                        b: m(p.tf.b),
                        c: m(p.tf.c),
                        d: m(p.tf.d),
                        ox: (p.tf.ox as f64 * s + dx) as f32,
                        oy: (p.tf.oy as f64 * s + dy) as f32,
                    },
                    paper: p.paper,
                    at: p.at,
                })
                .collect(),
            surface: self
                .surface
                .map(|[k, x, y]| [k * s, x * s + dx, y * s + dy]),
            placed: self.placed.map(|[k, x, y]| [k * s, x * s + dx, y * s + dy]),
        }
    }

    /// The page's `canvasFrame` message: `{ clear: [r,g,b,a] | null, pages: [{ page, tf:
    /// [a,b,c,d,ox,oy], paper: { width, height, style, base, dark, pattern, origin } | null }] }`
    /// (device px). None when it does not parse. JSON has no NaN or infinity: those come as
    /// `null`, read here as NaN so that the placement is skipped rather than the whole frame.
    pub fn parse(json: &str) -> Option<FrameSpec> {
        #[derive(Deserialize)]
        struct JsonPaper {
            width: Option<f32>,
            height: Option<f32>,
            style: u32,
            base: [Option<f32>; 4],
            #[serde(default)]
            dark: bool,
            pattern: Option<[Option<f32>; 3]>,
            #[serde(default)]
            origin: [Option<f32>; 2],
        }
        #[derive(Deserialize)]
        struct JsonPlacement {
            page: String,
            tf: [Option<f64>; 6],
            paper: Option<JsonPaper>,
            #[serde(default)]
            at: Option<[f64; 2]>,
        }
        #[derive(Deserialize)]
        struct JsonFrame {
            clear: Option<[Option<f32>; 4]>,
            pages: Vec<JsonPlacement>,
            #[serde(default)]
            surface: Option<[Option<f64>; 3]>,
        }
        let n = |v: Option<f32>| v.unwrap_or(f32::NAN);
        let n64 = |v: Option<f64>| v.unwrap_or(f64::NAN);
        let jf = serde_json::from_str::<JsonFrame>(json).ok()?;
        let surface = jf
            .surface
            .map(|s| s.map(n64))
            .filter(|s| s.iter().all(|v| v.is_finite()) && s[0] > 0.0);
        let clear = jf.clear.map(|c| Rgba {
            r: n(c[0]),
            g: n(c[1]),
            b: n(c[2]),
            a: n(c[3]),
        });
        let pages = jf
            .pages
            .into_iter()
            .map(|jp| {
                let tf = jp.tf.map(n64);
                // A placement on the surface: given, else read from its transform (a translation
                // of the surface's at its scale).
                let at = jp
                    .at
                    .filter(|a| a.iter().all(|v| v.is_finite()))
                    .or_else(|| {
                        surface.and_then(|[k, x, y]| {
                            let on = (tf[0] - k).abs() <= 1e-9 * k
                                && (tf[3] - k).abs() <= 1e-9 * k
                                && tf[1] == 0.0
                                && tf[2] == 0.0;
                            let a = [(tf[4] - x) / k, (tf[5] - y) / k];
                            (on && a.iter().all(|v| v.is_finite())).then_some(a)
                        })
                    });
                PagePlacement {
                    page: jp.page,
                    tf: Transform {
                        a: tf[0] as f32,
                        b: tf[1] as f32,
                        c: tf[2] as f32,
                        d: tf[3] as f32,
                        ox: tf[4] as f32,
                        oy: tf[5] as f32,
                    },
                    paper: jp.paper.map(|p| Paper {
                        width: n(p.width),
                        height: n(p.height),
                        style: p.style,
                        base: p.base.map(n),
                        dark: p.dark,
                        pattern: p.pattern.map(|c| c.map(n)),
                        origin: p.origin.map(|v| v.unwrap_or(0.0)),
                    }),
                    at,
                }
            })
            .collect();
        let mut f = FrameSpec {
            clear,
            pages,
            surface,
            placed: None,
        };
        // Each placement's numbers from the surface's, in f64 (the page's own, rounded the same).
        if let Some([k, x, y]) = surface {
            f.place(k, x, y);
        }
        Some(f)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn degenerate_transforms_are_not_drawn() {
        assert!(drawable_tf(&Transform::scale(2.0, 10.0, -5000.0)));
        assert!(drawable_tf(&Transform::scale(0.05, 0.0, 0.0)));
        assert!(drawable_tf(&Transform::scale(180.0, -1e6, 0.0)));
        assert!(!drawable_tf(&Transform::scale(0.0, 0.0, 0.0)));
        assert!(!drawable_tf(&Transform::scale(f32::NAN, 0.0, 0.0)));
        assert!(!drawable_tf(&Transform::scale(1.0, f32::INFINITY, 0.0)));
        assert!(!drawable_tf(&Transform::scale(1e6, 0.0, 0.0)));
        assert!(!drawable_tf(&Transform::scale(1.0, 0.0, 1e12)));
        assert!(!drawable_tf(&Transform {
            a: 1.0,
            b: 1.0,
            c: 1.0,
            d: 1.0,
            ox: 0.0,
            oy: 0.0
        }));
    }

    #[test]
    fn a_moved_frame_maps_each_page_point_through_the_move() {
        let f = FrameSpec::parse(r#"{"clear":[0.5,0.5,0.5,1],"pages":[{"page":"","tf":[2,0,0,2,16,140],"paper":{"width":816,"height":1056,"style":1,"base":[1,1,1,1],"origin":[0,0]}},{"page":"p","tf":[2,0,0,2,16,140],"paper":null}]}"#).unwrap();
        // The camera zoomed 1.5x about device point (400, 600) and moved 10 px right.
        let (s, dx, dy) = (1.5, 400.0 * (1.0 - 1.5) + 10.0, 600.0 * (1.0 - 1.5));
        let g = f.moved(s, dx, dy);
        assert_eq!(g.clear, f.clear);
        assert_eq!(g.pages[0].paper, f.pages[0].paper);
        for (a, b) in f.pages.iter().zip(&g.pages) {
            for (x, y) in [(0.0f32, 0.0f32), (816.0, 1056.0), (100.5, 7.25)] {
                let (px, py) = a.tf.apply(x, y);
                let (qx, qy) = b.tf.apply(x, y);
                assert!((qx as f64 - (px as f64 * s + dx)).abs() < 1e-3);
                assert!((qy as f64 - (py as f64 * s + dy)).abs() < 1e-3);
            }
        }
    }

    #[test]
    fn placed_from_the_surface_the_papers_and_the_ink_are_one_transform() {
        let mut f = FrameSpec::parse(r#"{"clear":null,"surface":[2,16,140],"pages":[{"page":"","tf":[2,0,0,2,16,140],"paper":{"width":816,"height":1056,"style":1,"base":[1,1,1,1],"origin":[0,0]}},{"page":"","tf":[2,0,0,2,16,2268],"paper":{"width":816,"height":1056,"style":1,"base":[1,1,1,1],"origin":[0,1064]}},{"page":"s","tf":[2,0,0,2,16,140],"paper":null}]}"#).unwrap();
        assert_eq!(f.pages[1].at, Some([0.0, 1064.0]));
        assert_eq!(f.pages[2].at, Some([0.0, 0.0]));
        // Far down a long note, zoomed in: still exactly on the surface's transform.
        assert!(f.place(9.5, -3.25, -2_345_678.125));
        assert!(f.paper_gap() < 0.13, "{}", f.paper_gap());
        assert!(!f.place(9.5, -3.25, -2_345_678.125), "nothing new");
        assert_eq!(f.pages[1].tf.oy, (-2_345_678.125f64 + 1064.0 * 9.5) as f32);
    }

    #[test]
    fn a_null_number_skips_its_placement_only() {
        let f = FrameSpec::parse(r#"{"clear":[1,1,1,1],"pages":[{"page":"a","tf":[null,0,0,1,0,0],"paper":null},{"page":"b","tf":[1,0,0,1,0,0],"paper":{"width":null,"height":10,"style":1,"base":[1,1,1,1]}}]}"#).unwrap();
        let (d, skipped) = f.drawable();
        assert_eq!(skipped, 1);
        assert_eq!(d.pages.len(), 1);
        assert_eq!(d.pages[0].page, "b");
        assert!(d.pages[0].paper.is_none());
    }
}
