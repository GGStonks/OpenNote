//! The pictures' textures on the device: one per file in view, at the size the zoom needs, kept
//! within a memory budget. TypeScript counterpart: none (the browser keeps its decoded images);
//! the files and their decoding are picture.rs.
//!
//! Each frame, before anything is drawn (`prepare`): the pictures the worker decoded are
//! uploaded (all mip levels), then every picture on screen is given the size it needs there
//! (`picture::band`, from its box on screen and the part of its file shown); a texture smaller
//! than that, or two bands larger, is asked for again, and the one it has is drawn meanwhile (a
//! picture not decoded yet is not drawn: the frame is drawn again when it arrives). Textures not
//! drawn in this frame go, least recently drawn first, while their bytes exceed the budget
//! (`max_texture_dimension_2d` squared bytes, within 64 and 256 MiB); one asked for again later is
//! decoded again from its file. No texture is larger than the device makes or than half the budget.

use crate::frame::{drawable_tf, Frame};
use crate::picture::{band, Decoded, Library, Size};
use crate::scene::{Op, Transform};
use std::collections::HashMap;

struct Tex {
    _tex: wgpu::Texture,
    bg: wgpu::BindGroup,
    size: Size,
    bytes: u64,
    last: u64,
}

pub struct Pictures {
    lib: Library,
    bgl: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    /// By the file's id (picture::Source::id).
    map: HashMap<u64, Tex>,
    /// The page's keys drawn this frame, to their file's id.
    ids: HashMap<u64, u64>,
    bytes: u64,
    budget: u64,
    max_side: u32,
    max_px: u64,
    frame: u64,
    uploads: u64,
}

const MIB: u64 = 1 << 20;

