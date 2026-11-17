//! Comprehensive test suite for the Vector Canvas Engine: ViewMatrix, Spatial Index, Vector Eraser,
//! Lasso on_pointer_up selection with exclusive outside dismissal, and Interactive Hold-to-Shape.

use canvas::canvas_core::ViewMatrix;
use canvas::ffi_bridge::{
    opennote_canvas_engine_create, opennote_canvas_engine_destroy,
    opennote_canvas_engine_dispatch_input, opennote_canvas_engine_screen_to_world,
    opennote_canvas_engine_set_camera, opennote_canvas_engine_set_tool,
    opennote_canvas_engine_world_to_screen, RawInputEvent,
};
use canvas::geometry_engine::{
    snap_angle_cardinal, OrientedBoundingBox, RectBounds, Vec2d,
};
use canvas::spatial_index::SpatialIndex;
use canvas::tools::eraser::{EraserMode, EraserTool};
use canvas::tools::lasso::{LassoPhase, LassoTool, LASSO_CONTEXT_MENU_ACTIONS};
use canvas::tools::shapes::{ShapeTool, ShapeToolState};
use model::{Point, ShapeKind, Stroke};
use std::f64::consts::PI;

#[test]
fn test_view_matrix_double_precision_stability() {
    let vm = ViewMatrix::new(35.5, -12345.6789, 98765.4321);
    let world_orig = Vec2d::new(123.4567890123, 456.7890123456);

    let screen = vm.world_to_screen(world_orig.x, world_orig.y);
    let world_back = vm.screen_to_world(screen.x, screen.y);

    assert!((world_orig.x - world_back.x).abs() < 1e-10, "X drift exceeds 1e-10 px");
    assert!((world_orig.y - world_back.y).abs() < 1e-10, "Y drift exceeds 1e-10 px");

    let mut vm_zoom = ViewMatrix::new(1.0, 0.0, 0.0);
    vm_zoom.zoom_at(2.0, 500.0, 500.0);
    assert_eq!(vm_zoom.scale, 2.0);
    assert_eq!(vm_zoom.offset_x, -500.0);
    assert_eq!(vm_zoom.offset_y, -500.0);

    let tf = vm.to_transform32();
    assert_eq!(tf.a, 35.5);
    assert_eq!(tf.ox, -12345.6789f32);
}

#[test]
fn test_spatial_index_rtree_operations() {
    let mut index = SpatialIndex::new();
    assert!(index.is_empty());

    index.insert("st1".to_string(), RectBounds::new(10.0, 10.0, 30.0, 30.0));
    index.insert("st2".to_string(), RectBounds::new(100.0, 100.0, 150.0, 150.0));
    index.insert("st3".to_string(), RectBounds::new(500.0, 500.0, 550.0, 550.0));

    assert_eq!(index.len(), 3);

    // Query viewport culling
    let viewport_box = RectBounds::new(0.0, 0.0, 50.0, 50.0);
    let hits = index.query_intersects(&viewport_box);
    assert_eq!(hits, vec!["st1"]);

    // Query radius
    let radius_hits = index.query_radius(Vec2d::new(110.0, 110.0), 15.0);
    assert_eq!(radius_hits, vec!["st2"]);

    // Query continuous segment
    let seg_hits = index.query_segment(Vec2d::new(0.0, 0.0), Vec2d::new(200.0, 200.0), 10.0);
    assert!(seg_hits.contains(&"st1".to_string()));
    assert!(seg_hits.contains(&"st2".to_string()));
    assert!(!seg_hits.contains(&"st3".to_string()));

    // Removal
    assert!(index.remove("st2"));
    assert_eq!(index.len(), 2);
    let after_removal = index.query_radius(Vec2d::new(110.0, 110.0), 15.0);
    assert!(after_removal.is_empty());
}

#[test]
fn test_oriented_bounding_box_and_handles() {
    let aabb = RectBounds::new(100.0, 100.0, 300.0, 200.0);
    let obb = OrientedBoundingBox::from_aabb(&aabb);

    assert_eq!(obb.center, Vec2d::new(200.0, 150.0));
    assert_eq!(obb.half_extents, Vec2d::new(100.0, 50.0));

    assert!(obb.contains_point(Vec2d::new(200.0, 150.0)));
    assert!(obb.contains_point(Vec2d::new(105.0, 105.0)));
    assert!(!obb.contains_point(Vec2d::new(400.0, 400.0)));

    // Test exclusive outside check
    assert!(!obb.is_point_outside(Vec2d::new(200.0, 150.0), 10.0));
    assert!(obb.is_point_outside(Vec2d::new(350.0, 150.0), 10.0));

    // Test 8 handles + 1 rotation handle
    let handles = obb.handle_positions(25.0);
    assert_eq!(handles.len(), 9);

    // Hit-testing handle
    let hit_tl = obb.hit_test_handle(Vec2d::new(100.0, 100.0), 15.0);
    assert_eq!(hit_tl, Some(0)); // TL handle
}

