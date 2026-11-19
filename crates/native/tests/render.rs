use opennote_native::call;
use serde_json::json;

#[test]
fn test_render_thumbnail_through_bridge() {
    let req_meta = json!({
        "width": 100,
        "height": 130,
        "paperStyle": "ruled",
        "paperColor": "white",
        "strokes": [
            {
                "id": "s1",
                "tool": "pen",
                "color": "#000000",
                "width": 4.0,
                "opacity": 1.0,
                "points": [
                    { "x": 10.0, "y": 20.0, "pressure": 0.5 },
                    { "x": 50.0, "y": 60.0, "pressure": 0.7 },
                    { "x": 90.0, "y": 100.0, "pressure": 0.5 }
                ]
            }
        ]
    });

    let (reply_meta_str, reply_data) = call("renderThumbnail", &req_meta.to_string(), &[])
        .expect("renderThumbnail should succeed");
    let reply_meta: serde_json::Value =
        serde_json::from_str(&reply_meta_str).expect("reply meta should be valid JSON");

    assert_eq!(reply_meta["width"].as_u64(), Some(100));
    assert_eq!(reply_meta["height"].as_u64(), Some(130));
    assert!(reply_meta["ms"].as_f64().is_some());

    // 100 x 130 x 4 bytes RGBA
    assert_eq!(reply_data.len(), 100 * 130 * 4);

    // Verify paper background is white (first pixel should be 255, 255, 255, 255)
    assert_eq!(&reply_data[0..4], &[255, 255, 255, 255]);

    // Verify there are drawn stroke pixels (non-white, non-transparent pixels)
    let has_stroke_pixels = reply_data
        .as_chunks::<4>()
        .0
        .iter()
        .any(|p| p[0] < 50 && p[1] < 50 && p[2] < 50 && p[3] > 200);
    assert!(
        has_stroke_pixels,
        "stroke pixels should be present in thumbnail output"
    );
}

#[test]
fn test_canvas_render_through_bridge() {
    let req_meta = json!({
        "width": 200,
        "height": 200,
        "scale": 1.0,
        "paperStyle": "ruled",
        "paperColor": "#ffffff",
        "strokes": [
            {
                "id": "s1",
                "tool": "pen",
                "color": "#000000",
                "width": 5.0,
                "opacity": 1.0,
                "points": [
                    { "x": 20.0, "y": 30.0, "pressure": 0.5 },
                    { "x": 100.0, "y": 100.0, "pressure": 0.8 },
                    { "x": 180.0, "y": 170.0, "pressure": 0.5 }
                ]
            }
        ]
    });

    let (reply_meta_str, reply_data) =
        call("canvasRender", &req_meta.to_string(), &[]).expect("canvasRender should succeed");
    let reply_meta: serde_json::Value =
        serde_json::from_str(&reply_meta_str).expect("reply meta should be valid JSON");

    assert_eq!(reply_meta["width"].as_u64(), Some(200));
    assert_eq!(reply_meta["height"].as_u64(), Some(200));
    assert!(reply_meta["capsules"].as_u64().unwrap_or(0) > 0);

    // 200 x 200 x 4 bytes RGBA
    assert_eq!(reply_data.len(), 200 * 200 * 4);

    // Verify there are inked pixels on the GPU canvas
    let has_ink = reply_data
        .as_chunks::<4>()
        .0
        .iter()
        .any(|p| p[0] < 50 && p[1] < 50 && p[2] < 50 && p[3] > 200);
    assert!(has_ink, "GPU canvas should render ink pixels");
}

