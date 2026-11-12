use crate::builder::{FillMode, RenderOp, RenderOpKind};
use crate::capsule::{sd_piece, Capsule};
use crate::color::Rgba;
use crate::paper::render_paper_background;
use model::{NotePage, PaperColor, PaperStyle};
use nib::geometry::XY;

#[derive(Clone, Debug)]
pub struct PixelBuffer {
    pub width: usize,
    pub height: usize,
    pub data: Vec<u8>,
}

impl PixelBuffer {
    pub fn new(width: usize, height: usize) -> Self {
        Self {
            width,
            height,
            data: vec![0; width * height * 4],
        }
    }

    pub fn clear(&mut self, color: Rgba) {
        let b = color.to_u8_array();
        for chunk in self.data.chunks_exact_mut(4) {
            chunk.copy_from_slice(&b);
        }
    }

    #[inline]
    pub fn get_pixel(&self, x: usize, y: usize) -> [u8; 4] {
        let idx = (y * self.width + x) * 4;
        [
            self.data[idx],
            self.data[idx + 1],
            self.data[idx + 2],
            self.data[idx + 3],
        ]
    }

    #[inline]
    pub fn set_pixel(&mut self, x: usize, y: usize, rgba: [u8; 4]) {
        let idx = (y * self.width + x) * 4;
        self.data[idx] = rgba[0];
        self.data[idx + 1] = rgba[1];
        self.data[idx + 2] = rgba[2];
        self.data[idx + 3] = rgba[3];
    }
}

pub struct Renderer {
    pub scale: f64,
    pub origin_x: f64,
    pub origin_y: f64,
}

impl Renderer {
    pub fn new(scale: f64, origin_x: f64, origin_y: f64) -> Self {
        Self {
            scale,
            origin_x,
            origin_y,
        }
    }

    pub fn render_scene(
        &self,
        target: &mut PixelBuffer,
        ops: &[RenderOp],
        paper_style: Option<PaperStyle>,
        paper_color: Option<&PaperColor>,
    ) {
        let w = target.width;
        let h = target.height;

        // 1. Paper Background
        if let (Some(style), Some(color)) = (paper_style, paper_color) {
            render_paper_background(
                &mut target.data,
                w,
                h,
                w * 4,
                style,
                color,
                self.scale,
                self.origin_x,
                self.origin_y,
            );
        }

        // 2. Highlighters first
        for op in ops {
            if let RenderOpKind::Highlighter { caps } = &op.kind {
                self.render_capsules(target, caps, op.color, false, 0.0);
            }
        }

        // 3. Fills
        for op in ops {
            if let RenderOpKind::Fill {
                area,
                mode,
                hatch_caps,
            } = &op.kind
            {
                self.render_fill(target, area, mode, hatch_caps, op.color);
            }
        }

        // 4. Glow (if any)
        for op in ops {
            if let RenderOpKind::Glow { caps, radius } = &op.kind {
                self.render_capsules(target, caps, op.color, true, *radius);
            }
        }

        // 5. Ink & Arrows
        for op in ops {
            match &op.kind {
                RenderOpKind::Ink { caps } => {
                    self.render_capsules(target, caps, op.color, false, 0.0);
                }
                RenderOpKind::Arrow { points } => {
                    self.render_arrow(target, points, op.color);
                }
                _ => {}
            }
        }
    }

