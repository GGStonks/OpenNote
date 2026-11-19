//! The passes that draw a frame. TypeScript counterpart: `src/ink/glInk.ts` `GlInk.draw` and its
//! `layOn` (each page through its transform: the desk, the paper, then the ops in order; a
//! coverage run drawn into the R8 coverage texture with max blend and composited once; fills by
//! even-odd stencil; holes erase; hatches are capsules under the stencil; arrowheads flat).
//!
//! Every scissor is clamped to the size of the pass's own target (the coverage and stencil
//! textures are made at the target's size each frame), and a page whose transform or box is not
//! finite is skipped before any GPU call.

use crate::frame::{clamp_rgba, drawable_tf, Frame, PageDraw};
use crate::gpu::{GpuCanvas, GpuScene, Uniforms, UNIFORM_STRIDE};
use crate::paper::Paper;
use crate::scene::{Op, PageBox, Transform};
use bytemuck::Zeroable;
use renderer::builder::FillMode;
use renderer::color::Rgba;

#[derive(Clone, Copy)]
struct SeeItem {
    s0: usize,
    s1: usize,
    first: u32,
    count: u32,
    sc: (u32, u32, u32, u32),
}

#[derive(Clone, Copy)]
struct FlatItem {
    s0: usize,
    first: u32,
    count: u32,
    sc: (u32, u32, u32, u32),
}

/// The textures a frame's passes draw into.
#[derive(Clone, Copy)]
struct Views<'a> {
    target: &'a wgpu::TextureView,
    stencil: &'a wgpu::TextureView,
    cov_view: &'a wgpu::TextureView,
    cov_bg: &'a wgpu::BindGroup,
}

impl GpuCanvas {
    /// The device rect (x, y, w, h) of a page box padded by `pad` device px, clipped to the target; None when empty.
    fn scissor(&self, b: &PageBox, tf: &Transform, pad: f32) -> Option<(u32, u32, u32, u32)> {
        if self.size.0 == 0 || self.size.1 == 0 {
            return None;
        }
        let (w, h) = (self.size.0 as f32, self.size.1 as f32);
        let corners = [
            tf.apply(b.x0, b.y0),
            tf.apply(b.x1, b.y0),
            tf.apply(b.x0, b.y1),
            tf.apply(b.x1, b.y1),
        ];
        let x0 = corners.iter().map(|c| c.0).fold(f32::INFINITY, f32::min) - pad;
        let y0 = corners.iter().map(|c| c.1).fold(f32::INFINITY, f32::min) - pad;
        let x1 = corners
            .iter()
            .map(|c| c.0)
            .fold(f32::NEG_INFINITY, f32::max)
            + pad;
        let y1 = corners
            .iter()
            .map(|c| c.1)
            .fold(f32::NEG_INFINITY, f32::max)
            + pad;
        if !x0.is_finite() || !y0.is_finite() || !x1.is_finite() || !y1.is_finite() {
            return None;
        }
        let (x0, y0, x1, y1) = (
            x0.floor().max(0.0),
            y0.floor().max(0.0),
            x1.ceil().min(w),
            y1.ceil().min(h),
        );
        if x1 <= x0 || y1 <= y0 {
            return None;
        }
        let sx = (x0 as u32).min(self.size.0);
        let sy = (y0 as u32).min(self.size.1);
        let sw = ((x1 - x0) as u32).min(self.size.0.saturating_sub(sx));
        let sh = ((y1 - y0) as u32).min(self.size.1.saturating_sub(sy));
        if sw == 0 || sh == 0 {
            return None;
        }
        Some((sx, sy, sw, sh))
    }

    /// Draws `scene` onto `target` (`w` x `h` device px) through `tf`, over `paper` (None: a
    /// see-through target). One command buffer; submitted here.
    pub fn draw(
        &mut self,
        target: &wgpu::TextureView,
        w: u32,
        h: u32,
        scene: &GpuScene,
        tf: &Transform,
        paper: Option<Rgba>,
    ) -> bool {
        self.draw_frame(
            target,
            w,
            h,
            &Frame {
                clear: paper,
                pages: vec![PageDraw {
                    scene,
                    tf: *tf,
                    paper: None,
                }],
            },
        )
    }