#[test]
fn test_vector_eraser_object_and_precision() {
    let mut spatial = SpatialIndex::new();
    let st1 = Stroke {
        id: "st1".to_string(),
        tool: "pen".to_string(),
        width: 4.0,
        points: vec![
            Point { x: 10.0, y: 10.0, pressure: 1.0, t: None, alt: None, az: None },
            Point { x: 50.0, y: 50.0, pressure: 1.0, t: None, alt: None, az: None },
            Point { x: 90.0, y: 90.0, pressure: 1.0, t: None, alt: None, az: None },
        ],
        ..Default::default()
    };
    spatial.insert("st1".to_string(), RectBounds::new(10.0, 10.0, 90.0, 90.0));

    // Object Eraser
    let mut obj_eraser = EraserTool::new(EraserMode::Object, 12.0);
    obj_eraser.on_pointer_down(Vec2d::new(50.0, 50.0));
    let res = obj_eraser.erase_step(Vec2d::new(50.0, 50.0), &[st1.clone()], &spatial);
    assert_eq!(res.removed_stroke_ids, vec!["st1"]);

    // Precision Eraser
    let mut prec_eraser = EraserTool::new(EraserMode::Precision, 10.0);
    prec_eraser.on_pointer_down(Vec2d::new(50.0, 50.0));
    let res_prec = prec_eraser.erase_step(Vec2d::new(50.0, 50.0), &[st1], &spatial);
    assert_eq!(res_prec.split_replacements.len(), 1);
    let (orig_id, pieces) = &res_prec.split_replacements[0];
    assert_eq!(orig_id, "st1");
    // Middle point was cut out, but remaining ends must exist
    assert!(!pieces.is_empty());
}

#[test]
fn test_lasso_tool_interaction_flow_and_exclusive_dismissal() {
    let mut spatial = SpatialIndex::new();
    let st = Stroke {
        id: "target_stroke".to_string(),
        tool: "pen".to_string(),
        width: 2.0,
        points: vec![
            Point { x: 120.0, y: 120.0, pressure: 1.0, t: None, alt: None, az: None },
            Point { x: 130.0, y: 130.0, pressure: 1.0, t: None, alt: None, az: None },
        ],
        ..Default::default()
    };
    spatial.insert("target_stroke".to_string(), RectBounds::new(120.0, 120.0, 130.0, 130.0));

    let mut lasso = LassoTool::new();
    assert_eq!(lasso.phase, LassoPhase::Idle);

    // 1. Pointer Down: begin lasso loop
    lasso.on_pointer_down(Vec2d::new(100.0, 100.0), 10.0);
    assert_eq!(lasso.phase, LassoPhase::Tracking);

    // 2. Pointer Move: NO selection calculation during movement (per spec)
    lasso.on_pointer_move(Vec2d::new(200.0, 100.0), 20.0);
    lasso.on_pointer_move(Vec2d::new(200.0, 200.0), 30.0);
    lasso.on_pointer_move(Vec2d::new(100.0, 200.0), 40.0);
    assert_eq!(lasso.phase, LassoPhase::Tracking);
    assert!(lasso.selected_ids.is_empty());

    // 3. Pointer Up (TouchPhase::Ended): EXCLUSIVELY triggers selection calculation
    let selected = lasso.on_pointer_up(Vec2d::new(100.0, 100.0), 50.0, &[st], &spatial);
    assert!(selected);
    assert_eq!(lasso.phase, LassoPhase::Selected);
    assert_eq!(lasso.selected_ids, vec!["target_stroke"]);
    assert!(lasso.is_menu_open);
    assert!(lasso.selection_bbox.is_some());

    // 4. Verify Context Menu actions are available
    assert_eq!(LASSO_CONTEXT_MENU_ACTIONS.len(), 6);

    // 5. Exclusive Dismissal Behavior:
    // Tap INSIDE bounding box: selection and menu MUST stay open
    let handled_inside = lasso.on_pointer_down(Vec2d::new(125.0, 125.0), 60.0);
    assert!(handled_inside);
    assert!(lasso.is_menu_open);

    // Tap EXPLICITLY OUTSIDE bounding box: closes menu and clears selection
    let handled_outside = lasso.on_pointer_down(Vec2d::new(800.0, 800.0), 70.0);
    assert!(!handled_outside);
    assert_eq!(lasso.phase, LassoPhase::Idle);
    assert!(!lasso.is_menu_open);
    assert!(lasso.selected_ids.is_empty());
}

