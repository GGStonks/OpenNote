//! Pictures on the native canvas (docs/rust-native-canvas.md N4, rust/MAP.md C2), against the
//! pixels the page's `<img>` gives (Blocks.tsx `ImageBlockView`: the block's box, turned
//! `rotation` degrees clockwise about its centre): each point inside a picture shows the file's
//! pixel the box maps there, crop and flip choosing the file's part, opacity and the file's alpha
//! over the paper, the pictures stacked between the ink layers (zorder.ts). Also a file far larger
//! than any texture (12000 x 9000): drawn from a smaller band, within the device's limits and the
//! textures' budget, and the budget kept when more pictures are shown than it holds.

use canvas::host::{CanvasHost, FrameSpec, PagePlacement};
use canvas::{ImageItem, Layer, Scene, Transform};
use model::{Point, Stroke};
use renderer::color::Rgba;
use std::io::Cursor;

const W: u32 = 400;
const H: u32 = 300;

/// The quadrants' colours of the test file: top left red, top right green, bottom left blue,
/// bottom right yellow.
const QUAD: [[u8; 3]; 4] = [[220, 30, 30], [30, 180, 60], [40, 60, 220], [240, 220, 40]];

fn quadrant(u: f32, v: f32) -> [u8; 3] {
    QUAD[(u >= 0.5) as usize + 2 * (v >= 0.5) as usize]
}

fn encode(img: image::DynamicImage, fmt: image::ImageFormat) -> Vec<u8> {
    let mut out = Cursor::new(Vec::new());
    img.write_to(&mut out, fmt).expect("encode");
    out.into_inner()
}

fn quad_png(w: u32, h: u32) -> Vec<u8> {
    let img = image::RgbImage::from_fn(w, h, |x, y| {
        image::Rgb(quadrant(
            (x as f32 + 0.5) / w as f32,
            (y as f32 + 0.5) / h as f32,
        ))
    });
    encode(image::DynamicImage::ImageRgb8(img), image::ImageFormat::Png)
}

fn host() -> CanvasHost {
    CanvasHost::offscreen(W, H).expect("GPU").0
}

/// Draws `layers` at `scale` over white paper, every picture decoded first; the pixels.
fn draw(host: &mut CanvasHost, layers: &[Layer], scale: f32) -> Vec<u8> {
    host.put_scene("p", &Scene::build_layers(layers));
    host.set_frame(FrameSpec {
        clear: Some(Rgba::WHITE),
        pages: vec![PagePlacement {
            page: "p".into(),
            tf: Transform::scale(scale, 0.0, 0.0),
            paper: None,
            at: None,
            bx: None,
        }],
        surface: None,
        placed: None,
    });
    host.draw_settled(8).expect("draw");
    host.pixels()
}

fn at(px: &[u8], x: f32, y: f32) -> [u8; 3] {
    let (x, y) = (x.floor() as usize, y.floor() as usize);
    let i = (y * W as usize + x) * 4;
    [px[i], px[i + 1], px[i + 2]]
}

/// Where the point (fx, fy) of `it`'s box (0..1 each) lands on screen at `scale`.
fn screen(it: &ImageItem, fx: f32, fy: f32, scale: f32) -> (f32, f32) {
    let (dx, dy) = ((fx - 0.5) * it.w, (fy - 0.5) * it.h);
    let (sn, cs) = it.rotation.to_radians().sin_cos();
    (
        (it.x + it.w / 2.0 + dx * cs - dy * sn) * scale,
        (it.y + it.h / 2.0 + dx * sn + dy * cs) * scale,
    )
}

/// The file's (u, v) shown at (fx, fy) of the box.
fn uv(it: &ImageItem, fx: f32, fy: f32) -> (f32, f32) {
    let (mut u0, mut v0, mut u1, mut v1) = (it.crop[0], it.crop[1], it.crop[2], it.crop[3]);
    if it.flip_h {
        std::mem::swap(&mut u0, &mut u1);
    }
    if it.flip_v {
        std::mem::swap(&mut v0, &mut v1);
    }
    (u0 + (u1 - u0) * fx, v0 + (v1 - v0) * fy)
}

