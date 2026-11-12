use model::{NotePage, Point, ShapeKind, Stroke};
use nib::geometry::XY;
use shapes::{
    detect_shape, lasso_select_strokes, restamp, shape_handles, transform_points, z_layers,
    HandleRole,
};

fn make_pt(x: f64, y: f64) -> Point {
    Point {
        x,
        y,
        pressure: 0.5,
        t: None,
        alt: None,
        az: None,
    }
}

#[test]
fn test_detect_line() {
    // Generate noisy straight horizontal line from (10, 20) to (150, 20)
    let mut points = Vec::new();
    for i in 0..50 {
        let x = 10.0 + (140.0 * i as f64) / 49.0;
        let y = 20.0 + (if i % 2 == 0 { 0.2 } else { -0.2 });
        points.push(make_pt(x, y));
    }
    let res = detect_shape(&points).expect("should detect shape");
    assert_eq!(res.kind, ShapeKind::Line);
    assert!(!res.closed);
    assert!(res.confidence > 0.8);
}

#[test]
fn test_detect_circle() {
    // Generate noisy circle centered at (100, 100), radius 40
    let mut points = Vec::new();
    for i in 0..72 {
        let theta = (i as f64 / 72.0) * std::f64::consts::PI * 2.0;
        let r = 40.0 + (if i % 3 == 0 { 0.3 } else { -0.3 });
        let x = 100.0 + r * theta.cos();
        let y = 100.0 + r * theta.sin();
        points.push(make_pt(x, y));
    }
    // Close the circle
    points.push(points[0]);

    let res = detect_shape(&points).expect("should detect circle");
    assert!(res.kind == ShapeKind::Circle || res.kind == ShapeKind::Ellipse);
    assert!(res.closed);
}

#[test]
fn test_detect_rectangle() {
    // Square from (10, 10) to (60, 60)
    let mut points = Vec::new();
    // top edge
    for i in 0..20 {
        points.push(make_pt(10.0 + (50.0 * i as f64) / 19.0, 10.0));
    }
    // right edge
    for i in 1..20 {
        points.push(make_pt(60.0, 10.0 + (50.0 * i as f64) / 19.0));
    }
    // bottom edge
    for i in 1..20 {
        points.push(make_pt(60.0 - (50.0 * i as f64) / 19.0, 60.0));
    }
    // left edge
    for i in 1..20 {
        points.push(make_pt(10.0, 60.0 - (50.0 * i as f64) / 19.0));
    }
    points.push(points[0]);

    let res = detect_shape(&points).expect("should detect rectangle");
    assert!(res.kind == ShapeKind::Rectangle || res.kind == ShapeKind::Polygon);
    assert!(res.closed);
}

#[test]
fn test_shape_handles() {
    let stroke = Stroke {
        id: "rect1".to_string(),
        tool: "pen".to_string(),
        color: "#000".to_string(),
        width: 2.0,
        opacity: 1.0,
        points: vec![
            make_pt(0.0, 0.0),
            make_pt(100.0, 0.0),
            make_pt(100.0, 50.0),
            make_pt(0.0, 50.0),
        ],
        line_style: None,
        pen_style: None,
        is_shape: Some(true),
        closed: Some(true),
        shape_kind: Some(ShapeKind::Rectangle),
        fill: None,
        fill_color: None,
        fill_opacity: None,
        arrow: None,
        modeled: None,
        pen_end: None,
        rotation: None,
        created_at: Some(1.0),
        highlight_alpha: None,
        dash_offset: None,
        fill_only: None,
    };

    let handles = shape_handles(&stroke).expect("handles exist");
    assert_eq!(handles.len(), 4);
    assert_eq!(handles[0].role, HandleRole::Vertex);
}

#[test]
fn test_z_order_and_restamp() {
    let stroke1 = Stroke {
        id: "s_1".to_string(),
        tool: "pen".to_string(),
        color: "#000".to_string(),
        width: 2.0,
        opacity: 1.0,
        points: vec![make_pt(10.0, 10.0)],
        line_style: None,
        pen_style: None,
        is_shape: None,
        closed: None,
        shape_kind: None,
        fill: None,
        fill_color: None,
        fill_opacity: None,
        arrow: None,
        modeled: None,
        pen_end: None,
        rotation: None,
        created_at: Some(10.0),
        highlight_alpha: None,
        dash_offset: None,
        fill_only: None,
    };
    let stroke2 = Stroke {
        id: "s_2".to_string(),
        tool: "pen".to_string(),
        color: "#000".to_string(),
        width: 2.0,
        opacity: 1.0,
        points: vec![make_pt(20.0, 20.0)],
        line_style: None,
        pen_style: None,
        is_shape: None,
        closed: None,
        shape_kind: None,
        fill: None,
        fill_color: None,
        fill_opacity: None,
        arrow: None,
        modeled: None,
        pen_end: None,
        rotation: None,
        created_at: Some(30.0),
        highlight_alpha: None,
        dash_offset: None,
        fill_only: None,
    };

    let mut page = NotePage {
        id: "p1".to_string(),
        page_number: 1,
        strokes: vec![stroke1, stroke2],
        latex_blocks: vec![model::LatexBlock {
            id: "lat_1".to_string(),
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 50.0,
            scale: None,
            stretch_x: None,
            latex_code: "x^2".to_string(),
            is_tikz: None,
            tikz_svg: None,
            tikz_svg_source: None,
            color: None,
            rotation: None,
            created_at: 20.0,
        }],
        text_blocks: None,
        image_blocks: None,
    };

    let layers = z_layers(&page);
    assert_eq!(layers.len(), 3); // Ink base (s_1), Latex, Ink after latex (s_2)

    restamp(&mut page, Some(100.0));
    assert!(page.strokes[0].created_at.unwrap() >= 100.0);
    assert!(page.latex_blocks[0].created_at > page.strokes[0].created_at.unwrap());
    assert!(page.strokes[1].created_at.unwrap() > page.latex_blocks[0].created_at);
}

#[test]
fn test_lasso_selection_and_transform() {
    let stroke = Stroke {
        id: "s_inside".to_string(),
        tool: "pen".to_string(),
        color: "#000".to_string(),
        width: 2.0,
        opacity: 1.0,
        points: vec![make_pt(50.0, 50.0), make_pt(55.0, 55.0)],
        line_style: None,
        pen_style: None,
        is_shape: None,
        closed: None,
        shape_kind: None,
        fill: None,
        fill_color: None,
        fill_opacity: None,
        arrow: None,
        modeled: None,
        pen_end: None,
        rotation: None,
        created_at: Some(1.0),
        highlight_alpha: None,
        dash_offset: None,
        fill_only: None,
    };

    let page = NotePage {
        id: "p1".to_string(),
        page_number: 1,
        strokes: vec![stroke.clone()],
        latex_blocks: vec![],
        text_blocks: None,
        image_blocks: None,
    };

    let lasso = vec![
        XY { x: 0.0, y: 0.0 },
        XY { x: 100.0, y: 0.0 },
        XY {
            x: 100.0,
            y: 100.0,
        },
        XY { x: 0.0, y: 100.0 },
    ];
    let selected = lasso_select_strokes(&lasso, &page);
    assert_eq!(selected, vec!["s_inside"]);

    let mut pts = stroke.points;
    transform_points(
        &mut pts,
        10.0,
        20.0,
        1.0,
        1.0,
        0.0,
        XY {
            x: 50.0,
            y: 50.0,
        },
    );
    assert_eq!(pts[0].x, 60.0);
    assert_eq!(pts[0].y, 70.0);
}
