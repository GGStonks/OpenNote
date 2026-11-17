//! Test canvas lasso selection on T3's reference pages matching selection.json's ids.

use canvas::ffi_bridge::ink_bounds;
use canvas::geometry_engine::Vec2d;
use canvas::spatial_index::SpatialIndex;
use canvas::tools::lasso::LassoTool;
use model::NotePage;
use serde_json::Value;

fn load_reference() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../bench/rust-ref/selection.json");
    let text = std::fs::read_to_string(path)
        .unwrap_or_else(|_| panic!("{path} is missing: run npm run bench:rustref -- bench/rust-ref/selection.json --module selection"));
    serde_json::from_str(&text).expect("selection.json is valid JSON")
}

#[test]
fn test_canvas_lasso_selection_matches_selection_json() {
    let root = load_reference();
    let page: NotePage = serde_json::from_value(root["page"].clone()).expect("valid NotePage");

    // Build the canvas SpatialIndex for all strokes on the page
    let mut spatial_index = SpatialIndex::new();
    for s in &page.strokes {
        if !s.id.is_empty() {
            spatial_index.insert(s.id.clone(), ink_bounds(s));
        }
    }

    let lasso_selections = root["lassoSelections"].as_array().expect("lassoSelections array");
    assert!(!lasso_selections.is_empty(), "expected non-empty lassoSelections");

    for (i, item) in lasso_selections.iter().enumerate() {
        let pts = item["lasso"].as_array().expect("lasso points");
        let mut lasso = LassoTool::new();

        for (k, pt) in pts.iter().enumerate() {
            let v = Vec2d::new(pt[0].as_f64().unwrap(), pt[1].as_f64().unwrap());
            if k == 0 {
                lasso.on_pointer_down(v, 0.0);
            } else {
                lasso.on_pointer_move(v, k as f64 * 10.0);
            }
        }
        let last_v = Vec2d::new(
            pts.last().unwrap()[0].as_f64().unwrap(),
            pts.last().unwrap()[1].as_f64().unwrap(),
        );

        lasso.on_pointer_up(last_v, 1000.0, &page.strokes, &spatial_index);

        let exp_strokes: Vec<String> = item["strokeIds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_string())
            .collect();

        assert_eq!(
            lasso.selected_ids, exp_strokes,
            "lasso selection {i} strokeIds mismatch"
        );
    }
}