/// Every point of a 9 x 9 grid inside the box (away from the quadrants' borders and the box's
/// edges) shows the file's quadrant there; returns how many were checked.
fn check_grid(px: &[u8], it: &ImageItem, scale: f32, tol: i32, what: &str) -> usize {
    let mut n = 0;
    for i in 1..10 {
        for j in 1..10 {
            let (fx, fy) = (i as f32 / 10.0, j as f32 / 10.0);
            let (u, v) = uv(it, fx, fy);
            if (u - 0.5).abs() < 0.06 || (v - 0.5).abs() < 0.06 {
                continue;
            }
            let (x, y) = screen(it, fx, fy, scale);
            let got = at(px, x, y);
            let want = quadrant(u, v);
            for c in 0..3 {
                assert!(
                    (got[c] as i32 - want[c] as i32).abs() <= tol,
                    "{what}: at ({fx}, {fy}) of the box, device ({x:.1}, {y:.1}): {got:?}, want {want:?}"
                );
            }
            n += 1;
        }
    }
    n
}

fn item(key: u64) -> ImageItem {
    ImageItem::new(key, 60.0, 50.0, 160.0, 120.0)
}

#[test]
fn rotations_crop_and_flips_place_the_files_pixels() {
    let mut h = host();
    h.library().insert(1, &quad_png(64, 48)).expect("png");
    let cases: Vec<(&str, ImageItem)> = vec![
        ("upright", item(1)),
        (
            "37 degrees",
            ImageItem {
                rotation: 37.0,
                ..item(1)
            },
        ),
        (
            "90 degrees",
            ImageItem {
                rotation: 90.0,
                ..item(1)
            },
        ),
        (
            "180 degrees",
            ImageItem {
                rotation: 180.0,
                ..item(1)
            },
        ),
        (
            "flipped horizontally",
            ImageItem {
                flip_h: true,
                ..item(1)
            },
        ),
        (
            "flipped vertically",
            ImageItem {
                flip_v: true,
                ..item(1)
            },
        ),
        (
            "cropped",
            ImageItem {
                crop: [0.25, 0.1, 1.0, 0.8],
                ..item(1)
            },
        ),
        (
            "cropped, flipped and turned",
            ImageItem {
                crop: [0.0, 0.3, 0.7, 1.0],
                flip_h: true,
                rotation: -63.0,
                ..item(1)
            },
        ),
    ];
    for scale in [1.0, 1.5] {
        for (what, it) in &cases {
            let px = draw(&mut h, &[Layer::Image(*it)], scale);
            let n = check_grid(&px, it, scale, 4, &format!("{what} at {scale}x"));
            assert!(n >= 30, "{what}: {n} points checked");
            // Outside the turned box: the paper.
            let (x, y) = screen(it, 1.25, 0.5, scale);
            if x < W as f32 && y < H as f32 && x >= 0.0 && y >= 0.0 {
                assert_eq!(at(&px, x, y), [255, 255, 255], "{what}: beside the box");
            }
        }
    }
}

#[test]
fn opacity_and_the_files_alpha_lie_over_the_paper() {
    let mut h = host();
    // Left half see-through, right half red at alpha 128.
    let img = image::RgbaImage::from_fn(40, 20, |x, _| {
        if x < 20 {
            image::Rgba([0, 0, 0, 0])
        } else {
            image::Rgba([255, 0, 0, 128])
        }
    });
    h.library()
        .insert(
            2,
            &encode(
                image::DynamicImage::ImageRgba8(img),
                image::ImageFormat::Png,
            ),
        )
        .expect("png");
    h.library().insert(1, &quad_png(64, 48)).expect("png");
    let alpha = ImageItem::new(2, 20.0, 20.0, 200.0, 100.0);
    let px = draw(&mut h, &[Layer::Image(alpha)], 1.0);
    assert_eq!(at(&px, 60.0, 70.0), [255, 255, 255], "the see-through half");
    let red = at(&px, 180.0, 70.0);
    assert!(
        red[0] == 255 && (red[1] as i32 - 127).abs() <= 2,
        "red at half alpha: {red:?}"
    );
    let half = ImageItem {
        opacity: 0.5,
        ..item(1)
    };
    let px = draw(&mut h, &[Layer::Image(half)], 1.0);
    let (x, y) = screen(&half, 0.25, 0.25, 1.0);
    let got = at(&px, x, y);
    let want = QUAD[0].map(|c| ((c as f32 + 255.0) / 2.0).round() as i32);
    for c in 0..3 {
        assert!(
            (got[c] as i32 - want[c]).abs() <= 2,
            "half opacity: {got:?}, want {want:?}"
        );
    }
}

