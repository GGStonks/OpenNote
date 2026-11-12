use crate::color::Rgba;
use model::{PaperColor, PaperStyle};

pub fn render_paper_background(
    pixels: &mut [u8],
    width: usize,
    height: usize,
    stride: usize,
    style: PaperStyle,
    color: &PaperColor,
    scale: f64,
    origin_x: f64,
    origin_y: f64,
) {
    let base_rgba = Rgba::parse(color.hex(), 1.0);
    let dark = color.is_dark();
    let base_bytes = base_rgba.to_u8_array();

    // Fill base color
    for y in 0..height {
        let row_start = y * stride;
        for x in 0..width {
            let idx = row_start + x * 4;
            pixels[idx] = base_bytes[0];
            pixels[idx + 1] = base_bytes[1];
            pixels[idx + 2] = base_bytes[2];
            pixels[idx + 3] = base_bytes[3];
        }
    }

    if style == PaperStyle::Blank {
        return;
    }

    let blend_pixel = |pixels: &mut [u8], px: usize, py: usize, c: Rgba| {
        if px >= width || py >= height {
            return;
        }
        let idx = py * stride + px * 4;
        let dst_r = pixels[idx] as f32 / 255.0;
        let dst_g = pixels[idx + 1] as f32 / 255.0;
        let dst_b = pixels[idx + 2] as f32 / 255.0;
        let dst_a = pixels[idx + 3] as f32 / 255.0;

        let src_a = c.a;
        let out_a = src_a + dst_a * (1.0 - src_a);
        if out_a > 0.0 {
            let out_r = (c.r * src_a + dst_r * dst_a * (1.0 - src_a)) / out_a;
            let out_g = (c.g * src_a + dst_g * dst_a * (1.0 - src_a)) / out_a;
            let out_b = (c.b * src_a + dst_b * dst_a * (1.0 - src_a)) / out_a;
            pixels[idx] = (out_r.clamp(0.0, 1.0) * 255.0).round() as u8;
            pixels[idx + 1] = (out_g.clamp(0.0, 1.0) * 255.0).round() as u8;
            pixels[idx + 2] = (out_b.clamp(0.0, 1.0) * 255.0).round() as u8;
            pixels[idx + 3] = (out_a.clamp(0.0, 1.0) * 255.0).round() as u8;
        }
    };

    match style {
        PaperStyle::Ruled | PaperStyle::Narrow | PaperStyle::Lines | PaperStyle::NarrowLines => {
            let gap_val = if style == PaperStyle::Narrow || style == PaperStyle::NarrowLines {
                24.0
            } else {
                32.0
            };
            let line_color = if dark {
                Rgba::new(1.0, 1.0, 1.0, 0.13)
            } else {
                Rgba::new(59.0 / 255.0, 130.0 / 255.0, 246.0 / 255.0, 0.22)
            };
            let margin_color = if dark {
                Rgba::new(239.0 / 255.0, 68.0 / 255.0, 68.0 / 255.0, 0.35)
            } else {
                Rgba::new(239.0 / 255.0, 68.0 / 255.0, 68.0 / 255.0, 0.40)
            };

            // Ruled lines start after top margin (80px)
            let mut y_page = 80.0;
            while (y_page * scale) < height as f64 {
                let py = (y_page * scale).round() as usize;
                if py < height {
                    for x in 0..width {
                        blend_pixel(pixels, x, py, line_color);
                    }
                }
                y_page += gap_val;
            }

            // Margin line (only for Ruled and Narrow, not Lines / NarrowLines)
            if style == PaperStyle::Ruled || style == PaperStyle::Narrow {
                let margin_x = (79.0 * scale).round() as usize;
                if margin_x < width {
                    for y in 0..height {
                        blend_pixel(pixels, margin_x, y, margin_color);
                    }
                }
            }
        }
        PaperStyle::Grid => {
            let grid_color = if dark {
                Rgba::new(1.0, 1.0, 1.0, 0.09)
            } else {
                Rgba::new(0.0, 0.0, 0.0, 0.08)
            };
            let step = 24.0;
            let mut x_page = ((origin_x % step) + step) % step;
            while (x_page * scale) < width as f64 {
                let px = (x_page * scale).round() as usize;
                if px < width {
                    for y in 0..height {
                        blend_pixel(pixels, px, y, grid_color);
                    }
                }
                x_page += step;
            }
            let mut y_page = ((origin_y % step) + step) % step;
            while (y_page * scale) < height as f64 {
                let py = (y_page * scale).round() as usize;
                if py < height {
                    for x in 0..width {
                        blend_pixel(pixels, x, py, grid_color);
                    }
                }
                y_page += step;
            }
        }
        PaperStyle::Graph => {
            let major_color = if dark {
                Rgba::new(1.0, 1.0, 1.0, 0.16)
            } else {
                Rgba::new(0.0, 0.0, 0.0, 0.13)
            };
            let minor_color = if dark {
                Rgba::new(1.0, 1.0, 1.0, 0.06)
            } else {
                Rgba::new(0.0, 0.0, 0.0, 0.05)
            };

            let step = 12.0;
            let mut x_page = ((origin_x % step) + step) % step;
            while (x_page * scale) < width as f64 {
                let px = (x_page * scale).round() as usize;
                if px < width {
                    let is_major = (x_page.round() as i64 % 60) == 0;
                    let c = if is_major { major_color } else { minor_color };
                    for y in 0..height {
                        blend_pixel(pixels, px, y, c);
                    }
                }
                x_page += step;
            }
            let mut y_page = ((origin_y % step) + step) % step;
            while (y_page * scale) < height as f64 {
                let py = (y_page * scale).round() as usize;
                if py < height {
                    let is_major = (y_page.round() as i64 % 60) == 0;
                    let c = if is_major { major_color } else { minor_color };
                    for x in 0..width {
                        blend_pixel(pixels, x, py, c);
                    }
                }
                y_page += step;
            }
        }
        PaperStyle::Dots => {
            let dot_color = if dark {
                Rgba::new(1.0, 1.0, 1.0, 0.28)
            } else {
                Rgba::new(0.0, 0.0, 0.0, 0.22)
            };
            let step = 24.0;
            let r = 1.3 * scale;
            let r2 = r * r;

            let mut y_page = 12.0 + (((origin_y % step) + step) % step);
            while (y_page * scale) < height as f64 {
                let cy = y_page * scale;
                let mut x_page = 12.0 + (((origin_x % step) + step) % step);
                while (x_page * scale) < width as f64 {
                    let cx = x_page * scale;

                    let min_px = (cx - r - 1.0).max(0.0).floor() as usize;
                    let max_px = (cx + r + 1.0).min(width as f64 - 1.0).ceil() as usize;
                    let min_py = (cy - r - 1.0).max(0.0).floor() as usize;
                    let max_py = (cy + r + 1.0).min(height as f64 - 1.0).ceil() as usize;

                    for py in min_py..=max_py {
                        for px in min_px..=max_px {
                            let dx = px as f64 - cx;
                            let dy = py as f64 - cy;
                            let dist2 = dx * dx + dy * dy;
                            if dist2 <= r2 {
                                let alpha = (1.0 - (dist2.sqrt() - r + 0.5).clamp(0.0, 1.0)) as f32;
                                blend_pixel(pixels, px, py, dot_color.with_alpha(dot_color.a * alpha));
                            }
                        }
                    }
                    x_page += step;
                }
                y_page += step;
            }
        }
        _ => {}
    }
}

