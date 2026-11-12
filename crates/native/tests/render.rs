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

