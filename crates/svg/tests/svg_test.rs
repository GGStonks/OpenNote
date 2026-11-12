use model::*;
use svg::*;

fn dummy_stroke() -> Stroke {
    Stroke {
        id: "s".to_string(),
        tool: "pen".to_string(),
        color: "#000000".to_string(),
        width: 2.0,
        opacity: 1.0,
        points: vec![],
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
        created_at: None,
        highlight_alpha: None,
        dash_offset: None,
        fill_only: None,
    }
}

#[test]
fn test_stroke_point_svg() {
    let mut s = dummy_stroke();
    s.id = "p1".to_string();
    s.color = "#123456".to_string();
    s.width = 3.0;
    s.opacity = 0.9;
    s.points = vec![Point {
        x: 50.0,
        y: 60.0,
        pressure: 1.0,
        t: Some(0.0),
        alt: None,
        az: None,
    }];
    s.shape_kind = Some(ShapeKind::Point);
    s.is_shape = Some(true);

    let svg = stroke_to_svg(&s, 10.0);
    assert!(svg.contains("<circle"));
    assert!(svg.contains(r#"cx="50.00""#));
    assert!(svg.contains(r#"cy="70.00""#)); // 60 + 10 dy
    assert!(svg.contains(r##"fill="#123456""##));
    assert!(svg.contains(r#"fill-opacity="0.9""#));
}

#[test]
fn test_stroke_closed_polygon_fill_svg() {
    let mut s = dummy_stroke();
    s.id = "poly1".to_string();
    s.color = "#000000".to_string();
    s.width = 2.0;
    s.opacity = 1.0;
    s.points = vec![
        Point {
            x: 0.0,
            y: 0.0,
            pressure: 1.0,
            t: Some(0.0),
            alt: None,
            az: None,
        },
        Point {
            x: 100.0,
            y: 0.0,
            pressure: 1.0,
            t: Some(10.0),
            alt: None,
            az: None,
        },
        Point {
            x: 50.0,
            y: 100.0,
            pressure: 1.0,
            t: Some(20.0),
            alt: None,
            az: None,
        },
    ];
    s.shape_kind = Some(ShapeKind::Triangle);
    s.is_shape = Some(true);
    s.closed = Some(true);
    s.fill = Some(FillType::Solid);
    s.fill_color = Some("#FF0000".to_string());
    s.fill_opacity = Some(0.5);

    let svg = stroke_to_svg(&s, 0.0);
    assert!(svg.contains("<polygon"));
    assert!(svg.contains(r#"points="0.00,0.00 100.00,0.00 50.00,100.00""#));
    assert!(svg.contains(r##"fill="#FF0000""##));
    assert!(svg.contains(r#"fill-opacity="0.5""#));
    assert!(svg.contains(r#"<path d="M 0.00 0.00 L 100.00 0.00 L 50.00 100.00 Z""#));
}

#[test]
fn test_stroke_dashed_svg() {
    let mut s = dummy_stroke();
    s.id = "dash1".to_string();
    s.color = "#0000FF".to_string();
    s.width = 4.0;
    s.points = vec![
        Point {
            x: 10.0,
            y: 10.0,
            pressure: 1.0,
            t: Some(0.0),
            alt: None,
            az: None,
        },
        Point {
            x: 90.0,
            y: 10.0,
            pressure: 1.0,
            t: Some(10.0),
            alt: None,
            az: None,
        },
    ];
    s.shape_kind = Some(ShapeKind::Line);
    s.is_shape = Some(true);
    s.closed = Some(false);
    s.line_style = Some(LineStyle::Dashed);
    s.dash_offset = Some(2.5);

    let svg = stroke_to_svg(&s, 0.0);
    assert!(svg.contains(r#"stroke-dasharray=""#));
    assert!(svg.contains(r#"stroke-dashoffset="2.50""#));
}

#[test]
fn test_page_and_document_to_svg() {
    let mut s = dummy_stroke();
    s.id = "s1".to_string();
    s.color = "#FF00FF".to_string();
    s.points = vec![
        Point {
            x: 10.0,
            y: 10.0,
            pressure: 1.0,
            t: Some(0.0),
            alt: None,
            az: None,
        },
        Point {
            x: 20.0,
            y: 20.0,
            pressure: 1.0,
            t: Some(10.0),
            alt: None,
            az: None,
        },
    ];

    let page = NotePage {
        id: "p1".to_string(),
        page_number: 1,
        strokes: vec![s],
        latex_blocks: vec![],
        text_blocks: Some(vec![TextBlock {
            id: "t1".to_string(),
            x: 100.0,
            y: 150.0,
            width: 200.0,
            height: None,
            text: "Hello <World> & Co.".to_string(),
            font_size: 16.0,
            color: "#333333".to_string(),
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
            created_at: 0.0,
        }]),
        image_blocks: Some(vec![ImageBlock {
            id: "img1".to_string(),
            x: 50.0,
            y: 50.0,
            width: 100.0,
            height: 80.0,
            data_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==".to_string(),
            rotation: None,
            created_at: 0.0,
        }]),
    };

    let svg = page_to_svg(&page, 800.0, 1000.0);
    assert!(svg.starts_with(r#"<svg xmlns="http://www.w3.org/2000/svg" width="800.00" height="1000.00""#));
    assert!(svg.contains("Hello &lt;World&gt; &amp; Co."));
    assert!(svg.contains(r#"<image href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="#));
    assert!(svg.ends_with("</svg>"));

    let doc = NoteDocument {
        id: "doc1".to_string(),
        title: "Test Note".to_string(),
        subject_id: None,
        folder_id: None,
        tag_ids: None,
        created_at: 0.0,
        updated_at: 0.0,
        paper_style: PaperStyle::Ruled,
        paper_color: PaperColor::Name("cream".to_string()),
        pattern_color: None,
        page_size: Some(PageSize::Letter),
        orientation: Some(PageOrientation::Portrait),
        pages: vec![page],
        sheets: vec![],
        schema_version: Some(5),
    };

    let doc_svg = build_svg_document(&doc);
    assert!(doc_svg.contains(r#"<g id="page-1""#));
    assert!(doc_svg.contains(r##"fill="#FBF7EE""##)); // cream paper hex
    assert!(doc_svg.ends_with("</svg>"));
}