    fn render_capsules(
        &self,
        target: &mut PixelBuffer,
        caps: &[Capsule],
        color: Rgba,
        is_glow: bool,
        glow_radius: f64,
    ) {
        if caps.is_empty() {
            return;
        }

        let w = target.width;
        let h = target.height;
        let scale = self.scale;
        let ox = self.origin_x;
        let oy = self.origin_y;

        // Compute stroke bounding box
        let pad = if is_glow { glow_radius * 2.5 } else { 2.0 / scale };
        let mut min_bx = f64::INFINITY;
        let mut min_by = f64::INFINITY;
        let mut max_bx = f64::NEG_INFINITY;
        let mut max_by = f64::NEG_INFINITY;

        for c in caps {
            let (b0, b1, b2, b3) = c.bounds();
            min_bx = min_bx.min(b0);
            min_by = min_by.min(b1);
            max_bx = max_bx.max(b2);
            max_by = max_by.max(b3);
        }

        let px0 = ((min_bx - pad + ox) * scale).floor().max(0.0) as usize;
        let py0 = ((min_by - pad + oy) * scale).floor().max(0.0) as usize;
        let px1 = ((max_bx + pad + ox) * scale).ceil().min((w - 1) as f64) as usize;
        let py1 = ((max_by + pad + oy) * scale).ceil().min((h - 1) as f64) as usize;

        if px0 >= w || py0 >= h || px0 > px1 || py0 > py1 {
            return;
        }

        let box_w = px1 - px0 + 1;
        let box_h = py1 - py0 + 1;
        let mut cov_map = vec![0.0f32; box_w * box_h];

        for c in caps {
            let (cb0, cb1, cb2, cb3) = c.bounds();
            let c_px0 = ((cb0 - pad + ox) * scale).floor().max(px0 as f64) as usize;
            let c_py0 = ((cb1 - pad + oy) * scale).floor().max(py0 as f64) as usize;
            let c_px1 = ((cb2 + pad + ox) * scale).ceil().min(px1 as f64) as usize;
            let c_py1 = ((cb3 + pad + oy) * scale).ceil().min(py1 as f64) as usize;

            for y in c_py0..=c_py1 {
                let sy = (y as f64 / scale) - oy;
                let row_idx = (y - py0) * box_w;
                for x in c_px0..=c_px1 {
                    let sx = (x as f64 / scale) - ox;
                    let d = sd_piece(sx, sy, c.ax, c.ay, c.bx, c.by, c.ra, c.rb);

                    let cov = if is_glow {
                        let sg = glow_radius * 0.5;
                        let rr = c.ra + c.rb;
                        let e1 = 1.0 / (1.0 + (1.702 * d / sg).exp());
                        let e2 = 1.0 / (1.0 + (1.702 * (d + rr) / sg).exp());
                        (e1 - e2).max(0.0) as f32
                    } else {
                        (0.5 - d * scale).clamp(0.0, 1.0) as f32
                    };

                    if cov > 0.004 {
                        let idx = row_idx + (x - px0);
                        if cov > cov_map[idx] {
                            cov_map[idx] = cov;
                        }
                    }
                }
            }
        }

        // Blend stroke into target buffer
        for y in py0..=py1 {
            let row_idx = (y - py0) * box_w;
            for x in px0..=px1 {
                let cov = cov_map[row_idx + (x - px0)];
                if cov > 0.004 {
                    let idx = (y * w + x) * 4;
                    let dst_r = target.data[idx] as f32 / 255.0;
                    let dst_g = target.data[idx + 1] as f32 / 255.0;
                    let dst_b = target.data[idx + 2] as f32 / 255.0;
                    let dst_a = target.data[idx + 3] as f32 / 255.0;

                    let src_a = color.a * cov;
                    let src_r = color.r * src_a;
                    let src_g = color.g * src_a;
                    let src_b = color.b * src_a;

                    let out_a = src_a + dst_a * (1.0 - src_a);
                    if out_a > 0.0 {
                        let out_r = (src_r + dst_r * dst_a * (1.0 - src_a)) / out_a;
                        let out_g = (src_g + dst_g * dst_a * (1.0 - src_a)) / out_a;
                        let out_b = (src_b + dst_b * dst_a * (1.0 - src_a)) / out_a;

                        target.data[idx] = (out_r.clamp(0.0, 1.0) * 255.0).round() as u8;
                        target.data[idx + 1] = (out_g.clamp(0.0, 1.0) * 255.0).round() as u8;
                        target.data[idx + 2] = (out_b.clamp(0.0, 1.0) * 255.0).round() as u8;
                        target.data[idx + 3] = (out_a.clamp(0.0, 1.0) * 255.0).round() as u8;
                    }
                }
            }
        }
    }

