use model::{FillType, ImageBlock, LatexBlock, NotePage, Point, ShapeKind, Stroke, TextBlock};
use nib::geometry::XY;
use shapes::{
    detect_shape, lasso_select_strokes, rect_select_strokes, restamp, selection_bounds,
    shape_handles, transform_page_items, transform_points, transform_stroke, z_layers,
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

#[test]
fn test_rect_select_strokes_and_circle_promotion() {
    use ink::RectBounds;

    // Line from (10, 50) to (90, 50)
    let line_stroke = Stroke {
        id: "line_1".to_string(),
        tool: "pen".to_string(),
        color: "#000".to_string(),
        width: 2.0,
        opacity: 1.0,
        points: vec![make_pt(10.0, 50.0), make_pt(90.0, 50.0)],
        line_style: None,
        pen_style: None,
        is_shape: Some(true),
        closed: Some(false),
        shape_kind: Some(ShapeKind::Line),
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

    // Rectangle from (100, 100) to (200, 200)
    let rect_stroke = Stroke {
        id: "rect_1".to_string(),
        tool: "pen".to_string(),
        color: "#000".to_string(),
        width: 2.0,
        opacity: 1.0,
        points: vec![
            make_pt(100.0, 100.0),
            make_pt(200.0, 100.0),
            make_pt(200.0, 200.0),
            make_pt(100.0, 200.0),
        ],
        line_style: None,
        pen_style: None,
        is_shape: Some(true),
        closed: Some(true),
        shape_kind: Some(ShapeKind::Rectangle),
        fill: Some(FillType::Solid),
        fill_color: None,
        fill_opacity: None,
        arrow: None,
        modeled: None,
        pen_end: None,
        rotation: None,
        created_at: Some(2.0),
        highlight_alpha: None,
        dash_offset: None,
        fill_only: None,
    };

    // Smooth curve through control points
    let curve_stroke = Stroke {
        id: "curve_1".to_string(),
        tool: "pen".to_string(),
        color: "#000".to_string(),
        width: 2.0,
        opacity: 1.0,
        points: vec![
            make_pt(300.0, 10.0),
            make_pt(350.0, 80.0),
            make_pt(400.0, 10.0),
            make_pt(450.0, 80.0),
        ],
        line_style: None,
        pen_style: None,
        is_shape: Some(true),
        closed: Some(false),
        shape_kind: Some(ShapeKind::Curve),
        fill: None,
        fill_color: None,
        fill_opacity: None,
        arrow: None,
        modeled: None,
        pen_end: None,
        rotation: None,
        created_at: Some(3.0),
        highlight_alpha: None,
        dash_offset: None,
        fill_only: None,
    };

    // Handwriting stroke with un-inked lift point (pressure == 0.0)
    let hw_stroke = Stroke {
        id: "hw_1".to_string(),
        tool: "pen".to_string(),
        color: "#000".to_string(),
        width: 2.0,
        opacity: 1.0,
        points: vec![
            make_pt(500.0, 50.0),
            Point { x: 520.0, y: 55.0, pressure: 0.8, t: Some(10.0), alt: None, az: None },
            Point { x: 540.0, y: 60.0, pressure: 0.6, t: Some(20.0), alt: None, az: None },
            // Lift point outside normal ink
            Point { x: 999.0, y: 999.0, pressure: 0.0, t: Some(30.0), alt: None, az: None },
        ],
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
        created_at: Some(4.0),
        highlight_alpha: None,
        dash_offset: None,
        fill_only: None,
    };

    // Circle shape
    let mut circle_stroke = Stroke {
        id: "circle_1".to_string(),
        tool: "pen".to_string(),
        color: "#000".to_string(),
        width: 2.0,
        opacity: 1.0,
        points: vec![
            make_pt(600.0, 600.0),
            make_pt(650.0, 600.0),
            make_pt(600.0, 650.0),
        ],
        line_style: None,
        pen_style: None,
        is_shape: Some(true),
        closed: Some(true),
        shape_kind: Some(ShapeKind::Circle),
        fill: None,
        fill_color: None,
        fill_opacity: None,
        arrow: None,
        modeled: None,
        pen_end: None,
        rotation: None,
        created_at: Some(5.0),
        highlight_alpha: None,
        dash_offset: None,
        fill_only: None,
    };

    let page = NotePage {
        id: "p_rect".to_string(),
        page_number: 1,
        strokes: vec![
            line_stroke,
            rect_stroke,
            curve_stroke,
            hw_stroke,
            circle_stroke.clone(),
        ],
        latex_blocks: vec![LatexBlock {
            id: "lat_rect".to_string(),
            x: 50.0,
            y: 50.0,
            width: 100.0,
            height: 40.0,
            scale: None,
            stretch_x: None,
            latex_code: "E=mc^2".to_string(),
            is_tikz: None,
            tikz_svg: None,
            tikz_svg_source: None,
            color: None,
            rotation: None,
            created_at: 10.0,
        }],
        text_blocks: Some(vec![TextBlock {
            id: "txt_rect".to_string(),
            x: 700.0,
            y: 700.0,
            width: 80.0,
            height: Some(30.0),
            text: "Hello".to_string(),
            font_size: 16.0,
            color: "#000".to_string(),
            bold: None,
            italic: None,
            underline: None,
            font_family: None,
            align: None,
            line_height: None,
            strike: None,
            spans: None,
            paras: None,
            background: None,
            radius: None,
            padding: None,
            rotation: None,
            created_at: 11.0,
        }]),
        image_blocks: Some(vec![ImageBlock {
            id: "img_rect".to_string(),
            x: 800.0,
            y: 800.0,
            width: 50.0,
            height: 50.0,
            data_url: "data:image/png;base64,...".to_string(),
            rotation: None,
            created_at: 12.0,
        }]),
    };

    // Selection 1: Box crossing line_1 (box [40..60, 40..60])
    let sel1 = rect_select_strokes(
        RectBounds { min_x: 40.0, min_y: 40.0, max_x: 60.0, max_y: 60.0 },
        &page,
    );
    assert_eq!(sel1, vec!["line_1"]);

    // Selection 2: Box entirely inside filled rect_1 (box [120..140, 120..140])
    let sel2 = rect_select_strokes(
        RectBounds { min_x: 120.0, min_y: 120.0, max_x: 140.0, max_y: 140.0 },
        &page,
    );
    assert_eq!(sel2, vec!["rect_1"]);

    // Selection 3: Box intersecting curve_1
    let sel3 = rect_select_strokes(
        RectBounds { min_x: 340.0, min_y: 60.0, max_x: 360.0, max_y: 90.0 },
        &page,
    );
    assert_eq!(sel3, vec!["curve_1"]);

    // Selection 4: Box intersecting handwriting stroke hw_1 (box [510..530, 45..65])
    let sel4 = rect_select_strokes(
        RectBounds { min_x: 510.0, min_y: 45.0, max_x: 530.0, max_y: 65.0 },
        &page,
    );
    assert_eq!(sel4, vec!["hw_1"]);

    // Selection 5: Box touching only the un-inked lift point (999, 999) must NOT select hw_1
    let sel5 = rect_select_strokes(
        RectBounds { min_x: 990.0, min_y: 990.0, max_x: 1010.0, max_y: 1010.0 },
        &page,
    );
    assert!(sel5.is_empty());

    // Test selection_bounds (includes stroke width padding: 10 - 2 = 8.0)
    let bounds = selection_bounds(&page, &["line_1".to_string(), "lat_rect".to_string()]).unwrap();
    assert_eq!(bounds.min_x, 8.0);
    assert_eq!(bounds.max_x, 150.0); // latex block reaches 50 + 100 = 150

    // Test transform_page_items with blocks
    let mut mut_page = page;
    transform_page_items(
        &mut mut_page,
        &["lat_rect".to_string(), "txt_rect".to_string(), "img_rect".to_string()],
        10.0,
        20.0,
        1.0,
        1.0,
        0.0,
        XY { x: 0.0, y: 0.0 },
    );
    assert_eq!(mut_page.latex_blocks[0].x, 60.0);
    assert_eq!(mut_page.latex_blocks[0].y, 70.0);
    assert_eq!(mut_page.text_blocks.as_ref().unwrap()[0].x, 710.0);
    assert_eq!(mut_page.text_blocks.as_ref().unwrap()[0].y, 720.0);
    assert_eq!(mut_page.image_blocks.as_ref().unwrap()[0].x, 810.0);
    assert_eq!(mut_page.image_blocks.as_ref().unwrap()[0].y, 820.0);
    assert_eq!(circle_stroke.shape_kind, Some(ShapeKind::Circle));
    transform_stroke(
        &mut circle_stroke,
        0.0,
        0.0,
        1.5, // scale_x != scale_y
        1.0,
        0.0,
        XY { x: 600.0, y: 600.0 },
    );
    assert_eq!(circle_stroke.shape_kind, Some(ShapeKind::Ellipse));
}