impl Pictures {
    pub(crate) fn new(
        device: &wgpu::Device,
        bgl: wgpu::BindGroupLayout,
        limits: &wgpu::Limits,
        lib: Library,
    ) -> Self {
        let max_dim = limits.max_texture_dimension_2d.max(1);
        let budget = (max_dim as u64 * max_dim as u64).clamp(64 * MIB, 256 * MIB);
        // As the browser samples an <img> scaled on the page: bilinear within a level, linear
        // between the levels when it is shown smaller than its texture.
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("picture"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        Pictures {
            lib,
            bgl,
            sampler,
            map: HashMap::new(),
            ids: HashMap::new(),
            bytes: 0,
            budget,
            max_side: max_dim.min(16384),
            // Mip levels add a third: one picture never takes more than half the budget.
            max_px: budget / 2 / 4 * 3 / 4,
            frame: 0,
            uploads: 0,
        }
    }

    pub(crate) fn library(&self) -> &Library {
        &self.lib
    }

    pub(crate) fn set_library(&mut self, lib: Library) {
        self.lib = lib;
        self.map.clear();
        self.ids.clear();
        self.bytes = 0;
    }

    /// Textures held, their bytes, the budget.
    pub(crate) fn memory(&self) -> (usize, u64, u64) {
        (self.map.len(), self.bytes, self.budget)
    }

    /// Decoded pictures wait to be uploaded: the frame must be drawn again.
    pub(crate) fn arrived(&self) -> bool {
        self.lib.has_done()
    }

    fn upload(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, d: Decoded) {
        let s = d.size();
        if s.w == 0 || s.h == 0 || s.w > self.max_side || s.h > self.max_side {
            return;
        }
        let tex = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("picture"),
            size: wgpu::Extent3d {
                width: s.w,
                height: s.h,
                depth_or_array_layers: 1,
            },
            mip_level_count: d.levels.len() as u32,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let mut bytes = 0u64;
        for (i, l) in d.levels.iter().enumerate() {
            bytes += l.rgba.len() as u64;
            queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &tex,
                    mip_level: i as u32,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                &l.rgba,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(l.w * 4),
                    rows_per_image: Some(l.h),
                },
                wgpu::Extent3d {
                    width: l.w,
                    height: l.h,
                    depth_or_array_layers: 1,
                },
            );
        }
        let view = tex.create_view(&Default::default());
        let bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("picture"),
            layout: &self.bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
            ],
        });
        if let Some(old) = self.map.insert(
            d.id,
            Tex {
                _tex: tex,
                bg,
                size: s,
                bytes,
                last: self.frame,
            },
        ) {
            self.bytes -= old.bytes;
        }
        self.bytes += bytes;
        self.uploads += 1;
    }

    /// Before a frame of `size` device px: uploads what was decoded, asks for what the pictures
    /// in view need, and frees textures over the budget.
    pub(crate) fn prepare(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        frame: &Frame,
        size: (u32, u32),
    ) {
        self.frame += 1;
        for d in self.lib.take_done() {
            self.upload(device, queue, d);
        }
        self.ids.clear();
        let mut wants: HashMap<u64, (std::sync::Arc<crate::picture::Source>, f32, f32)> =
            HashMap::new();
        for page in &frame.pages {
            if !drawable_tf(&page.tf) {
                continue;
            }
            for op in &page.scene.ops {
                let Op::Image {
                    key, quad, uv, bx, ..
                } = op
                else {
                    continue;
                };
                if !on_screen(bx, &page.tf, size) {
                    continue;
                }
                let Some(src) = self.lib.source(*key) else {
                    continue;
                };
                self.ids.insert(*key, src.id);
                let px = page.tf.px();
                // Device px the whole file would take at this box's scale.
                let nw = quad[2] * px / (uv[2] - uv[0]).abs().max(1e-3);
                let nh = quad[3] * px / (uv[3] - uv[1]).abs().max(1e-3);
                let e = wants.entry(src.id).or_insert((src.clone(), 0.0, 0.0));
                e.1 = e.1.max(nw);
                e.2 = e.2.max(nh);
            }
        }
        for (id, (src, nw, nh)) in wants {
            let want = band(&src, nw, nh, self.max_side, self.max_px);
            match self.map.get_mut(&id) {
                Some(t) => {
                    t.last = self.frame;
                    let small = t.size.w < want.w || t.size.h < want.h;
                    let large = t.size.w > want.w * 2 + 1 && t.size.h > want.h * 2 + 1;
                    if small || large {
                        self.lib.request(&src, want);
                    }
                }
                None => self.lib.request(&src, want),
            }
        }
        // Least recently drawn first, never one drawn in this frame.
        while self.bytes > self.budget {
            let Some((&id, _)) = self
                .map
                .iter()
                .filter(|(_, t)| t.last < self.frame)
                .min_by_key(|(_, t)| t.last)
            else {
                break;
            };
            if let Some(t) = self.map.remove(&id) {
                self.bytes -= t.bytes;
            }
        }
    }

    /// The bind group of the picture the page's `key` names, when its texture is here.
    pub(crate) fn bind_group(&self, key: u64) -> Option<&wgpu::BindGroup> {
        self.map.get(self.ids.get(&key)?).map(|t| &t.bg)
    }

    /// Uploads so far.
    pub fn uploads(&self) -> u64 {
        self.uploads
    }
}

/// Whether a page box through `tf` touches a `size` target.
fn on_screen(b: &crate::scene::PageBox, tf: &Transform, size: (u32, u32)) -> bool {
    let c = [
        tf.apply(b.x0, b.y0),
        tf.apply(b.x1, b.y0),
        tf.apply(b.x0, b.y1),
        tf.apply(b.x1, b.y1),
    ];
    let (x0, x1) = c.iter().fold((f32::INFINITY, f32::NEG_INFINITY), |a, p| {
        (a.0.min(p.0), a.1.max(p.0))
    });
    let (y0, y1) = c.iter().fold((f32::INFINITY, f32::NEG_INFINITY), |a, p| {
        (a.0.min(p.1), a.1.max(p.1))
    });
    x1 >= 0.0 && y1 >= 0.0 && x0 <= size.0 as f32 && y0 <= size.1 as f32
}