#[test]
fn jpeg_gif_and_webp_files() {
    let mut h = host();
    let quad = image::DynamicImage::ImageRgb8(image::RgbImage::from_fn(64, 48, |x, y| {
        image::Rgb(quadrant((x as f32 + 0.5) / 64.0, (y as f32 + 0.5) / 48.0))
    }));
    h.library()
        .insert(3, &encode(quad.clone(), image::ImageFormat::Jpeg))
        .expect("jpeg");
    h.library()
        .insert(4, &encode(quad.to_rgba8().into(), image::ImageFormat::Gif))
        .expect("gif");
    h.library()
        .insert(5, &encode(quad.to_rgba8().into(), image::ImageFormat::WebP))
        .expect("webp");
    // As the page sends it: the block's data URL.
    let url = format!(
        "data:image/jpeg;base64,{}",
        base64_of(&encode(quad, image::ImageFormat::Jpeg))
    );
    h.library().insert(6, url.as_bytes()).expect("data URL");
    for (key, what, tol) in [
        (3, "jpeg", 14),
        (4, "gif", 24),
        (5, "webp", 4),
        (6, "jpeg data URL", 14),
    ] {
        let it = item(key);
        let px = draw(&mut h, &[Layer::Image(it)], 1.0);
        assert!(check_grid(&px, &it, 1.0, tol, what) >= 30);
    }
}

