//! The host's pipeline (from the review of the native canvas, 2.9.4-rs.19, `fixes.rs` until the
//! parallel engine went): a sheet's paper is drawn without a scene of its own, each frame the page
//! sends is drawn as sent, and what the page sends that cannot be drawn is left out without a
//! panic, the device's errors recorded instead.

use canvas::host::{CanvasHost, FrameSpec, PagePlacement};
use canvas::{Paper, Transform};
use model::{Point, Stroke};
use renderer::color::Rgba;

fn line(id: &str, x0: f64, y: f64, x1: f64, width: f64) -> Stroke {
    let points = (0..=20)
        .map(|i| Point {
            x: x0 + (x1 - x0) * i as f64 / 20.0,
            y,
            pressure: 0.5,
            t: Some(i as f64 * 8.0),
            ..Default::default()
        })
        .collect();
    Stroke {
        id: id.into(),
        tool: "pen".into(),
        color: "#000000".into(),
        width,
        opacity: 1.0,
        points,
        ..Default::default()
    }
}

#[test]
fn paper_is_drawn_for_a_sheet_without_a_scene() {
    let (mut host, _) = CanvasHost::offscreen(200, 200).expect("GPU");
    host.set_scene("ink", &[line("a", 20.0, 150.0, 180.0, 4.0)]);
    let paper = Paper {
        width: 100.0,
        height: 100.0,
        style: 0,
        base: [1.0, 0.0, 0.0, 1.0],
        dark: false,
        pattern: None,
        origin: [0.0, 0.0],
    };
    host.set_frame(FrameSpec {
        surface: None,
        placed: None,
        clear: Some(Rgba::WHITE),
        pages: vec![
            // A sheet: paper only, its ink is the scene placed below.
            PagePlacement {
                page: String::new(),
                tf: Transform::scale(1.0, 0.0, 0.0),
                paper: Some(paper),
                at: None,
                bx: None,
            },
            PagePlacement {
                page: "ink".into(),
                tf: Transform::scale(1.0, 0.0, 0.0),
                paper: None,
                at: None,
                bx: None,
            },
        ],
    });
    assert!(host.draw().unwrap());
    let px = host.pixels();
    let at = |x: usize, y: usize| &px[(y * 200 + x) * 4..(y * 200 + x) * 4 + 3];
    assert_eq!(at(50, 50), &[255, 0, 0], "the sheet's red paper");
    assert_eq!(at(150, 50), &[255, 255, 255], "the desk beside it");
    assert!(at(100, 150)[0] < 60, "the ink of the scene");
}

#[test]
fn the_pages_frame_always_places_the_canvas() {
    // The page is the camera's one source: each frame it sends is drawn as sent (rs.21-25 kept
    // the shells' own pinch transform instead while their recognisers ran).
    let (mut host, _) = CanvasHost::offscreen(400, 400).expect("GPU host");
    let at = |k: f32, ox: f32, oy: f32| FrameSpec {
        surface: None,
        placed: None,
        clear: Some(Rgba::WHITE),
        pages: vec![PagePlacement {
            page: "p1".into(),
            tf: Transform::scale(k, ox, oy),
            paper: None,
            at: None,
            bx: None,
        }],
    };
    host.set_frame(at(1.0, 10.0, 20.0));
    assert!(host.draw().unwrap());
    assert!(!host.draw().unwrap(), "nothing changed: nothing drawn");
    host.set_frame(at(1.0, 10.0, 20.0));
    assert!(!host.draw().unwrap(), "the same frame again: nothing drawn");
    host.set_frame(at(2.5, -40.0, 7.0));
    assert!(host.draw().unwrap(), "a new placement is drawn at once");
}

#[test]
fn placements_that_cannot_be_drawn_are_left_out() {
    let (mut host, _) = CanvasHost::offscreen(200, 200).expect("GPU host");
    host.set_scene("ink", &[line("a", 20.0, 100.0, 180.0, 4.0)]);
    let paper = |w: f32| {
        Some(Paper {
            width: w,
            height: 100.0,
            style: 5,
            base: [1.0, 0.0, 0.0, 1.0],
            dark: false,
            pattern: None,
            origin: [0.0, 0.0],
        })
    };
    let bad = [f32::NAN, f32::INFINITY, 0.0, 1e9, -1e-9];
    let mut pages: Vec<PagePlacement> = bad
        .iter()
        .map(|&k| PagePlacement {
            page: "ink".into(),
            tf: Transform::scale(k, 0.0, 0.0),
            paper: paper(100.0),
            at: None,
            bx: None,
        })
        .collect();
    pages.push(PagePlacement {
        page: String::new(),
        tf: Transform::scale(1.0, f32::NAN, 0.0),
        paper: paper(100.0),
        at: None,
        bx: None,
    });
    pages.push(PagePlacement {
        page: String::new(),
        tf: Transform::scale(1.0, 0.0, 0.0),
        paper: paper(f32::NAN),
        at: None,
        bx: None,
    });
    pages.push(PagePlacement {
        page: String::new(),
        tf: Transform::scale(1.0, 0.0, 0.0),
        paper: paper(-5.0),
        at: None,
        bx: None,
    });
    pages.push(PagePlacement {
        page: "ink".into(),
        tf: Transform::scale(1.0, 0.0, 0.0),
        paper: None,
        at: None,
        bx: None,
    });
    host.set_frame(FrameSpec {
        surface: None,
        placed: None,
        clear: Some(Rgba {
            r: f32::NAN,
            g: 2.0,
            b: -1.0,
            a: 1.0,
        }),
        pages,
    });
    assert!(host.draw().unwrap(), "the drawable placement is drawn");
    assert_eq!(host.errors(), 0, "{:?}", host.last_error());
    assert_eq!(host.stats().skipped_pages, 6);
    let px = host.pixels();
    let at = |x: usize, y: usize| &px[(y * 200 + x) * 4..(y * 200 + x) * 4 + 3];
    assert_eq!(at(10, 10), &[0, 255, 0], "the desk colour clamped");
    assert!(at(100, 100)[0] < 60, "the ink");
    // Zoomed far in and far out, the page far off the surface: drawn without an error.
    for (k, ox, oy) in [
        (60.0, -5000.0, -3000.0),
        (0.05, 0.0, 0.0),
        (180.0, -1e7, 1e7),
        (3.0, 1e6, -1e6),
    ] {
        host.set_frame(FrameSpec {
            surface: None,
            placed: None,
            clear: Some(Rgba::WHITE),
            pages: vec![PagePlacement {
                page: "ink".into(),
                tf: Transform::scale(k, ox, oy),
                paper: paper(100.0),
                at: None,
                bx: None,
            }],
        });
        assert!(host.draw().unwrap());
    }
    assert_eq!(host.errors(), 0, "{:?}", host.last_error());
}

#[test]
fn sizes_stay_within_the_device() {
    assert!(CanvasHost::offscreen(0, 10).is_err());
    assert!(CanvasHost::offscreen(1 << 20, 10).is_err());
    let (mut host, _) = CanvasHost::offscreen(64, 64).expect("GPU host");
    host.resize(1 << 20, 0);
    let s = host.stats();
    assert!(s.width >= 1 && s.width <= 1 << 15 && s.height == 1, "{s:?}");
    host.set_frame(FrameSpec {
        surface: None,
        placed: None,
        clear: Some(Rgba::WHITE),
        pages: vec![],
    });
    assert!(host.draw().unwrap());
    assert_eq!(host.errors(), 0, "{:?}", host.last_error());
}
