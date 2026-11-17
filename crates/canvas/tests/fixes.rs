//! Regression tests for the review of the native canvas (2.9.4-rs.19): a sheet's paper is drawn
//! without a scene of its own, stroke boxes include their ink, an eraser gesture is one undo step
//! (none when nothing was erased), and a fully dirty frame stays fully dirty.

use canvas::canvas_core::FramePipeline;
use canvas::ffi_bridge::{ink_bounds, CanvasEngine, InputEvent, PointerType, TouchPhase};
use canvas::geometry_engine::RectBounds;
use canvas::host::{CanvasHost, FrameSpec, PagePlacement};
use canvas::{Paper, Transform};
use model::{Point, Stroke};
use renderer::color::Rgba;

fn line(id: &str, x0: f64, y: f64, x1: f64, width: f64) -> Stroke {
    let points = (0..=20).map(|i| Point { x: x0 + (x1 - x0) * i as f64 / 20.0, y, pressure: 0.5, t: Some(i as f64 * 8.0), ..Default::default() }).collect();
    Stroke { id: id.into(), tool: "pen".into(), color: "#000000".into(), width, opacity: 1.0, points, ..Default::default() }
}

#[test]
fn paper_is_drawn_for_a_sheet_without_a_scene() {
    let (mut host, _) = CanvasHost::offscreen(200, 200).expect("GPU");
    host.set_scene("ink", &[line("a", 20.0, 150.0, 180.0, 4.0)]);
    let paper = Paper { width: 100.0, height: 100.0, style: 0, base: [1.0, 0.0, 0.0, 1.0], dark: false, pattern: None, origin: [0.0, 0.0] };
    host.set_frame(FrameSpec {
        clear: Some(Rgba::WHITE),
        pages: vec![
            // A sheet: paper only, its ink is the scene placed below.
            PagePlacement { page: String::new(), tf: Transform::scale(1.0, 0.0, 0.0), paper: Some(paper) },
            PagePlacement { page: "ink".into(), tf: Transform::scale(1.0, 0.0, 0.0), paper: None },
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
fn stroke_boxes_include_their_ink() {
    let s = line("a", 0.0, 0.0, 100.0, 10.0);
    let b = ink_bounds(&s);
    // A 10 px pen draws up to ~11 px either side of its points (1.55 x 1.4 x width / 2).
    assert!(b.min_y <= -11.0 && b.max_y >= 11.0, "{b:?}");
    let probe = RectBounds::new(50.0, 9.0, 51.0, 10.0);
    assert!(b.intersects(&probe));
}

fn ev(x: f64, y: f64, phase: TouchPhase) -> InputEvent {
    InputEvent { x, y, pressure: 0.5, tilt_x: 0.0, tilt_y: 0.0, timestamp_ms: 0.0, phase, pointer_type: PointerType::Stylus }
}

#[test]
fn an_eraser_gesture_is_one_undo_step_and_none_without_erasing() {
    let mut e = CanvasEngine::new(800.0, 600.0, 2.0);
    e.load_document_strokes(vec![line("a", 100.0, 100.0, 300.0, 3.0), line("b", 100.0, 400.0, 300.0, 3.0)]);
    e.active_tool = canvas::ffi_bridge::ActiveToolKind::Eraser;
    // Over empty paper: nothing erased, no undo step.
    e.dispatch_input(ev(600.0, 250.0, TouchPhase::Down));
    e.dispatch_input(ev(620.0, 250.0, TouchPhase::Move));
    e.dispatch_input(ev(620.0, 250.0, TouchPhase::Ended));
    assert!(e.undo_stack.is_empty());
    // Across stroke a: one step, and undo brings it back.
    e.dispatch_input(ev(200.0, 80.0, TouchPhase::Down));
    e.dispatch_input(ev(200.0, 100.0, TouchPhase::Move));
    e.dispatch_input(ev(200.0, 120.0, TouchPhase::Move));
    e.dispatch_input(ev(200.0, 120.0, TouchPhase::Ended));
    assert!(!e.strokes.iter().any(|s| s.id == "a") || e.strokes.len() > 2, "stroke a erased or split");
    assert_eq!(e.undo_stack.len(), 1);
    assert!(e.undo());
    assert!(e.strokes.iter().any(|s| s.id == "a"));
}

#[test]
fn a_fully_dirty_frame_stays_fully_dirty() {
    let mut p = FramePipeline::new();
    p.mark_dirty(Some(RectBounds::new(0.0, 0.0, 10.0, 10.0)));
    assert!(p.dirty_rect.is_none(), "the whole frame was dirty already");
    p.advance_frame();
    p.mark_dirty(Some(RectBounds::new(0.0, 0.0, 10.0, 10.0)));
    assert!(p.dirty_rect.is_some());
}

#[test]
fn the_pages_frame_always_places_the_canvas() {
    // The page is the camera's one source: each frame it sends is drawn as sent (rs.21-25 kept
    // the shells' own pinch transform instead while their recognisers ran).
    let (mut host, _) = CanvasHost::offscreen(400, 400).expect("GPU host");
    let at = |k: f32, ox: f32, oy: f32| FrameSpec { clear: Some(Rgba::WHITE), pages: vec![PagePlacement { page: "p1".into(), tf: Transform::scale(k, ox, oy), paper: None }] };
    host.set_frame(at(1.0, 10.0, 20.0));
    assert!(host.draw().unwrap());
    assert!(!host.draw().unwrap(), "nothing changed: nothing drawn");
    host.set_frame(at(1.0, 10.0, 20.0));
    assert!(!host.draw().unwrap(), "the same frame again: nothing drawn");
    host.set_frame(at(2.5, -40.0, 7.0));
    assert!(host.draw().unwrap(), "a new placement is drawn at once");
}