    fn render_fill(
        &self,
        target: &mut PixelBuffer,
        area: &[XY],
        mode: &FillMode,
        hatch_caps: &[Capsule],
        color: Rgba,
    ) {
        if area.len() < 3 {
            return;
        }

        let w = target.width;
        let h = target.height;
        let scale = self.scale;
        let ox = self.origin_x;
        let oy = self.origin_y;

        // Transform area vertices to pixel coordinates
        let pts: Vec<(f64, f64)> = area
            .iter()
            .map(|p| ((p.x + ox) * scale, (p.y + oy) * scale))
            .collect();

        let mut min_y = f64::INFINITY;
        let mut max_y = f64::NEG_INFINITY;
        for p in &pts {
            min_y = min_y.min(p.1);
            max_y = max_y.max(p.1);
        }

        let py0 = min_y.floor().max(0.0) as usize;
        let py1 = max_y.ceil().min((h - 1) as f64) as usize;

        if py0 >= h || py0 > py1 {
            return;
        }

        if *mode == FillMode::Hatch {
            // Render hatch capsules
            self.render_capsules(target, hatch_caps, color, false, 0.0);
            return;
        }

        // Even-odd scanline filling for Solid and Hole
        let n = pts.len();
        for y in py0..=py1 {
            let scan_y = y as f64 + 0.5;
            let mut nodes = Vec::new();

            let mut j = n - 1;
            for i in 0..n {
                let (xi, yi) = pts[i];
                let (xj, yj) = pts[j];

                if (yi < scan_y && yj >= scan_y) || (yj < scan_y && yi >= scan_y) {
                    let node_x = xi + (scan_y - yi) / (yj - yi) * (xj - xi);
                    nodes.push(node_x);
                }
                j = i;
            }

            nodes.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

            for chunk in nodes.chunks_exact(2) {
                let x0 = chunk[0].floor().max(0.0) as usize;
                let x1 = chunk[1].ceil().min((w - 1) as f64) as usize;

                if x0 <= x1 && x0 < w {
                    for x in x0..=x1 {
                        let idx = (y * w + x) * 4;
                        if *mode == FillMode::Hole {
                            // Punch hole (clear/destination-out)
                            target.data[idx] = 0;
                            target.data[idx + 1] = 0;
                            target.data[idx + 2] = 0;
                            target.data[idx + 3] = 0;
                        } else {
                            // Solid fill blend
                            let dst_r = target.data[idx] as f32 / 255.0;
                            let dst_g = target.data[idx + 1] as f32 / 255.0;
                            let dst_b = target.data[idx + 2] as f32 / 255.0;
                            let dst_a = target.data[idx + 3] as f32 / 255.0;

                            let src_a = color.a;
                            let src_r = color.r * src_a;
                            let src_g = color.g * src_a;
                            let src_b = color.b * src_a;

                            let out_a = src_a + dst_a * (1.0 - src_a);
                            if out_a > 0.0 {
                                let out_r = (src_r + dst_r * dst_a * (1.0 - src_a)) / out_a;
                                let out_g = (src_g + dst_g * dst_a * (1.0 - src_a)) / out_a;
                                let out_b = (src_b + dst_b * dst_a * (1.0 - src_a)) / out_a;

                                target.data[idx] = (out_r.clamp(0.0, 1.0) * 255.0).round() as u8;
                                target.data[idx + 1] =
                                    (out_g.clamp(0.0, 1.0) * 255.0).round() as u8;
                                target.data[idx + 2] =
                                    (out_b.clamp(0.0, 1.0) * 255.0).round() as u8;
                                target.data[idx + 3] =
                                    (out_a.clamp(0.0, 1.0) * 255.0).round() as u8;
                            }
                        }
                    }
                }
            }
        }
    }

