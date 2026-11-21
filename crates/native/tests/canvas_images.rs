//! Pictures through the page's bridge as rustCore.ts sends them: `canvasSceneBin` with the page's
//! z-layers (`z`: ink layers of `n` strokes and pictures), a picture whose file the canvas does not
//! hold answered `missingImages`, the file sent once (`canvasImage`, the block's data URL), decoded
//! off the bridge and drawn between the ink layers; `canvasImageStatus` says when the page may
//! hide its own `<img>`; a note closed drops its files. One test: the canvas state is global.
use base64::Engine;
use opennote_native::canvas_service::{
    attach_offscreen, draw_active, offscreen_pixels, settle_pictures,
};
use opennote_native::{call_framed, frame, unframe};
use serde_json::{json, Value};

fn call(method: &str, meta: Value, data: &[u8]) -> Value {
    let reply = call_framed(method, &frame(&meta.to_string(), data));
    let (m, _) = unframe(&reply).unwrap();
    serde_json::from_str(m).unwrap()
}

fn line(i: usize, y: f64, color: &str) -> (Value, Vec<u8>) {
    let pts: Vec<f64> = (0..=20)
        .flat_map(|j| [10.0 + j as f64 * 9.0, y, 0.5, j as f64 * 8.0])
        .collect();
    let s = json!({ "id": format!("s{i}"), "createdAt": i, "tool": "pen", "color": color, "width": 6, "opacity": 1, "penStyle": "fountain", "lineStyle": "solid" });
    (
        json!({ "k": i, "n": 21, "s": s }),
        pts.iter().flat_map(|v| v.to_le_bytes()).collect(),
    )
}

#[test]
fn pictures_go_through_the_bridge_and_lie_between_the_ink_layers() {
    let (w, h) = (200u32, 200u32);
    assert!(attach_offscreen(w, h), "a GPU on the PC");
    let (h1, d1) = line(1, 60.0, "#000000");
    let (h2, d2) = line(2, 120.0, "#0000ff");
    let z = json!([{ "n": 1 }, { "img": { "k": 9, "x": 40, "y": 40, "w": 120, "h": 100, "r": 0 } }, { "n": 1 }]);
    let data: Vec<u8> = [d1, d2].concat();
    let r = call(
        "canvasSceneBin",
        json!({ "page": "p", "strokes": [h1, h2], "z": z }),
        &data,
    );
    assert_eq!(r["missingImages"], json!([9]), "{r}");

    let mut png = std::io::Cursor::new(Vec::new());
    image::RgbImage::from_pixel(30, 25, image::Rgb([220, 30, 30]))
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    let url = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png.into_inner())
    );
    let r = call("canvasImage", json!({ "key": 9 }), url.as_bytes());
    assert_eq!(
        (r["width"].as_u64(), r["height"].as_u64()),
        (Some(30), Some(25)),
        "{r}"
    );
    let st = call("canvasImageStatus", json!({ "keys": [9, 10] }), &[]);
    assert_eq!(st["missing"], json!([10]), "{st}");

    call(
        "canvasFrame",
        json!({ "clear": [1, 1, 1, 1], "pages": [{ "page": "p", "tf": [1, 0, 0, 1, 0, 0], "paper": null }] }),
        &[],
    );
    draw_active();
    assert!(settle_pictures(20_000));
    draw_active();
    let px = offscreen_pixels();
    let at = |x: usize, y: usize| {
        [
            px[(y * w as usize + x) * 4],
            px[(y * w as usize + x) * 4 + 1],
            px[(y * w as usize + x) * 4 + 2],
        ]
    };
    assert_eq!(
        at(100, 60),
        [220, 30, 30],
        "the picture over the older stroke"
    );
    assert!(at(20, 60)[0] < 80, "the older stroke beside it");
    let over = at(100, 120);
    assert!(
        over[2] > 200 && over[0] < 60,
        "the newer stroke over the picture: {over:?}"
    );
    let st = call("canvasImageStatus", json!({ "keys": [9] }), &[]);
    assert_eq!(st["ready"], json!([9]), "{st}");
    let stats = call("canvasStats", json!({}), &[]);
    assert_eq!(stats["pictures"]["files"], 1, "{stats}");
    assert_eq!(stats["pictures"]["textures"], 1, "{stats}");

    // The picture moved (a new scene, the same file): no file sent again, drawn at its new place.
    let z = json!([{ "n": 1 }, { "img": { "k": 9, "x": 10, "y": 150, "w": 40, "h": 30, "r": 90 } }, { "n": 1 }]);
    let r = call(
        "canvasSceneBin",
        json!({ "page": "p", "strokes": [{ "k": 1 }, { "k": 2 }], "z": z }),
        &[],
    );
    assert_eq!(r["missingImages"], json!([]), "{r}");
    draw_active();
    let px = offscreen_pixels();
    let at = |x: usize, y: usize| {
        [
            px[(y * w as usize + x) * 4],
            px[(y * w as usize + x) * 4 + 1],
            px[(y * w as usize + x) * 4 + 2],
        ]
    };
    assert_eq!(at(30, 165), [220, 30, 30], "at its new place");
    assert_eq!(at(100, 90), [255, 255, 255], "gone from the old one");

    // The note closed: its scene and its files go.
    call(
        "canvasSceneBin",
        json!({ "page": "p", "strokes": [], "z": [] }),
        &[],
    );
    let stats = call("canvasStats", json!({}), &[]);
    assert_eq!(stats["pictures"]["files"], 0, "{stats}");
}
