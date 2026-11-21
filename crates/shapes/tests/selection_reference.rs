//! Selection, z-order and shape-edit reference tests matching TypeScript.

use model::{NotePage, Stroke};
use nib::geometry::XY;
use serde_json::Value;
use shapes::{
    compute_bounds, drag_handle, lasso_select_page, rect_select_page, restamp, shape_handles,
    transform_selection, z_layers, HandleRole, Rect, RectBounds, ShapeHandle, ZLayer,
};

const TOL: f64 = 1e-4;

fn load_reference() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../bench/rust-ref/selection.json"
    );
    let text = std::fs::read_to_string(path)
        .unwrap_or_else(|_| panic!("{path} is missing: run npm run bench:rustref -- bench/rust-ref/selection.json --module selection"));
    serde_json::from_str(&text).expect("selection.json is valid JSON")
}

fn assert_approx(val: f64, expected: f64, ctx: &str) {
    assert!(
        (val - expected).abs() <= TOL,
        "{}: got {}, expected {} (diff {})",
        ctx,
        val,
        expected,
        (val - expected).abs()
    );
}

fn parse_stroke(v: &Value) -> Stroke {
    serde_json::from_value(v.clone()).expect("valid Stroke")
}

fn parse_page(v: &Value) -> NotePage {
    serde_json::from_value(v.clone()).expect("valid NotePage")
}