#[test]
fn test_hold_to_shape_and_interactive_editing() {
    let mut shape_tool = ShapeTool::new();

    // 1. Standstill >= 350ms triggers shape recognition
    let start_p = Vec2d::new(100.0, 100.0);
    shape_tool.on_pointer_down(start_p, 1000.0);

    // Draw straight line points quickly
    for i in 1..10 {
        let p = Vec2d::new(100.0 + i as f64 * 10.0, 100.0);
        shape_tool.on_pointer_move(p, 1000.0 + i as f64 * 20.0);
    }
    // Hold pen still for 450ms (> 350ms)
    shape_tool.on_pointer_move(Vec2d::new(190.0, 100.0), 1650.0);

    if let ShapeToolState::Drawing { snapped_preview, .. } = &shape_tool.state {
        assert!(snapped_preview.is_some(), "Hold-to-shape should detect line after 400ms standstill");
        assert_eq!(snapped_preview.as_ref().unwrap().shape_kind, Some(ShapeKind::Line));
    } else {
        panic!("Expected Drawing state with snapped preview");
    }

    // Pointer up commits the shape and enters Editing state
    let committed = shape_tool.on_pointer_up();
    assert!(committed.is_some());
    assert!(matches!(shape_tool.state, ShapeToolState::Editing { .. }));

    // 2. Drag endpoint with magnetic cardinal angle snap
    let angle_near_45 = snap_angle_cardinal(46.0 * PI / 180.0, 5.0 * PI / 180.0);
    assert!((angle_near_45 - 45.0 * PI / 180.0).abs() < 1e-6);

    let angle_far = snap_angle_cardinal(65.0 * PI / 180.0, 5.0 * PI / 180.0);
    assert!((angle_far - 65.0 * PI / 180.0).abs() < 1e-6);
}

#[test]
fn test_ffi_bridge_canvas_engine_lifecycle() {
    unsafe {
        let engine = opennote_canvas_engine_create(1024.0, 768.0, 2.0);
        assert!(!engine.is_null());

        opennote_canvas_engine_set_camera(engine, 2.5, 50.0, 100.0);

        let mut wx = 0.0;
        let mut wy = 0.0;
        opennote_canvas_engine_screen_to_world(engine, 100.0, 200.0, &mut wx, &mut wy);
        assert!((wx - 20.0).abs() < 1e-6);
        assert!((wy - 40.0).abs() < 1e-6);

        let mut sx = 0.0;
        let mut sy = 0.0;
        opennote_canvas_engine_world_to_screen(engine, wx, wy, &mut sx, &mut sy);
        assert!((sx - 100.0).abs() < 1e-6);
        assert!((sy - 200.0).abs() < 1e-6);

        // Switch to Lasso tool
        opennote_canvas_engine_set_tool(engine, 2);

        // Dispatch pointer down
        let ev_down = RawInputEvent {
            x: 100.0,
            y: 100.0,
            pressure: 1.0,
            tilt_x: 0.0,
            tilt_y: 0.0,
            timestamp_ms: 100.0,
            phase: 0,
            pointer_type: 0,
        };
        let res = opennote_canvas_engine_dispatch_input(engine, &ev_down);
        // During down, no action response expected
        assert!(res.is_null());

        // Values the C side may send that no enum holds are dropped, not read as an enum.
        for (phase, pointer_type) in [(7u32, 0u32), (0, 9), (u32::MAX, u32::MAX)] {
            let bad = RawInputEvent { phase, pointer_type, ..ev_down };
            assert!(opennote_canvas_engine_dispatch_input(engine, &bad).is_null());
        }
        let nan = RawInputEvent { x: f64::NAN, ..ev_down };
        assert!(opennote_canvas_engine_dispatch_input(engine, &nan).is_null());

        opennote_canvas_engine_destroy(engine);
    }
}