/// The canvas's lifecycle as the shells drive it (attach, resize, scenes and a frame from the
/// page's bridge, a draw on the render thread, detach), on the PC's offscreen host.
#[test]
fn test_canvas_host_ffi_lifecycle() {
    use opennote_native::canvas_service::attach_offscreen;
    use opennote_native::{
        opennote_canvas_detach, opennote_canvas_draw_active, opennote_canvas_resize,
    };
    let _serial = serial();

    assert!(
        attach_offscreen(100, 100),
        "offscreen host should be created"
    );
    opennote_canvas_resize(120, 120);

    let (r, _) = call("canvasScene", r#"{"page":"p1","strokes":[]}"#, &[]).unwrap();
    let r: serde_json::Value = serde_json::from_str(&r).unwrap();
    assert_eq!(r["capsules"], 0);

    let (r, _) = call("canvasScene", r#"{"page":"p1","layers":[[]]}"#, &[]).unwrap();
    let r: serde_json::Value = serde_json::from_str(&r).unwrap();
    assert_eq!(r["capsules"], 0);

    let (f, _) = call("canvasFrame", r#"{"clear":[1.0,1.0,1.0,1.0],"pages":[{"page":"p1","tf":[1.0,0.0,0.0,1.0,0.0,0.0],"paper":{"width":100.0,"height":100.0,"style":1,"base":[1.0,1.0,1.0,1.0],"dark":false,"origin":[0.0,0.0]}}]}"#, &[]).unwrap();
    let f: serde_json::Value = serde_json::from_str(&f).unwrap();
    assert_eq!(f["ok"], true);

    assert!(
        opennote_canvas_draw_active(),
        "first draw on dirty host should succeed"
    );

    let (r, _) = call("canvasSceneBin", r#"{"page":"p1","strokes":[]}"#, &[]).unwrap();
    let r: serde_json::Value = serde_json::from_str(&r).unwrap();
    assert_eq!(r["ok"], true);

    opennote_canvas_detach();
}

/// The canvas tests share the library's one canvas: one at a time.
fn serial() -> std::sync::MutexGuard<'static, ()> {
    static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());
    SERIAL.lock().unwrap_or_else(|e| e.into_inner())
}

#[test]
fn test_selection_methods_through_bridge() {
    let page_json = json!({
        "id": "p1",
        "pageNumber": 1,
        "strokes": [
            {
                "id": "s1",
                "tool": "pen",
                "color": "#000000",
                "width": 2.0,
                "opacity": 1.0,
                "points": [
                    { "x": 10.0, "y": 10.0, "pressure": 0.5 },
                    { "x": 20.0, "y": 20.0, "pressure": 0.5 }
                ]
            },
            {
                "id": "s2",
                "tool": "pen",
                "color": "#000000",
                "width": 2.0,
                "opacity": 1.0,
                "points": [
                    { "x": 100.0, "y": 100.0, "pressure": 0.5 },
                    { "x": 120.0, "y": 120.0, "pressure": 0.5 }
                ]
            }
        ],
        "latexBlocks": [],
        "textBlocks": [],
        "imageBlocks": []
    });

    // 1. selectInRect
    let req_rect = json!({
        "rect": [0.0, 0.0, 50.0, 50.0],
        "page": page_json
    });
    let (res_rect_meta, _) = call("selectInRect", &req_rect.to_string(), &[]).unwrap();
    let res_rect: serde_json::Value = serde_json::from_str(&res_rect_meta).unwrap();
    assert_eq!(res_rect["strokeIds"].as_array().unwrap().len(), 1);
    assert_eq!(res_rect["strokeIds"][0], "s1");

    // 2. selectInLasso
    let req_lasso = json!({
        "lasso": [[0.0, 0.0], [50.0, 0.0], [50.0, 50.0], [0.0, 50.0]],
        "page": page_json
    });
    let (res_lasso_meta, _) = call("selectInLasso", &req_lasso.to_string(), &[]).unwrap();
    let res_lasso: serde_json::Value = serde_json::from_str(&res_lasso_meta).unwrap();
    assert_eq!(res_lasso["strokeIds"].as_array().unwrap().len(), 1);
    assert_eq!(res_lasso["strokeIds"][0], "s1");

    // 3. selectionBounds
    let req_bounds = json!({
        "page": page_json,
        "ids": ["s1"]
    });
    let (res_bounds_meta, _) = call("selectionBounds", &req_bounds.to_string(), &[]).unwrap();
    let res_bounds: serde_json::Value = serde_json::from_str(&res_bounds_meta).unwrap();
    assert!(res_bounds["bounds"].is_object());

    // 4. transformPageItems
    let req_tf = json!({
        "page": page_json,
        "ids": ["s1"],
        "dx": 10.0,
        "dy": 20.0,
        "scaleX": 1.0,
        "scaleY": 1.0,
        "rotationRad": 0.0,
        "origin": [0.0, 0.0]
    });
    let (res_tf_meta, _) = call("transformPageItems", &req_tf.to_string(), &[]).unwrap();
    let res_tf: serde_json::Value = serde_json::from_str(&res_tf_meta).unwrap();
    let transformed_stroke = &res_tf["page"]["strokes"][0];
    assert_eq!(transformed_stroke["id"], "s1");
    assert_eq!(transformed_stroke["points"][0]["x"].as_f64(), Some(20.0));
    assert_eq!(transformed_stroke["points"][0]["y"].as_f64(), Some(30.0));
}

#[test]
fn test_ui_redesign_methods_through_bridge() {
    // 1. uiThemeTokens Apple Light
    let (apple_tokens_json, _) = call(
        "uiThemeTokens",
        &json!({ "platform": "apple", "dark": false }).to_string(),
        &[],
    )
    .unwrap();
    let apple_val: serde_json::Value = serde_json::from_str(&apple_tokens_json).unwrap();
    assert_eq!(apple_val["platform"], "Apple");
    assert!(apple_val["colors"]["canvas_background"]["r"]
        .as_f64()
        .is_some());
    assert_eq!(
        apple_val["colors"]["floating_chrome"]["is_liquid_glass"],
        true
    );
    assert_eq!(apple_val["spacing"]["reading_column_max_width"], 680.0);

    // 2. uiThemeTokens Android Dark
    let (android_tokens_json, _) = call(
        "uiThemeTokens",
        &json!({ "platform": "android", "dark": true }).to_string(),
        &[],
    )
    .unwrap();
    let android_val: serde_json::Value = serde_json::from_str(&android_tokens_json).unwrap();
    assert_eq!(android_val["platform"], "Android");
    assert_eq!(
        android_val["colors"]["floating_chrome"]["is_liquid_glass"],
        false
    );
    assert_eq!(
        android_val["colors"]["floating_chrome"]["specular_border_width"],
        0.0
    );

    // 3. uiLayoutCompute Desktop
    let (layout_json, _) = call(
        "uiLayoutCompute",
        &json!({
            "width": 1440.0,
            "height": 900.0,
            "sidebarCollapsed": false,
            "platform": "apple",
            "dark": false
        })
        .to_string(),
        &[],
    )
    .unwrap();
    let layout_val: serde_json::Value = serde_json::from_str(&layout_json).unwrap();
    assert_eq!(layout_val["layout_mode"], "Desktop");
    assert_eq!(layout_val["reading_column"]["width"], 680.0);

    // 4. uiFormatPill with active selection
    let (pill_json, _) = call(
        "uiFormatPill",
        &json!({
            "selection": {
                "start": 5,
                "end": 15,
                "bounds": [200.0, 300.0, 100.0, 20.0]
            },
            "viewportWidth": 1200.0,
            "viewportHeight": 800.0,
            "platform": "apple",
            "dark": false
        })
        .to_string(),
        &[],
    )
    .unwrap();
    let pill_val: serde_json::Value = serde_json::from_str(&pill_json).unwrap();
    assert_eq!(pill_val["is_visible"], true);
    assert_eq!(pill_val["bounds"][3], 40.0);
}

#[test]
fn test_canvas_ipc_bridge() {
    use opennote_native::canvas_service::{attach_offscreen, clear_scenes};
    use opennote_native::{call, opennote_canvas_detach, opennote_canvas_draw_active};
    let _serial = serial();

    assert!(attach_offscreen(200, 200));
    // IPC: canvasFrame
    let (f_res, _) = call(
        "canvasFrame",
        r#"{"clear":[0.1,0.2,0.3,1.0],"pages":[{"page":"p1","tf":[1.0,0.0,0.0,1.0,0.0,0.0]}]}"#,
        &[],
    )
    .unwrap();
    let f_val: serde_json::Value = serde_json::from_str(&f_res).unwrap();
    assert_eq!(f_val["ok"], true);
    assert_eq!(f_val["attached"], true);

    // IPC: canvasScene
    let (s_res, _) = call("canvasScene", r#"{"page":"p1","strokes":[]}"#, &[]).unwrap();
    let s_val: serde_json::Value = serde_json::from_str(&s_res).unwrap();
    assert_eq!(s_val["ok"], true);

    // IPC: canvasStats
    let (st_res, _) = call("canvasStats", "{}", &[]).unwrap();
    let st_val: serde_json::Value = serde_json::from_str(&st_res).unwrap();
    assert_eq!(st_val["attached"], true);

    let drawn = opennote_canvas_draw_active();
    assert!(drawn);

    clear_scenes();
    opennote_canvas_detach();
}