fn base64_of(b: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::new();
    for c in b.chunks(3) {
        let n = (c[0] as u32) << 16
            | (*c.get(1).unwrap_or(&0) as u32) << 8
            | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= c.len() {
                s.push(T[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                s.push('=');
            }
        }
    }
    s
}

#[test]
fn an_svg_sticky_is_sharp_at_every_zoom() {
    let mut h = host();
    // A Notability sticky as the importer makes it (images.ts `solidImage`), sent as its data URL.
    let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100.00 60.00" preserveAspectRatio="none"><rect width="100.00" height="60.00" rx="12.00" fill="#FFF48E"/></svg>"##;
    let url = format!(
        "data:image/svg+xml;charset=utf-8,{}",
        svg.replace('%', "%25")
            .replace('<', "%3C")
            .replace('>', "%3E")
            .replace('"', "%22")
            .replace('#', "%23")
            .replace(' ', "%20")
    );
    let src = h.library().insert(7, url.as_bytes()).expect("svg");
    assert_eq!((src.width, src.height), (100, 60));
    let it = ImageItem::new(7, 20.0, 20.0, 100.0, 60.0);
    for scale in [1.0f32, 2.5, 4.0] {
        let px = draw(&mut h, &[Layer::Image(it)], scale);
        let (x, y) = screen(&it, 0.5, 0.5, scale);
        assert_eq!(
            at(&px, x, y),
            [0xFF, 0xF4, 0x8E],
            "the sticky's colour at {scale}x"
        );
        // The rounded corner: paper just inside the box's corner.
        let (x, y) = ((it.x + 1.0) * scale, (it.y + 1.0) * scale);
        assert_eq!(
            at(&px, x, y),
            [255, 255, 255],
            "the rounded corner at {scale}x"
        );
        // The straight edge is sharp: one device px across from paper to the colour.
        let y = (it.y + it.h / 2.0) * scale;
        let x0 = it.x * scale;
        let outside = at(&px, x0 - 1.5, y);
        let inside = at(&px, x0 + 1.5, y);
        assert_eq!(outside, [255, 255, 255], "left of the edge at {scale}x");
        assert_eq!(inside, [0xFF, 0xF4, 0x8E], "right of the edge at {scale}x");
    }
    // The texture follows the zoom: at 4x the sticky is 400 x 240 device px, its texture as large.
    let st = h.stats();
    assert!(st.pictures >= 1);
}

#[test]
fn pictures_lie_between_the_ink_layers() {
    let mut h = host();
    h.library().insert(1, &quad_png(64, 48)).expect("png");
    let line = |id: &str, y: f64, color: &str| Stroke {
        id: id.into(),
        tool: "pen".into(),
        color: color.into(),
        width: 6.0,
        opacity: 1.0,
        points: (0..=20)
            .map(|i| Point {
                x: 20.0 + 340.0 * i as f64 / 20.0,
                y,
                pressure: 0.5,
                t: Some(i as f64 * 8.0),
                ..Default::default()
            })
            .collect(),
        ..Default::default()
    };
    let under = [line("under", 80.0, "#000000")];
    let over = [line("over", 140.0, "#0000ff")];
    let it = item(1);
    let px = draw(
        &mut h,
        &[Layer::Ink(&under), Layer::Image(it), Layer::Ink(&over)],
        1.0,
    );
    // The stroke made before the picture: hidden under it, shown beside it.
    assert_eq!(
        at(&px, 100.0, 80.0),
        QUAD[0],
        "the picture over the older stroke"
    );
    assert!(
        at(&px, 30.0, 80.0)[0] < 80,
        "the older stroke beside the picture"
    );
    // The stroke made after it: over it.
    let o = at(&px, 100.0, 140.0);
    assert!(
        o[2] > 200 && o[0] < 60,
        "the newer stroke over the picture: {o:?}"
    );
}

#[test]
fn a_huge_file_is_drawn_from_a_band_within_the_limits() {
    let mut h = host();
    let t0 = std::time::Instant::now();
    let big = quad_png(12000, 9000);
    let src = h.library().insert(8, &big).expect("png");
    drop(big);
    assert_eq!((src.width, src.height), (12000, 9000));
    // 600 x 450 page px: at 1x the band of 750 x 562 (12000 / 16).
    let it = ImageItem::new(8, 0.0, 0.0, 600.0, 450.0);
    for scale in [0.5f32, 1.0, 20.0] {
        let px = draw(&mut h, &[Layer::Image(it)], scale);
        let st = h.stats();
        assert_eq!(st.pictures, 1);
        assert!(
            st.picture_bytes <= st.picture_budget,
            "{} bytes over the budget {}",
            st.picture_bytes,
            st.picture_budget
        );
        // Each quadrant's colour where it shows on the 400 x 300 target.
        for (fx, fy) in [(0.1, 0.1), (0.9, 0.1), (0.1, 0.9), (0.9, 0.9)] {
            let (x, y) = screen(&it, fx, fy, scale);
            if x < W as f32 && y < H as f32 {
                assert_eq!(at(&px, x, y), quadrant(fx, fy), "at {scale}x, ({fx}, {fy})");
            }
        }
        eprintln!(
            "12000 x 9000 at {scale}x: {} texture bytes (budget {}), {:.1} s so far",
            st.picture_bytes,
            st.picture_budget,
            t0.elapsed().as_secs_f64()
        );
    }
    // At 0.5x it is 300 x 225 device px: the 375 x 281 band, 375 x 281 x 4 x 4/3 bytes.
    let px = draw(&mut h, &[Layer::Image(it)], 0.5);
    drop(px);
    let st = h.stats();
    assert!(
        st.picture_bytes < 1 << 20,
        "a small band once small again: {}",
        st.picture_bytes
    );
}

#[test]
fn the_textures_stay_within_their_budget() {
    let mut h = host();
    let budget = h.stats().picture_budget;
    // Pictures of a third of the budget each (mip levels included), shown one after the other:
    // the earlier ones go as the later ones come.
    let side = (((budget / 3) as f64 * 0.75 / 4.0).sqrt() as u32).min(8192);
    let mut keys = Vec::new();
    for k in 0..5u64 {
        let c = [40 * k as u8, 200, 100];
        let img = image::RgbImage::from_pixel(side, side, image::Rgb(c));
        h.library()
            .insert(100 + k, &encode(img.into(), image::ImageFormat::Png))
            .expect("png");
        keys.push((100 + k, c));
    }
    for (key, c) in &keys {
        // Shown at its own size in device px: the whole file is needed.
        let it = ImageItem::new(*key, 0.0, 0.0, side as f32, side as f32);
        let px = draw(&mut h, &[Layer::Image(it)], 1.0);
        let st = h.stats();
        assert!(
            st.picture_bytes <= st.picture_budget,
            "{} > {}",
            st.picture_bytes,
            st.picture_budget
        );
        assert_eq!(at(&px, 100.0, 100.0), *c, "picture {key}");
    }
}