    /// Draws a frame: the desk (or nothing), then each page's paper and scene through its
    /// transform. One command buffer; submitted here.
    ///
    /// `w` x `h` must be the target's own size: the coverage and stencil textures are made at it,
    /// and every scissor is clamped to it. False (nothing drawn, the error recorded) when it is
    /// zero or larger than the device's textures.
    pub fn draw_frame(
        &mut self,
        target: &wgpu::TextureView,
        w: u32,
        h: u32,
        frame: &Frame,
    ) -> bool {
        if w == 0 || h == 0 || w > self.max_dim || h > self.max_dim {
            self.health
                .record(&format!("target {w} x {h} outside 1..{}", self.max_dim));
            return false;
        }
        self.ensure_size(w, h);
        if frame.pages.len() > self.rects_capacity {
            self.rects_capacity = frame.pages.len().next_power_of_two();
            self.rects = self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("rects"),
                size: (self.rects_capacity * 6 * 8) as u64,
                usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
        }
        let premul = |c: [f32; 4]| [c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]];

        self.slots_scratch.clear();
        self.rects_scratch.clear();
        self.plan_scratch.clear();
        self.bytes_scratch.clear();

        // Slots the uniform buffer can hold on this device.
        let room =
            (self.max_buffer / UNIFORM_STRIDE).min(u32::MAX as u64 / UNIFORM_STRIDE) as usize;
        for (pi, page) in frame.pages.iter().enumerate() {
            let tf = &page.tf;
            let drawable = drawable_tf(tf);
            if !drawable || self.slots_scratch.len() + 1 + 2 * page.scene.ops.len() > room {
                if drawable {
                    self.health
                        .record("frame too large for one uniform buffer: pages left out");
                }
                self.rects_scratch.extend([[0.0f32; 2]; 6]);
                continue;
            }
            let base = Uniforms {
                m: [tf.a, tf.b, tf.c, tf.d],
                t: [tf.ox, tf.oy],
                size: [w as f32, h as f32],
                px: tf.px(),
                ..Uniforms::zeroed()
            };
            let paper_slot = page.paper.filter(Paper::is_drawable).map(|p| {
                self.slots_scratch.push(p.uniforms(&base));
                for (x, y) in [
                    (0.0, 0.0),
                    (p.width, 0.0),
                    (0.0, p.height),
                    (p.width, 0.0),
                    (p.width, p.height),
                    (0.0, p.height),
                ] {
                    self.rects_scratch.push([x, y]);
                }
                self.slots_scratch.len() - 1
            });
            if paper_slot.is_none() {
                self.rects_scratch.extend([[0.0f32; 2]; 6]);
            }
            let mut slot_of: Vec<(usize, usize)> = Vec::with_capacity(page.scene.ops.len());
            for op in &page.scene.ops {
                match op {
                    Op::See { col, .. } => {
                        self.slots_scratch.push(Uniforms { cov: 1, ..base });
                        self.slots_scratch.push(Uniforms {
                            col: premul(*col),
                            ..base
                        });
                        slot_of.push((self.slots_scratch.len() - 2, self.slots_scratch.len() - 1));
                    }
                    Op::Fill { mode, col, .. } => {
                        self.slots_scratch.push(base);
                        self.slots_scratch.push(Uniforms {
                            col: if *mode == FillMode::Hole {
                                [0.0, 0.0, 0.0, 1.0]
                            } else {
                                premul(*col)
                            },
                            ..base
                        });
                        slot_of.push((self.slots_scratch.len() - 2, self.slots_scratch.len() - 1));
                    }
                    Op::Flat { col, .. } => {
                        self.slots_scratch.push(Uniforms {
                            col: premul(*col),
                            ..base
                        });
                        slot_of.push((self.slots_scratch.len() - 1, self.slots_scratch.len() - 1));
                    }
                }
            }
            self.plan_scratch.push((pi, paper_slot, slot_of));
        }
        if self.slots_scratch.is_empty() {
            self.slots_scratch.push(Uniforms::zeroed());
        }
        if self.slots_scratch.len() as u64 > self.uniform_capacity {
            self.uniform_capacity = (self.slots_scratch.len() as u64).next_power_of_two();
            let (b, bg) =
                Self::uniform_buffer(&self.device, &self.uniform_bgl, self.uniform_capacity);
            self.uniforms = b;
            self.uniform_bg = bg;
        }
        let needed_bytes = self.slots_scratch.len() * UNIFORM_STRIDE as usize;
        self.bytes_scratch.resize(needed_bytes, 0);
        for (i, s) in self.slots_scratch.iter().enumerate() {
            let offset = i * UNIFORM_STRIDE as usize;
            self.bytes_scratch[offset..offset + std::mem::size_of::<Uniforms>()]
                .copy_from_slice(bytemuck::bytes_of(s));
        }
        self.queue
            .write_buffer(&self.uniforms, 0, &self.bytes_scratch);
        if !self.rects_scratch.is_empty() {
            self.queue
                .write_buffer(&self.rects, 0, bytemuck::cast_slice(&self.rects_scratch));
        }
        let offset = |slot: usize| (slot as u64 * UNIFORM_STRIDE) as u32;

