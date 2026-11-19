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
}

/// The page's frame as sent (`canvasFrame`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FrameSpec {
    pub clear: Option<Rgba>,
    pub pages: Vec<PagePlacement>,
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
            })
            .collect();
        (
            FrameSpec {
                clear: self.clear.map(clamp_rgba),
                pages,
            },
            skipped,
        )
    }

    /// The frame moved on screen: every placement followed by `p -> s p + (dx, dy)` (device px).
    /// The native canvas places the page's last frame at the camera Rust owns (crates/viewport,
    /// rust/DECISIONS.md ADR-006): `s` is the camera's scale over the one the page drew at, the
    /// offset where the page's surface now is. Computed in f64 (a placement millions of device px
    /// down a long note keeps its sub-pixel place).
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
                })
                .collect(),
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
            tf: [Option<f32>; 6],
            paper: Option<JsonPaper>,
        }
        #[derive(Deserialize)]
        struct JsonFrame {
            clear: Option<[Option<f32>; 4]>,
            pages: Vec<JsonPlacement>,
        }
        let n = |v: Option<f32>| v.unwrap_or(f32::NAN);
        let jf = serde_json::from_str::<JsonFrame>(json).ok()?;
        let clear = jf.clear.map(|c| Rgba {
            r: n(c[0]),
            g: n(c[1]),
            b: n(c[2]),
            a: n(c[3]),
        });
        let pages = jf
            .pages
            .into_iter()
            .map(|jp| PagePlacement {
                page: jp.page,
                tf: Transform {
                    a: n(jp.tf[0]),
                    b: n(jp.tf[1]),
                    c: n(jp.tf[2]),
                    d: n(jp.tf[3]),
                    ox: n(jp.tf[4]),
                    oy: n(jp.tf[5]),
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
            })
            .collect();
        Some(FrameSpec { clear, pages })
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
    fn a_null_number_skips_its_placement_only() {
        let f = FrameSpec::parse(r#"{"clear":[1,1,1,1],"pages":[{"page":"a","tf":[null,0,0,1,0,0],"paper":null},{"page":"b","tf":[1,0,0,1,0,0],"paper":{"width":null,"height":10,"style":1,"base":[1,1,1,1]}}]}"#).unwrap();
        let (d, skipped) = f.drawable();
        assert_eq!(skipped, 1);
        assert_eq!(d.pages.len(), 1);
        assert_eq!(d.pages[0].page, "b");
        assert!(d.pages[0].paper.is_none());
    }
}
