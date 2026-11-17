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

    let (reply_meta_str, reply_data) = call("renderThumbnail", &req_meta.to_string(), &[]).expect("renderThumbnail should succeed");
    let reply_meta: serde_json::Value = serde_json::from_str(&reply_meta_str).expect("reply meta should be valid JSON");

    assert_eq!(reply_meta["width"].as_u64(), Some(100));
    assert_eq!(reply_meta["height"].as_u64(), Some(130));
    assert!(reply_meta["ms"].as_f64().is_some());

    // 100 x 130 x 4 bytes RGBA
    assert_eq!(reply_data.len(), 100 * 130 * 4);

    // Verify paper background is white (first pixel should be 255, 255, 255, 255)
    assert_eq!(&reply_data[0..4], &[255, 255, 255, 255]);

    // Verify there are drawn stroke pixels (non-white, non-transparent pixels)
    let has_stroke_pixels = reply_data.chunks_exact(4).any(|p| p[0] < 50 && p[1] < 50 && p[2] < 50 && p[3] > 200);
    assert!(has_stroke_pixels, "stroke pixels should be present in thumbnail output");
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

    let (reply_meta_str, reply_data) = call("canvasRender", &req_meta.to_string(), &[]).expect("canvasRender should succeed");
    let reply_meta: serde_json::Value = serde_json::from_str(&reply_meta_str).expect("reply meta should be valid JSON");

    assert_eq!(reply_meta["width"].as_u64(), Some(200));
    assert_eq!(reply_meta["height"].as_u64(), Some(200));
    assert!(reply_meta["capsules"].as_u64().unwrap_or(0) > 0);

    // 200 x 200 x 4 bytes RGBA
    assert_eq!(reply_data.len(), 200 * 200 * 4);

    // Verify there are inked pixels on the GPU canvas
    let has_ink = reply_data.chunks_exact(4).any(|p| p[0] < 50 && p[1] < 50 && p[2] < 50 && p[3] > 200);
    assert!(has_ink, "GPU canvas should render ink pixels");
}