#[test]
fn test_selection_reference() {
    let root = load_reference();
    let page = parse_page(&root["page"]);

    // 1. Rect selection tests
    let rect_selections = root["rectSelections"]
        .as_array()
        .expect("rectSelections array");
    for (i, item) in rect_selections.iter().enumerate() {
        let r = &item["rect"];
        let rect = RectBounds {
            min_x: r["minX"].as_f64().unwrap(),
            min_y: r["minY"].as_f64().unwrap(),
            max_x: r["maxX"].as_f64().unwrap(),
            max_y: r["maxY"].as_f64().unwrap(),
        };
        let sel = rect_select_page(rect, &page);

        let exp_strokes: Vec<String> = item["strokeIds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_string())
            .collect();
        let exp_latex: Vec<String> = item["latexIds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_string())
            .collect();
        let exp_text: Vec<String> = item["textIds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_string())
            .collect();
        let exp_images: Vec<String> = item["imageIds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_string())
            .collect();

        assert_eq!(sel.stroke_ids, exp_strokes, "rect {i} stroke_ids mismatch");
        assert_eq!(sel.latex_ids, exp_latex, "rect {i} latex_ids mismatch");
        assert_eq!(sel.text_ids, exp_text, "rect {i} text_ids mismatch");
        assert_eq!(sel.image_ids, exp_images, "rect {i} image_ids mismatch");
    }

    let rect_2_plus = rect_selections
        .iter()
        .filter(|s| s["strokeIds"].as_array().map_or(0, |a| a.len()) >= 2)
        .count();
    assert!(
        rect_2_plus >= 150,
        "expected at least 150 rect selections with >= 2 strokes, got {rect_2_plus}"
    );

    // 2. Lasso selection tests
    let lasso_selections = root["lassoSelections"]
        .as_array()
        .expect("lassoSelections array");
    for (i, item) in lasso_selections.iter().enumerate() {
        let l_pts: Vec<XY> = item["lasso"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| XY {
                x: p[0].as_f64().unwrap(),
                y: p[1].as_f64().unwrap(),
            })
            .collect();
        let sel = lasso_select_page(&l_pts, &page);

        let exp_strokes: Vec<String> = item["strokeIds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_string())
            .collect();
        let exp_latex: Vec<String> = item["latexIds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_string())
            .collect();
        let exp_text: Vec<String> = item["textIds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_string())
            .collect();
        let exp_images: Vec<String> = item["imageIds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_string())
            .collect();

        assert_eq!(sel.stroke_ids, exp_strokes, "lasso {i} stroke_ids mismatch");
        assert_eq!(sel.latex_ids, exp_latex, "lasso {i} latex_ids mismatch");
        assert_eq!(sel.text_ids, exp_text, "lasso {i} text_ids mismatch");
        assert_eq!(sel.image_ids, exp_images, "lasso {i} image_ids mismatch");
    }

    let lasso_2_plus = lasso_selections
        .iter()
        .filter(|s| s["strokeIds"].as_array().map_or(0, |a| a.len()) >= 2)
        .count();
    assert!(
        lasso_2_plus >= 150,
        "expected at least 150 lasso selections with >= 2 strokes, got {lasso_2_plus}"
    );

    // 3. computeBounds tests
    let bounds_tests = root["boundsTests"].as_array().expect("boundsTests array");
    for (i, item) in bounds_tests.iter().enumerate() {
        let stroke_ids: Vec<String> = item["strokeIds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_string())
            .collect();
        let latex_ids: Vec<String> = item["latexIds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_string())
            .collect();
        let text_ids: Vec<String> = item["textIds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_string())
            .collect();
        let image_ids: Vec<String> = item["imageIds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_string())
            .collect();

        let b = compute_bounds(&page, &stroke_ids, &latex_ids, &text_ids, &image_ids, 10.0);
        if item["bounds"].is_null() {
            assert!(b.is_none(), "bounds test {i} expected None");
        } else {
            let exp = &item["bounds"];
            let got = b.expect("bounds test {i} expected Some");
            assert_approx(got.x, exp["x"].as_f64().unwrap(), &format!("bounds {i} x"));
            assert_approx(got.y, exp["y"].as_f64().unwrap(), &format!("bounds {i} y"));
            assert_approx(
                got.width,
                exp["width"].as_f64().unwrap(),
                &format!("bounds {i} width"),
            );
            assert_approx(
                got.height,
                exp["height"].as_f64().unwrap(),
                &format!("bounds {i} height"),
            );
        }
    }

    // 4. transformSelection tests (move, scale, rotation)
    let transform_tests = root["transformTests"]
        .as_array()
        .expect("transformTests array");
    assert!(
        transform_tests.len() >= 20,
        "expected at least 20 transform tests, got {}",
        transform_tests.len()
    );
    for item in transform_tests {
        let name = item["name"].as_str().unwrap();
        let dx = item["dx"].as_f64().unwrap();
        let dy = item["dy"].as_f64().unwrap();
        let factor = item["factor"].as_f64().unwrap();
        let rot = item["rot"].as_f64().unwrap();
        let fy = item["fy"].as_f64().unwrap();

        let sel_json = &item["selection"];
        let stroke_ids: Vec<String> = sel_json["strokeIds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_string())
            .collect();
        let latex_ids: Vec<String> = sel_json["latexIds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_string())
            .collect();
        let text_ids: Vec<String> = sel_json["textIds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_string())
            .collect();
        let image_ids: Vec<String> = sel_json["imageIds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_string())
            .collect();

        let b = &sel_json["bounds"];
        let bounds = Rect {
            x: b["x"].as_f64().unwrap(),
            y: b["y"].as_f64().unwrap(),
            width: b["width"].as_f64().unwrap(),
            height: b["height"].as_f64().unwrap(),
        };

        let transformed = transform_selection(
            &page,
            &stroke_ids,
            &latex_ids,
            &text_ids,
            &image_ids,
            bounds,
            dx,
            dy,
            factor,
            rot,
            Some(fy),
        );

        let exp_page = &item["transformedPage"];

        // Compare transformed strokes
        for exp_s in exp_page["strokes"].as_array().unwrap() {
            let id = exp_s["id"].as_str().unwrap();
            let got_s = transformed
                .strokes
                .iter()
                .find(|s| s.id == id)
                .expect("stroke found");
            assert_approx(
                got_s.width,
                exp_s["width"].as_f64().unwrap(),
                &format!("{name} stroke {id} width"),
            );
            if let Some(exp_rot) = exp_s["rotation"].as_f64() {
                assert_approx(
                    got_s.rotation.unwrap(),
                    exp_rot,
                    &format!("{name} stroke {id} rotation"),
                );
            }
            let exp_pts = exp_s["points"].as_array().unwrap();
            assert_eq!(
                got_s.points.len(),
                exp_pts.len(),
                "{name} stroke {id} pts len"
            );
            for (p_idx, exp_p) in exp_pts.iter().enumerate() {
                assert_approx(
                    got_s.points[p_idx].x,
                    exp_p["x"].as_f64().unwrap(),
                    &format!("{name} stroke {id} pt {p_idx} x"),
                );
                assert_approx(
                    got_s.points[p_idx].y,
                    exp_p["y"].as_f64().unwrap(),
                    &format!("{name} stroke {id} pt {p_idx} y"),
                );
            }
        }

        // Compare transformed latex blocks
        for exp_b in exp_page["latexBlocks"].as_array().unwrap() {
            let id = exp_b["id"].as_str().unwrap();
            let got_b = transformed
                .latex_blocks
                .iter()
                .find(|b| b.id == id)
                .expect("latex found");
            assert_approx(
                got_b.x,
                exp_b["x"].as_f64().unwrap(),
                &format!("{name} latex {id} x"),
            );
            assert_approx(
                got_b.y,
                exp_b["y"].as_f64().unwrap(),
                &format!("{name} latex {id} y"),
            );
            assert_approx(
                got_b.width,
                exp_b["width"].as_f64().unwrap(),
                &format!("{name} latex {id} w"),
            );
            assert_approx(
                got_b.height,
                exp_b["height"].as_f64().unwrap(),
                &format!("{name} latex {id} h"),
            );
            if let Some(exp_scale) = exp_b["scale"].as_f64() {
                assert_approx(
                    got_b.scale.unwrap(),
                    exp_scale,
                    &format!("{name} latex {id} scale"),
                );
            }
            if let Some(exp_rot) = exp_b["rotation"].as_f64() {
                assert_approx(
                    got_b.rotation.unwrap(),
                    exp_rot,
                    &format!("{name} latex {id} rotation"),
                );
            }
        }

        // Compare transformed text blocks
        if let Some(exp_texts) = exp_page["textBlocks"].as_array() {
            let got_texts = transformed.text_blocks.as_ref().unwrap();
            for exp_t in exp_texts {
                let id = exp_t["id"].as_str().unwrap();
                let got_t = got_texts.iter().find(|t| t.id == id).expect("text found");
                assert_approx(
                    got_t.x,
                    exp_t["x"].as_f64().unwrap(),
                    &format!("{name} text {id} x"),
                );
                assert_approx(
                    got_t.y,
                    exp_t["y"].as_f64().unwrap(),
                    &format!("{name} text {id} y"),
                );
                assert_approx(
                    got_t.width,
                    exp_t["width"].as_f64().unwrap(),
                    &format!("{name} text {id} w"),
                );
                if let Some(exp_h) = exp_t["height"].as_f64() {
                    assert_approx(got_t.height.unwrap(), exp_h, &format!("{name} text {id} h"));
                }
                assert_approx(
                    got_t.font_size,
                    exp_t["fontSize"].as_f64().unwrap(),
                    &format!("{name} text {id} fontSize"),
                );
                if let Some(exp_rot) = exp_t["rotation"].as_f64() {
                    assert_approx(
                        got_t.rotation.unwrap(),
                        exp_rot,
                        &format!("{name} text {id} rotation"),
                    );
                }
            }
        }

        // Compare transformed image blocks
        if let Some(exp_imgs) = exp_page["imageBlocks"].as_array() {
            let got_imgs = transformed.image_blocks.as_ref().unwrap();
            for exp_im in exp_imgs {
                let id = exp_im["id"].as_str().unwrap();
                let got_im = got_imgs.iter().find(|im| im.id == id).expect("image found");
                assert_approx(
                    got_im.x,
                    exp_im["x"].as_f64().unwrap(),
                    &format!("{name} image {id} x"),
                );
                assert_approx(
                    got_im.y,
                    exp_im["y"].as_f64().unwrap(),
                    &format!("{name} image {id} y"),
                );
                assert_approx(
                    got_im.width,
                    exp_im["width"].as_f64().unwrap(),
                    &format!("{name} image {id} w"),
                );
                assert_approx(
                    got_im.height,
                    exp_im["height"].as_f64().unwrap(),
                    &format!("{name} image {id} h"),
                );
                if let Some(exp_rot) = exp_im["rotation"].as_f64() {
                    assert_approx(
                        got_im.rotation.unwrap(),
                        exp_rot,
                        &format!("{name} image {id} rotation"),
                    );
                }
            }
        }
    }

    // 5. Z-order tests (restamp and zLayers)
    let zorder = &root["zorder"];
    let mut shuffled_page = parse_page(&zorder["shuffledPage"]);
    restamp(&mut shuffled_page, Some(1700000000000.0));

    let exp_restamped = &zorder["restampedPage"];
    for exp_s in exp_restamped["strokes"].as_array().unwrap() {
        let id = exp_s["id"].as_str().unwrap();
        let got_s = shuffled_page.strokes.iter().find(|s| s.id == id).unwrap();
        assert_approx(
            got_s.created_at.unwrap(),
            exp_s["createdAt"].as_f64().unwrap(),
            &format!("restamp stroke {id}"),
        );
    }
    for exp_b in exp_restamped["latexBlocks"].as_array().unwrap() {
        let id = exp_b["id"].as_str().unwrap();
        let got_b = shuffled_page
            .latex_blocks
            .iter()
            .find(|b| b.id == id)
            .unwrap();
        assert_approx(
            got_b.created_at,
            exp_b["createdAt"].as_f64().unwrap(),
            &format!("restamp latex {id}"),
        );
    }
    for exp_t in exp_restamped["textBlocks"].as_array().unwrap() {
        let id = exp_t["id"].as_str().unwrap();
        let got_t = shuffled_page
            .text_blocks
            .as_ref()
            .unwrap()
            .iter()
            .find(|t| t.id == id)
            .unwrap();
        assert_approx(
            got_t.created_at,
            exp_t["createdAt"].as_f64().unwrap(),
            &format!("restamp text {id}"),
        );
    }
    for exp_im in exp_restamped["imageBlocks"].as_array().unwrap() {
        let id = exp_im["id"].as_str().unwrap();
        let got_im = shuffled_page
            .image_blocks
            .as_ref()
            .unwrap()
            .iter()
            .find(|im| im.id == id)
            .unwrap();
        assert_approx(
            got_im.created_at,
            exp_im["createdAt"].as_f64().unwrap(),
            &format!("restamp image {id}"),
        );
    }

    let layers = z_layers(&shuffled_page);
    let exp_layers = zorder["layers"].as_array().unwrap();
    assert_eq!(layers.len(), exp_layers.len(), "z_layers count mismatch");
    for (idx, (got_l, exp_l)) in layers.iter().zip(exp_layers).enumerate() {
        let exp_kind = exp_l["kind"].as_str().unwrap();
        let exp_key = exp_l["key"].as_str().unwrap();
        match got_l {
            ZLayer::Ink { key, strokes } => {
                assert_eq!(exp_kind, "ink", "layer {idx} kind");
                assert_eq!(key, exp_key, "layer {idx} key");
                let exp_ids: Vec<&str> = exp_l["strokeIds"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|s| s.as_str().unwrap())
                    .collect();
                let got_ids: Vec<&str> = strokes.iter().map(|s| s.id.as_str()).collect();
                assert_eq!(got_ids, exp_ids, "layer {idx} stroke ids");
            }
            ZLayer::Image { key, block } => {
                assert_eq!(exp_kind, "image", "layer {idx} kind");
                assert_eq!(key, exp_key, "layer {idx} key");
                assert_eq!(block.id, exp_l["blockId"].as_str().unwrap());
            }
            ZLayer::Latex { key, block } => {
                assert_eq!(exp_kind, "latex", "layer {idx} kind");
                assert_eq!(key, exp_key, "layer {idx} key");
                assert_eq!(block.id, exp_l["blockId"].as_str().unwrap());
            }
            ZLayer::Text { key, block } => {
                assert_eq!(exp_kind, "text", "layer {idx} kind");
                assert_eq!(key, exp_key, "layer {idx} key");
                assert_eq!(block.id, exp_l["blockId"].as_str().unwrap());
            }
        }
    }

    // 6. ShapeEdit tests: handles and moveHandle
    let shape_edit = &root["shapeEdit"];
    let handle_tests = shape_edit["handles"].as_array().unwrap();
    for item in handle_tests {
        let stroke = parse_stroke(&item["stroke"]);
        let exp_handles = item["handles"].as_array().unwrap();
        let got_handles = shape_handles(&stroke).unwrap_or_default();
        assert_eq!(
            got_handles.len(),
            exp_handles.len(),
            "handles len for {}",
            stroke.id
        );
        for (h_idx, exp_h) in exp_handles.iter().enumerate() {
            let got_h = &got_handles[h_idx];
            assert_approx(
                got_h.x,
                exp_h["x"].as_f64().unwrap(),
                &format!("{} handle {h_idx} x", stroke.id),
            );
            assert_approx(
                got_h.y,
                exp_h["y"].as_f64().unwrap(),
                &format!("{} handle {h_idx} y", stroke.id),
            );
            assert_eq!(
                got_h.index,
                exp_h["index"].as_i64().unwrap() as isize,
                "{} handle {h_idx} index",
                stroke.id
            );
            let role_str = serde_json::to_string(&got_h.role)
                .unwrap()
                .trim_matches('"')
                .to_string();
            assert_eq!(
                role_str,
                exp_h["role"].as_str().unwrap(),
                "{} handle {h_idx} role",
                stroke.id
            );
            if !exp_h["anchor"].is_null() {
                let anc = exp_h["anchor"].as_object().unwrap();
                let got_anc = got_h.anchor.expect("anchor present");
                assert_approx(
                    got_anc.x,
                    anc["x"].as_f64().unwrap(),
                    &format!("{} handle {h_idx} anc x", stroke.id),
                );
                assert_approx(
                    got_anc.y,
                    anc["y"].as_f64().unwrap(),
                    &format!("{} handle {h_idx} anc y", stroke.id),
                );
            }
        }
    }

    let move_tests = shape_edit["moves"].as_array().unwrap();
    for (idx, item) in move_tests.iter().enumerate() {
        let stroke_id = item["strokeId"].as_str().unwrap();
        let stroke = parse_stroke(
            &handle_tests
                .iter()
                .find(|h| h["strokeId"] == stroke_id)
                .unwrap()["stroke"],
        );
        let h_json = &item["handle"];
        let role: HandleRole = serde_json::from_value(h_json["role"].clone()).unwrap();
        let handle = ShapeHandle {
            x: h_json["x"].as_f64().unwrap(),
            y: h_json["y"].as_f64().unwrap(),
            role,
            index: h_json["index"].as_i64().unwrap() as isize,
            anchor: if h_json["anchor"].is_null() {
                None
            } else {
                Some(XY {
                    x: h_json["anchor"]["x"].as_f64().unwrap(),
                    y: h_json["anchor"]["y"].as_f64().unwrap(),
                })
            },
        };
        let target = XY {
            x: item["target"][0].as_f64().unwrap(),
            y: item["target"][1].as_f64().unwrap(),
        };

        let moved = drag_handle(&stroke, &handle, target);
        let exp_res = &item["resultStroke"];
        let exp_pts = exp_res["points"].as_array().unwrap();
        assert_eq!(
            moved.points.len(),
            exp_pts.len(),
            "move {idx} ({stroke_id}) pts len"
        );
        for (p_idx, exp_p) in exp_pts.iter().enumerate() {
            assert_approx(
                moved.points[p_idx].x,
                exp_p["x"].as_f64().unwrap(),
                &format!("move {idx} ({stroke_id}) pt {p_idx} x"),
            );
            assert_approx(
                moved.points[p_idx].y,
                exp_p["y"].as_f64().unwrap(),
                &format!("move {idx} ({stroke_id}) pt {p_idx} y"),
            );
        }
        if let Some(exp_rot) = exp_res["rotation"].as_f64() {
            assert_approx(
                moved.rotation.unwrap(),
                exp_rot,
                &format!("move {idx} ({stroke_id}) rotation"),
            );
        }
    }
}