    fn render_arrow(&self, target: &mut PixelBuffer, pts: &[XY; 3], color: Rgba) {
        let w = target.width;
        let h = target.height;
        let scale = self.scale;
        let ox = self.origin_x;
        let oy = self.origin_y;

        let p: [(f64, f64); 3] = [
            ((pts[0].x + ox) * scale, (pts[0].y + oy) * scale),
            ((pts[1].x + ox) * scale, (pts[1].y + oy) * scale),
            ((pts[2].x + ox) * scale, (pts[2].y + oy) * scale),
        ];

        let min_x = p[0].0.min(p[1].0).min(p[2].0).floor().max(0.0) as usize;
        let max_x = p[0].0.max(p[1].0).max(p[2].0).ceil().min((w - 1) as f64) as usize;
        let min_y = p[0].1.min(p[1].1).min(p[2].1).floor().max(0.0) as usize;
        let max_y = p[0].1.max(p[1].1).max(p[2].1).ceil().min((h - 1) as f64) as usize;

        if min_x > max_x || min_y > max_y {
            return;
        }

        let edge = |a: (f64, f64), b: (f64, f64), c: (f64, f64)| -> f64 {
            (c.0 - a.0) * (b.1 - a.1) - (c.1 - a.1) * (b.0 - a.0)
        };

        let area = edge(p[0], p[1], p[2]);
        if area.abs() < 1e-4 {
            return;
        }

        for y in min_y..=max_y {
            let py = y as f64 + 0.5;
            for x in min_x..=max_x {
                let px = x as f64 + 0.5;
                let pt = (px, py);
                let w0 = edge(p[1], p[2], pt);
                let w1 = edge(p[2], p[0], pt);
                let w2 = edge(p[0], p[1], pt);

                let inside = if area > 0.0 {
                    w0 >= 0.0 && w1 >= 0.0 && w2 >= 0.0
                } else {
                    w0 <= 0.0 && w1 <= 0.0 && w2 <= 0.0
                };

                if inside {
                    let idx = (y * w + x) * 4;
                    let dst_r = target.data[idx] as f32 / 255.0;
                    let dst_g = target.data[idx + 1] as f32 / 255.0;
                    let dst_b = target.data[idx + 2] as f32 / 255.0;
                    let dst_a = target.data[idx + 3] as f32 / 255.0;

                    let src_a = color.a;
                    let src_r = color.r * src_a;
                    let src_g = color.g * src_a;
                    let src_b = color.b * src_a;

                    let out_a = src_a + dst_a * (1.0 - src_a);
                    if out_a > 0.0 {
                        let out_r = (src_r + dst_r * dst_a * (1.0 - src_a)) / out_a;
                        let out_g = (src_g + dst_g * dst_a * (1.0 - src_a)) / out_a;
                        let out_b = (src_b + dst_b * dst_a * (1.0 - src_a)) / out_a;

                        target.data[idx] = (out_r.clamp(0.0, 1.0) * 255.0).round() as u8;
                        target.data[idx + 1] = (out_g.clamp(0.0, 1.0) * 255.0).round() as u8;
                        target.data[idx + 2] = (out_b.clamp(0.0, 1.0) * 255.0).round() as u8;
                        target.data[idx + 3] = (out_a.clamp(0.0, 1.0) * 255.0).round() as u8;
                    }
                }
            }
        }
    }
}

pub fn render_page_thumbnail(page: &NotePage, width: usize, height: usize) -> PixelBuffer {
    let mut buf = PixelBuffer::new(width, height);
    let scale = (width as f64 / 816.0).min(height as f64 / 1056.0);
    let renderer = Renderer::new(scale, 0.0, 0.0);

    let mut ops = Vec::new();
    for s in &page.strokes {
        ops.extend(crate::builder::build_stroke_ops(s));
    }

    let default_color = PaperColor::Name("white".to_string());
    renderer.render_scene(&mut buf, &ops, Some(PaperStyle::Ruled), Some(&default_color));
    buf
}