#[test]
fn test_canvas_host_ffi_lifecycle() {
    use opennote_native::{
        opennote_canvas_host_draw, opennote_canvas_host_free, opennote_canvas_host_offscreen,
        opennote_canvas_host_remove_scene, opennote_canvas_host_resize,
        opennote_canvas_host_set_scene,
    };
    use std::ffi::CString;

    unsafe {
        let host = opennote_canvas_host_offscreen(100, 100);
        assert!(!host.is_null(), "offscreen host should be created");

        opennote_canvas_host_resize(host, 120, 120);

        let page_id = CString::new("p1").unwrap();
        let strokes_json = CString::new("[]").unwrap();
        let n = opennote_canvas_host_set_scene(host, page_id.as_ptr(), strokes_json.as_ptr());
        assert_eq!(n, 0);

        let layers_json = CString::new("[[]]").unwrap();
        let nl = opennote_native::opennote_canvas_host_set_scene_layers(host, page_id.as_ptr(), layers_json.as_ptr());
        assert_eq!(nl, 0);

        let frame_json = CString::new(r#"{"clear":[1.0,1.0,1.0,1.0],"pages":[{"page":"p1","tf":[1.0,0.0,0.0,1.0,0.0,0.0],"paper":{"width":100.0,"height":100.0,"style":1,"base":[1.0,1.0,1.0,1.0],"dark":false,"origin":[0.0,0.0]}}]}"#).unwrap();
        let set_frame_ok = opennote_native::opennote_canvas_host_set_frame(host, frame_json.as_ptr());
        assert!(set_frame_ok);

        let drawn = opennote_canvas_host_draw(host);
        assert!(drawn, "first draw on dirty host should succeed");

        opennote_canvas_host_remove_scene(host, page_id.as_ptr());

        opennote_canvas_host_free(host);
    }
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
    let (apple_tokens_json, _) = call("uiThemeTokens", &json!({ "platform": "apple", "dark": false }).to_string(), &[]).unwrap();
    let apple_val: serde_json::Value = serde_json::from_str(&apple_tokens_json).unwrap();
    assert_eq!(apple_val["platform"], "Apple");
    assert_eq!(apple_val["colors"]["canvas_background"]["r"].as_f64().is_some(), true);
    assert_eq!(apple_val["colors"]["floating_chrome"]["is_liquid_glass"], true);
    assert_eq!(apple_val["spacing"]["reading_column_max_width"], 680.0);

    // 2. uiThemeTokens Android Dark
    let (android_tokens_json, _) = call("uiThemeTokens", &json!({ "platform": "android", "dark": true }).to_string(), &[]).unwrap();
    let android_val: serde_json::Value = serde_json::from_str(&android_tokens_json).unwrap();
    assert_eq!(android_val["platform"], "Android");
    assert_eq!(android_val["colors"]["floating_chrome"]["is_liquid_glass"], false);
    assert_eq!(android_val["colors"]["floating_chrome"]["specular_border_width"], 0.0);

    // 3. uiLayoutCompute Desktop
    let (layout_json, _) = call("uiLayoutCompute", &json!({
        "width": 1440.0,
        "height": 900.0,
        "sidebarCollapsed": false,
        "platform": "apple",
        "dark": false
    }).to_string(), &[]).unwrap();
    let layout_val: serde_json::Value = serde_json::from_str(&layout_json).unwrap();
    assert_eq!(layout_val["layout_mode"], "Desktop");
    assert_eq!(layout_val["reading_column"]["width"], 680.0);

    // 4. uiFormatPill with active selection
    let (pill_json, _) = call("uiFormatPill", &json!({
        "selection": {
            "start": 5,
            "end": 15,
            "bounds": [200.0, 300.0, 100.0, 20.0]
        },
        "viewportWidth": 1200.0,
        "viewportHeight": 800.0,
        "platform": "apple",
        "dark": false
    }).to_string(), &[]).unwrap();
    let pill_val: serde_json::Value = serde_json::from_str(&pill_json).unwrap();
    assert_eq!(pill_val["is_visible"], true);
    assert_eq!(pill_val["bounds"][3], 40.0);
}

#[test]
fn test_canvas_host_pan_zoom_and_ipc_bridge() {
    use opennote_native::{
        call, opennote_canvas_engine_create, opennote_canvas_engine_destroy,
        opennote_canvas_engine_get_strokes_json, opennote_canvas_engine_load_strokes,
        opennote_canvas_engine_pan, opennote_canvas_engine_redo, opennote_canvas_engine_set_tool_config,
        opennote_canvas_engine_set_viewport_insets, opennote_canvas_engine_undo,
        opennote_canvas_engine_zoom_at, opennote_canvas_host_clear_scenes,
        opennote_canvas_host_draw, opennote_canvas_host_free, opennote_canvas_host_offscreen,
        opennote_canvas_host_pan, opennote_canvas_host_zoom_at, ACTIVE_CANVAS_HOST,
    };
    use std::ffi::CString;

    unsafe {
        // 1. Test CanvasEngine methods
        let engine = opennote_canvas_engine_create(1024.0, 768.0, 2.0);
        assert!(!engine.is_null());

        let color = CString::new("#FF5500").unwrap();
        opennote_canvas_engine_set_tool_config(engine, 0, color.as_ptr(), 3.5, 0.9);
        assert_eq!((*engine).tool_color, "#FF5500");
        assert_eq!((*engine).tool_width, 3.5);

        opennote_canvas_engine_set_viewport_insets(engine, 44.0, 34.0, 0.0, 0.0);
        assert_eq!((*engine).viewport_insets, [44.0, 34.0, 0.0, 0.0]);

        let strokes_json = CString::new(r##"[{"id":"s1","tool":"pen","color":"#000000","width":2.0,"opacity":1.0,"points":[{"x":10.0,"y":10.0,"pressure":0.5},{"x":20.0,"y":20.0,"pressure":0.5}]}]"##).unwrap();
        let loaded = opennote_canvas_engine_load_strokes(engine, strokes_json.as_ptr());
        assert_eq!(loaded, 1);
        assert_eq!((*engine).strokes.len(), 1);

        // Test undo/redo
        (*engine).push_undo_state();
        (*engine).strokes.clear();
        assert_eq!((*engine).strokes.len(), 0);
        let undone = opennote_canvas_engine_undo(engine);
        assert!(undone);
        assert_eq!((*engine).strokes.len(), 1);
        let redone = opennote_canvas_engine_redo(engine);
        assert!(redone);
        assert_eq!((*engine).strokes.len(), 0);

        // Test pan/zoom
        opennote_canvas_engine_pan(engine, 50.0, -25.0);
        assert_eq!((*engine).view_matrix.offset_x, 50.0);
        assert_eq!((*engine).view_matrix.offset_y, -25.0);

        opennote_canvas_engine_zoom_at(engine, 2.0, 500.0, 400.0);
        assert_eq!((*engine).view_matrix.scale, 2.0);

        let strokes_out = opennote_canvas_engine_get_strokes_json(engine);
        assert!(!strokes_out.is_null());

        opennote_canvas_engine_destroy(engine);

        // 2. Test CanvasHost and IPC bridge methods
        let host = opennote_canvas_host_offscreen(200, 200);
        assert!(!host.is_null());
        ACTIVE_CANVAS_HOST.store(host, std::sync::atomic::Ordering::SeqCst);

        // IPC: canvasFrame
        let (f_res, _) = call("canvasFrame", r#"{"clear":[0.1,0.2,0.3,1.0],"pages":[{"page":"p1","tf":[1.0,0.0,0.0,1.0,0.0,0.0]}]}"#, &[]).unwrap();
        let f_val: serde_json::Value = serde_json::from_str(&f_res).unwrap();
        assert_eq!(f_val["ok"], true);
        assert_eq!(f_val["attached"], true);

        // IPC: canvasScene
        let (s_res, _) = call("canvasScene", r#"{"page":"p1","strokes":[]}"#, &[]).unwrap();
        let s_val: serde_json::Value = serde_json::from_str(&s_res).unwrap();
        assert_eq!(s_val["ok"], true);

        // IPC: canvasPanZoom
        let (pz_res, _) = call("canvasPanZoom", r#"{"pan_dx":10.0,"pan_dy":20.0,"scale_factor":1.5,"cx":100.0,"cy":100.0}"#, &[]).unwrap();
        let pz_val: serde_json::Value = serde_json::from_str(&pz_res).unwrap();
        assert_eq!(pz_val["ok"], true);

        // IPC: canvasStats
        let (st_res, _) = call("canvasStats", "{}", &[]).unwrap();
        let st_val: serde_json::Value = serde_json::from_str(&st_res).unwrap();
        assert_eq!(st_val["attached"], true);

        // Direct C-ABI pan/zoom
        opennote_canvas_host_pan(host, 5.0, 5.0);
        opennote_canvas_host_zoom_at(host, 1.2, 50.0, 50.0);
        let drawn = opennote_canvas_host_draw(host);
        assert!(drawn);

        opennote_canvas_host_clear_scenes(host);
        opennote_canvas_host_free(host);
    }
}