        let (Some((_, cov_view, cov_bg)), Some(stencil)) =
            (self.cov_tex.as_ref(), self.stencil.as_ref())
        else {
            return false;
        };
        let views = Views {
            target,
            stencil,
            cov_view,
            cov_bg,
        };
        let mut enc = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("canvas"),
            });

        // 1. Initial "desk" pass (clears target + stencil), drawing paper directly inside it!
        {
            let clear = frame
                .clear
                .map(clamp_rgba)
                .map(|p| wgpu::Color {
                    r: p.r as f64,
                    g: p.g as f64,
                    b: p.b as f64,
                    a: p.a as f64,
                })
                .unwrap_or(wgpu::Color::TRANSPARENT);
            let mut p = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("desk"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: target,
                    resolve_target: None,
                    depth_slice: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(clear),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: stencil,
                    depth_ops: None,
                    stencil_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Clear(0),
                        store: wgpu::StoreOp::Store,
                    }),
                }),
                ..Default::default()
            });
            let mut paper_bound = false;
            for (pi, paper_slot, _) in &self.plan_scratch {
                let page = &frame.pages[*pi];
                if let (Some(ps), Some(paper)) = (paper_slot, page.paper) {
                    let bx = PageBox {
                        x0: 0.0,
                        y0: 0.0,
                        x1: paper.width,
                        y1: paper.height,
                    };
                    if let Some(sc) = self.scissor(&bx, &page.tf, 0.5) {
                        if !paper_bound {
                            p.set_bind_group(1, cov_bg, &[]);
                            p.set_stencil_reference(0);
                            p.set_pipeline(&self.paper);
                            p.set_vertex_buffer(0, self.rects.slice(..));
                            paper_bound = true;
                        }
                        p.set_scissor_rect(sc.0, sc.1, sc.2, sc.3);
                        p.set_bind_group(0, &self.uniform_bg, &[offset(*ps)]);
                        let v0 = (*pi * 6) as u32;
                        p.draw(v0..v0 + 6, 0..1);
                    }
                }
            }
        }

        let scissor_overlaps = |a: (u32, u32, u32, u32), b: (u32, u32, u32, u32)| -> bool {
            !(a.0 + a.2 <= b.0 || b.0 + b.2 <= a.0 || a.1 + a.3 <= b.1 || b.1 + b.3 <= a.1)
        };

        let mut see_batch: Vec<SeeItem> = Vec::new();
        let mut flat_batch: Vec<FlatItem> = Vec::new();

        for (pi, _, slot_of) in &self.plan_scratch {
            let page = &frame.pages[*pi];
            let (tf, scene) = (&page.tf, page.scene);

            for (i, op) in scene.ops.iter().enumerate() {
                let (s0, s1) = slot_of[i];
                match op {
                    Op::See {
                        first, count, bx, ..
                    } => {
                        if !flat_batch.is_empty() {
                            self.flush_flat(
                                &mut enc,
                                &views,
                                scene.flat.slice(..),
                                &mut flat_batch,
                            );
                        }
                        if *count == 0 {
                            continue;
                        }
                        let Some(sc) = self.scissor(bx, tf, 1.5) else {
                            continue;
                        };
                        if see_batch.iter().any(|item| scissor_overlaps(item.sc, sc)) {
                            self.flush_see(&mut enc, &views, scene.caps.slice(..), &mut see_batch);
                        }
                        see_batch.push(SeeItem {
                            s0,
                            s1,
                            first: *first,
                            count: *count,
                            sc,
                        });
                    }
                    Op::Fill {
                        first,
                        count,
                        mode,
                        bx,
                        box_first,
                        hatch_first,
                        hatch_count,
                        ..
                    } => {
                        if !see_batch.is_empty() {
                            self.flush_see(&mut enc, &views, scene.caps.slice(..), &mut see_batch);
                        }
                        if !flat_batch.is_empty() {
                            self.flush_flat(
                                &mut enc,
                                &views,
                                scene.flat.slice(..),
                                &mut flat_batch,
                            );
                        }
                        let Some(sc) = self.scissor(bx, tf, 1.5) else {
                            continue;
                        };
                        let mut p = target_pass(&mut enc, target, stencil, "fill", true);
                        p.set_scissor_rect(sc.0, sc.1, sc.2, sc.3);
                        p.set_bind_group(1, cov_bg, &[]);
                        p.set_stencil_reference(0);
                        p.set_bind_group(0, &self.uniform_bg, &[offset(s0)]);
                        p.set_pipeline(&self.fill_stencil);
                        p.set_vertex_buffer(0, scene.flat.slice(..));
                        p.draw(*first..*first + *count, 0..1);
                        p.set_bind_group(0, &self.uniform_bg, &[offset(s1)]);
                        match mode {
                            FillMode::Hatch => {
                                p.set_pipeline(&self.caps_hatch);
                                p.set_vertex_buffer(0, scene.caps.slice(..));
                                p.draw(0..4, *hatch_first..*hatch_first + *hatch_count);
                            }
                            FillMode::Solid | FillMode::Hole => {
                                p.set_pipeline(if *mode == FillMode::Hole {
                                    &self.flat_hole
                                } else {
                                    &self.flat_box
                                });
                                p.set_vertex_buffer(0, scene.flat.slice(..));
                                p.draw(*box_first..*box_first + 6, 0..1);
                            }
                        }
                    }
                    Op::Flat {
                        first, count, bx, ..
                    } => {
                        if !see_batch.is_empty() {
                            self.flush_see(&mut enc, &views, scene.caps.slice(..), &mut see_batch);
                        }
                        if *count == 0 {
                            continue;
                        }
                        let Some(sc) = self.scissor(bx, tf, 1.5) else {
                            continue;
                        };
                        flat_batch.push(FlatItem {
                            s0,
                            first: *first,
                            count: *count,
                            sc,
                        });
                    }
                }
            }
            if !see_batch.is_empty() {
                self.flush_see(&mut enc, &views, scene.caps.slice(..), &mut see_batch);
            }
            if !flat_batch.is_empty() {
                self.flush_flat(&mut enc, &views, scene.flat.slice(..), &mut flat_batch);
            }
        }
        self.queue.submit([enc.finish()]);
        true
    }

    /// The batched coverage runs: drawn into the coverage texture, then composited.
    fn flush_see(
        &self,
        enc: &mut wgpu::CommandEncoder,
        views: &Views,
        scene_caps: wgpu::BufferSlice,
        batch: &mut Vec<SeeItem>,
    ) {
        let Views {
            target,
            stencil,
            cov_view,
            cov_bg,
        } = *views;
        let (uniform_bg, zero_cov, caps_cov, compose) = (
            &self.uniform_bg,
            &self.zero_cov,
            &self.caps_cov,
            &self.compose,
        );
        if batch.is_empty() {
            return;
        }
        let offset = |slot: usize| (slot as u64 * UNIFORM_STRIDE) as u32;
        {
            let mut p = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("coverage-batch"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: cov_view,
                    resolve_target: None,
                    depth_slice: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Load,
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                ..Default::default()
            });
            p.set_vertex_buffer(0, scene_caps);
            for item in batch.iter() {
                p.set_scissor_rect(item.sc.0, item.sc.1, item.sc.2, item.sc.3);
                p.set_bind_group(0, uniform_bg, &[offset(item.s0)]);
                p.set_pipeline(zero_cov);
                p.draw(0..3, 0..1);
                p.set_pipeline(caps_cov);
                p.draw(0..4, item.first..item.first + item.count);
            }
        }
        {
            let mut p = target_pass(enc, target, stencil, "compose-batch", false);
            p.set_pipeline(compose);
            p.set_bind_group(1, cov_bg, &[]);
            p.set_stencil_reference(0);
            for item in batch.iter() {
                p.set_scissor_rect(item.sc.0, item.sc.1, item.sc.2, item.sc.3);
                p.set_bind_group(0, uniform_bg, &[offset(item.s1)]);
                p.draw(0..3, 0..1);
            }
        }
        batch.clear();
    }

    /// The batched arrowheads.
    fn flush_flat(
        &self,
        enc: &mut wgpu::CommandEncoder,
        views: &Views,
        scene_flat: wgpu::BufferSlice,
        batch: &mut Vec<FlatItem>,
    ) {
        let Views {
            target,
            stencil,
            cov_bg,
            ..
        } = *views;
        let (uniform_bg, flat_plain) = (&self.uniform_bg, &self.flat_plain);
        if batch.is_empty() {
            return;
        }
        let offset = |slot: usize| (slot as u64 * UNIFORM_STRIDE) as u32;
        let mut p = target_pass(enc, target, stencil, "flat-batch", false);
        p.set_bind_group(1, cov_bg, &[]);
        p.set_stencil_reference(0);
        p.set_pipeline(flat_plain);
        p.set_vertex_buffer(0, scene_flat);
        for item in batch.drain(..) {
            p.set_scissor_rect(item.sc.0, item.sc.1, item.sc.2, item.sc.3);
            p.set_bind_group(0, uniform_bg, &[offset(item.s0)]);
            p.draw(item.first..item.first + item.count, 0..1);
        }
    }
}

/// A pass on the target that keeps what is drawn (and the stencil, unless `clear_stencil`).
fn target_pass<'a>(
    enc: &'a mut wgpu::CommandEncoder,
    target: &'a wgpu::TextureView,
    stencil: &'a wgpu::TextureView,
    label: &'static str,
    clear_stencil: bool,
) -> wgpu::RenderPass<'a> {
    enc.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some(label),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view: target,
            resolve_target: None,
            depth_slice: None,
            ops: wgpu::Operations {
                load: wgpu::LoadOp::Load,
                store: wgpu::StoreOp::Store,
            },
        })],
        depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
            view: stencil,
            depth_ops: None,
            stencil_ops: Some(wgpu::Operations {
                load: if clear_stencil {
                    wgpu::LoadOp::Clear(0)
                } else {
                    wgpu::LoadOp::Load
                },
                store: wgpu::StoreOp::Store,
            }),
        }),
        ..Default::default()
    })
}
