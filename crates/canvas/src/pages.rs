//! Each page's scene, and which of them a frame draws (docs/rust-native-canvas.md "Scale",
//! rust/DECISIONS.md ADR-007: every cost per frame bounded by what is on screen, never by the
//! note's length).
//!
//! - Culling: the frame's placements are indexed once per frame message (`cull::BoxTree`, each
//!   placement's box: its paper, the part of the surface its scene belongs to (`bx`) and its
//!   scene's own bounds); a frame draws the placements meeting the view, found in O(found x log n).
//! - GPU memory: a scene is kept on the CPU (shared with the bridge's copy) and uploaded only when
//!   it comes near the view (the view and a screen around it, more ahead of the motion); scenes
//!   on the GPU are evicted least recently used beyond a byte budget (never one in view).
//! - What the view waits for: near placements whose scene is not here (`missing`, the page sends
//!   them), and for each page entering the view, how long its ink took to be drawn (its paper is
//!   drawn meanwhile, never another page's ink).

use crate::cull::{self, BoxTree, Rect};
use crate::frame::FrameSpec;
use crate::gpu::{GpuCanvas, GpuScene};
use crate::scene::{PageBox, Scene};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::Instant;

/// The view grows by this share of a screen on each side to give what is near (uploaded ahead).
const NEAR_SCREENS: f32 = 1.0;
/// And ahead of the motion by its speed times this (ms), at most `AHEAD_MAX_SCREENS`.
const AHEAD_MS: f32 = 500.0;
const AHEAD_MAX_SCREENS: f32 = 4.0;
/// A page beyond the view is uploaded ahead with at most this many bytes per frame (one in view
/// is uploaded whatever its size: it is drawn now).
const PREFETCH_BYTES_PER_FRAME: u64 = 1 << 20;
/// The GPU budget unless the owner sets one (`set_budget`).
pub const DEFAULT_BUDGET: u64 = 128 << 20;
/// Time-to-ink samples kept (ms).
const WAITS: usize = 4096;

struct Held {
    cpu: Arc<Scene>,
    gpu: Option<GpuScene>,
    caps: usize,
    bytes: u64,
    gpu_bytes: u64,
    gpu_dirty: bool,
    bounds: Option<PageBox>,
    /// The frame (`tick`) it was last in view, and last near.
    seen: u64,
    used: u64,
}

#[derive(Default)]
struct Index {
    tree: BoxTree,
    /// Placements not on the surface (no `at`): the page's own transform, always drawn.
    free: Vec<usize>,
    /// Scene id to its placements on the surface.
    slots: HashMap<String, Vec<usize>>,
    /// Each placement's box without its scene (paper, `bx`), surface px.
    own: Vec<Rect>,
    at: Vec<[f64; 2]>,
}

/// What the store did and holds (canvasStats).
#[derive(Clone, Debug, Default)]
pub struct PageStats {
    /// Scenes held (CPU), on the GPU, their capsules.
    pub held: usize,
    pub resident: usize,
    pub capsules: usize,
    pub gpu_bytes: u64,
    pub budget: u64,
    pub uploads: u64,
    pub evictions: u64,
    /// The last frame: placements drawn, capsules in the scenes drawn, scenes in view not here.
    pub drawn: usize,
    pub drawn_caps: usize,
    pub visible_missing: usize,
    /// Pages that entered the view and left before their ink came.
    pub ink_unfilled: u64,
    /// Time-to-ink samples kept.
    pub ink_samples: usize,
}

pub struct PageStore {
    scenes: HashMap<String, Held>,
    resident: HashSet<String>,
    caps_total: usize,
    gpu_bytes: u64,
    budget: u64,
    index: Index,
    tick: u64,
    uploads: u64,
    evictions: u64,
    /// Scene ids near the view (the view's first) and those of them not here, the last frame.
    near: Vec<String>,
    missing: Vec<String>,
    /// Counts the changes of `near` and `missing`.
    near_gen: u64,
    visible: HashSet<String>,
    waiting: HashMap<String, Instant>,
    waits: VecDeque<f32>,
    unfilled: u64,
    drawn: usize,
    drawn_caps: usize,
    visible_missing: usize,
    /// The view's centre (surface px) and when, for the motion's speed (px per ms, smoothed).
    last_view: Option<(Instant, f32, f32)>,
    speed: (f32, f32),
    scratch: Vec<usize>,
    found_scratch: Vec<usize>,
    near_ids_scratch: Vec<(f32, String)>,
    vis_missing_scratch: Vec<String>,
}

impl Default for PageStore {
    fn default() -> Self {
        PageStore {
            scenes: HashMap::new(),
            resident: HashSet::new(),
            caps_total: 0,
            gpu_bytes: 0,
            budget: DEFAULT_BUDGET,
            index: Index::default(),
            tick: 0,
            uploads: 0,
            evictions: 0,
            near: Vec::new(),
            missing: Vec::new(),
            near_gen: 0,
            visible: HashSet::new(),
            waiting: HashMap::new(),
            waits: VecDeque::new(),
            unfilled: 0,
            drawn: 0,
            drawn_caps: 0,
            visible_missing: 0,
            last_view: None,
            speed: (0.0, 0.0),
            scratch: Vec::new(),
            found_scratch: Vec::new(),
            near_ids_scratch: Vec::new(),
            vis_missing_scratch: Vec::new(),
        }
    }
}

fn rect_of(b: &PageBox, ax: f64, ay: f64) -> Rect {
    [
        (ax + b.x0 as f64) as f32,
        (ay + b.y0 as f64) as f32,
        (ax + b.x1 as f64) as f32,
        (ay + b.y1 as f64) as f32,
    ]
}

/// Ink is drawn a little past its capsules (antialiasing, the scissor's pad): page px.
const LEAF_PAD: f32 = 4.0;

impl PageStore {
    pub fn set_budget(&mut self, bytes: u64) {
        self.budget = bytes.max(1 << 20);
    }

    pub fn budget(&self) -> u64 {
        self.budget
    }

    pub fn has(&self, id: &str) -> bool {
        self.scenes.contains_key(id)
    }

    /// Scene `id` (kept on the CPU; uploaded when it comes near the view).
    pub fn put(&mut self, id: &str, scene: Arc<Scene>) -> usize {
        let caps = scene.caps.len();
        let bounds = scene.bounds();
        let bytes = scene.gpu_bytes();
        let old_held = self.scenes.remove(id);
        let (old_caps, old_gpu, old_gpu_bytes) = match old_held {
            Some(h) => (h.caps, h.gpu, h.gpu_bytes),
            None => (0, None, 0),
        };
        self.caps_total = self.caps_total.saturating_sub(old_caps) + caps;
        self.scenes.insert(
            id.to_string(),
            Held {
                cpu: scene,
                gpu: old_gpu,
                caps,
                bytes,
                gpu_bytes: old_gpu_bytes,
                gpu_dirty: true,
                bounds,
                seen: 0,
                used: 0,
            },
        );
        self.refresh(id);
        caps
    }

    pub fn remove(&mut self, id: &str) -> bool {
        let had = self.drop_scene(id);
        if had {
            self.refresh(id);
        }
        had
    }

    pub fn clear(&mut self) {
        let ids: Vec<String> = self.scenes.keys().cloned().collect();
        for id in ids {
            self.remove(&id);
        }
    }

    fn drop_scene(&mut self, id: &str) -> bool {
        match self.scenes.remove(id) {
            Some(mut h) => {
                self.caps_total = self.caps_total.saturating_sub(h.caps);
                if h.gpu.take().is_some() {
                    self.gpu_bytes = self.gpu_bytes.saturating_sub(h.gpu_bytes);
                    self.resident.remove(id);
                }
                h.gpu_bytes = 0;
                h.gpu_dirty = true;
                true
            }
            None => false,
        }
    }

    /// The scene of `id` on the GPU, if it is there.
    pub fn gpu(&self, id: &str) -> Option<&GpuScene> {
        self.scenes.get(id).and_then(|h| h.gpu.as_ref())
    }

    /// A placement's box: its own (paper, `bx`) and its scene's.
    fn leaf(&self, i: usize, id: &str) -> Rect {
        let own = self.index.own[i];
        let [ax, ay] = self.index.at[i];
        match self.scenes.get(id).and_then(|h| h.bounds) {
            Some(b) => {
                let r = rect_of(&b, ax, ay);
                cull::union(
                    own,
                    [
                        r[0] - LEAF_PAD,
                        r[1] - LEAF_PAD,
                        r[2] + LEAF_PAD,
                        r[3] + LEAF_PAD,
                    ],
                )
            }
            None => own,
        }
    }

    /// Scene `id` changed: its placements' boxes follow (O(placements of it x log n)).
    fn refresh(&mut self, id: &str) {
        let Some(slots) = self.index.slots.get(id) else {
            return;
        };
        let slots = slots.clone();
        for i in slots {
            let r = self.leaf(i, id);
            self.index.tree.set(i, r);
        }
    }

    /// A new frame from the page: its placements indexed (O(n), once per frame message).
    pub fn set_frame(&mut self, frame: &FrameSpec) {
        let n = frame.pages.len();
        let mut idx = Index {
            own: Vec::with_capacity(n),
            at: Vec::with_capacity(n),
            ..Default::default()
        };
        for (i, p) in frame.pages.iter().enumerate() {
            let Some([ax, ay]) = p.at.filter(|a| a.iter().all(|v| v.is_finite())) else {
                idx.free.push(i);
                idx.own.push(cull::EMPTY);
                idx.at.push([0.0, 0.0]);
                continue;
            };
            let mut r = cull::EMPTY;
            if let Some(pp) = p.paper {
                if pp.width.is_finite() && pp.height.is_finite() {
                    r = cull::union(
                        r,
                        [
                            ax as f32,
                            ay as f32,
                            (ax + pp.width as f64) as f32,
                            (ay + pp.height as f64) as f32,
                        ],
                    );
                }
            }
            if let Some(b) = p.bx {
                r = cull::union(
                    r,
                    [
                        (ax + b[0]) as f32,
                        (ay + b[1]) as f32,
                        (ax + b[2]) as f32,
                        (ay + b[3]) as f32,
                    ],
                );
            }
            idx.own.push(r);
            idx.at.push([ax, ay]);
            if !p.page.is_empty() {
                idx.slots.entry(p.page.clone()).or_default().push(i);
            }
        }
        let mut on_surface = vec![true; n];
        for &i in &idx.free {
            on_surface[i] = false;
        }
        self.index = idx;
        // Free placements are never in the tree.
        let leaves: Vec<Rect> = frame
            .pages
            .iter()
            .enumerate()
            .map(|(i, p)| {
                if on_surface[i] {
                    self.leaf(i, &p.page)
                } else {
                    cull::EMPTY
                }
            })
            .collect();
        self.index.tree = BoxTree::new(&leaves);
    }

    fn upload(&mut self, canvas: &GpuCanvas, id: &str) -> bool {
        let Some(h) = self.scenes.get_mut(id) else {
            return false;
        };
        if h.gpu.is_some() && !h.gpu_dirty {
            return true;
        }
        if let Some(ref mut gpu) = h.gpu {
            if canvas.update(gpu, &h.cpu) {
                h.gpu_dirty = false;
                return true;
            }
        }
        self.gpu_bytes = self.gpu_bytes.saturating_sub(h.gpu_bytes);
        let new_gpu = canvas.upload(&h.cpu);
        let allocated = new_gpu.allocated_bytes();
        h.gpu = Some(new_gpu);
        h.gpu_bytes = allocated;
        h.gpu_dirty = false;
        self.gpu_bytes += allocated;
        self.resident.insert(id.to_string());
        self.uploads += 1;
        true
    }

    /// The view (surface px) for a surface placed at (k, x, y) on a target of `size` device px.
    fn view_of(surface: Option<[f64; 3]>, size: (u32, u32)) -> Option<Rect> {
        let [k, x, y] = surface?;
        if !(k.is_finite() && k > 0.0 && x.is_finite() && y.is_finite()) {
            return None;
        }
        // Two device px of slack: the scissor's pad and antialiasing at the edges.
        let pad = 2.0 / k;
        Some([
            ((-x) / k - pad) as f32,
            ((-y) / k - pad) as f32,
            ((size.0 as f64 - x) / k + pad) as f32,
            ((size.1 as f64 - y) / k + pad) as f32,
        ])
    }

    /// What is near the view: the view with a screen around it, and more ahead of the motion.
    fn near_of(&mut self, view: Rect) -> Rect {
        let (w, h) = (view[2] - view[0], view[3] - view[1]);
        let (cx, cy) = ((view[0] + view[2]) / 2.0, (view[1] + view[3]) / 2.0);
        let now = Instant::now();
        if let Some((t, px, py)) = self.last_view {
            let dt = now.duration_since(t).as_secs_f32() * 1000.0;
            if dt > 0.5 && dt < 250.0 {
                let v = ((cx - px) / dt, (cy - py) / dt);
                self.speed = (
                    self.speed.0 + (v.0 - self.speed.0) * 0.5,
                    self.speed.1 + (v.1 - self.speed.1) * 0.5,
                );
            } else if dt >= 250.0 {
                self.speed = (0.0, 0.0);
            }
        }
        self.last_view = Some((now, cx, cy));
        let ax = (self.speed.0 * AHEAD_MS).clamp(-AHEAD_MAX_SCREENS * w, AHEAD_MAX_SCREENS * w);
        let ay = (self.speed.1 * AHEAD_MS).clamp(-AHEAD_MAX_SCREENS * h, AHEAD_MAX_SCREENS * h);
        let (mx, my) = (w * NEAR_SCREENS * 0.5, h * NEAR_SCREENS);
        [
            view[0] - mx + ax.min(0.0),
            view[1] - my + ay.min(0.0),
            view[2] + mx + ax.max(0.0),
            view[3] + my + ay.max(0.0),
        ]
    }

    /// Ahead of a frame that is not drawn (nothing changed): pages coming near are uploaded.
    pub fn prefetch(
        &mut self,
        canvas: &GpuCanvas,
        frame: &FrameSpec,
        surface: Option<[f64; 3]>,
        size: (u32, u32),
    ) {
        if let Some(view) = Self::view_of(surface, size) {
            self.tick += 1;
            let vis = std::mem::take(&mut self.visible);
            self.near_pass(canvas, frame, view, &vis, false);
            self.visible = vis;
            self.evict();
        }
    }

    /// The placements (indices into `frame.pages`, in order) this frame draws; scenes in view
    /// uploaded, scenes near it uploaded ahead (within the budget), what is missing noted, the
    /// GPU kept within its budget.
    pub fn plan(
        &mut self,
        canvas: &GpuCanvas,
        frame: &FrameSpec,
        surface: Option<[f64; 3]>,
        size: (u32, u32),
    ) -> Vec<usize> {
        self.tick += 1;
        let tick = self.tick;
        let Some(view) = Self::view_of(surface, size) else {
            // The page's own transforms (no surface): everything, as given.
            let order: Vec<usize> = (0..frame.pages.len()).collect();
            let mut caps = 0;
            for p in &frame.pages {
                if self.upload(canvas, &p.page) {
                    if let Some(h) = self.scenes.get_mut(&p.page) {
                        h.seen = tick;
                        h.used = tick;
                        caps += h.caps;
                    }
                }
            }
            self.drawn = order.len();
            self.drawn_caps = caps;
            self.visible_missing = 0;
            self.evict();
            return order;
        };
        let mut order = std::mem::take(&mut self.scratch);
        order.clear();
        self.index.tree.query(&view, &mut order);
        if !self.index.free.is_empty() {
            order.extend(self.index.free.iter().copied());
            order.sort_unstable();
        }
        // In view: uploaded now; what is not here yet waits (its paper is drawn).
        let now = Instant::now();
        let uploads_before = self.uploads;
        let mut visible: HashSet<String> = HashSet::with_capacity(order.len());
        let mut caps = 0;
        let mut vis_missing = std::mem::take(&mut self.vis_missing_scratch);
        vis_missing.clear();
        for &i in &order {
            let id = &frame.pages[i].page;
            if id.is_empty() {
                continue;
            }
            let on_surface = self.index.slots.contains_key(id);
            if !on_surface {
                // A placement of the page's own (no `at`): drawn as given, its scene uploaded.
                if self.upload(canvas, id) {
                    let h = self.scenes.get_mut(id).expect("held");
                    h.seen = tick;
                    h.used = tick;
                    caps += h.caps;
                    visible.insert(id.clone());
                }
                continue;
            }
            if self.upload(canvas, id) {
                let h = self.scenes.get_mut(id).expect("held");
                h.seen = tick;
                h.used = tick;
                caps += h.caps;
                if !self.visible.contains(id) {
                    match self.waiting.remove(id) {
                        Some(t0) => self.wait_done(now.duration_since(t0)),
                        None => self.wait_done(std::time::Duration::ZERO),
                    }
                } else if let Some(t0) = self.waiting.remove(id) {
                    self.wait_done(now.duration_since(t0));
                }
            } else {
                self.waiting.entry(id.clone()).or_insert(now);
                vis_missing.push(id.clone());
            }
            visible.insert(id.clone());
        }
        for id in self.visible.difference(&visible) {
            if self.waiting.remove(id).is_some() {
                self.unfilled += 1;
            }
        }
        self.visible = visible;
        self.drawn = order.len();
        self.drawn_caps = caps;
        self.visible_missing = vis_missing.len();
        let uploaded_in_view = self.uploads > uploads_before;
        let elapsed = now.elapsed();
        let skip_prefetch = uploaded_in_view || elapsed.as_micros() > 1500;
        let vis = std::mem::take(&mut self.visible);
        self.near_pass(canvas, frame, view, &vis, skip_prefetch);
        self.visible = vis;
        // Those in view are asked for first.
        let mut missing = vis_missing.clone();
        for id in &self.missing {
            if !missing.contains(id) {
                missing.push(id.clone());
            }
        }
        if missing != self.missing {
            self.missing = missing;
            self.near_gen += 1;
        }
        self.vis_missing_scratch = vis_missing;
        self.evict();
        let out = order.clone();
        self.scratch = order;
        out
    }

    fn wait_done(&mut self, d: std::time::Duration) {
        if self.waits.len() >= WAITS {
            self.waits.pop_front();
        }
        self.waits.push_back(d.as_secs_f32() * 1000.0);
    }

    /// Near the view: uploaded ahead within the frame's share and the budget; ids noted, and those
    /// not here (`missing`, nearest first).
    fn near_pass(
        &mut self,
        canvas: &GpuCanvas,
        frame: &FrameSpec,
        view: Rect,
        visible: &HashSet<String>,
        skip_prefetch: bool,
    ) {
        let near = self.near_of(view);
        let tick = self.tick;
        let mut found = std::mem::take(&mut self.found_scratch);
        found.clear();
        self.index.tree.query(&near, &mut found);
        let (cx, cy) = ((view[0] + view[2]) / 2.0, (view[1] + view[3]) / 2.0);
        let mut ids = std::mem::take(&mut self.near_ids_scratch);
        ids.clear();
        for i in found.iter().copied() {
            let id = &frame.pages[i].page;
            if id.is_empty() {
                continue;
            }
            let r = self.index.tree.get(i);
            let dy = if cy < r[1] {
                r[1] - cy
            } else if cy > r[3] {
                cy - r[3]
            } else {
                0.0
            };
            let dx = if cx < r[0] {
                r[0] - cx
            } else if cx > r[2] {
                cx - r[2]
            } else {
                0.0
            };
            ids.push((dx.hypot(dy), id.clone()));
        }
        ids.sort_by(|a, b| a.0.total_cmp(&b.0));
        ids.dedup_by(|a, b| a.1 == b.1);
        let mut budget = if skip_prefetch {
            0
        } else {
            PREFETCH_BYTES_PER_FRAME
        };
        let mut missing = Vec::new();
        for (_, id) in &ids {
            match self.scenes.get_mut(id) {
                Some(h) => {
                    h.used = tick;
                    if h.gpu.is_none()
                        && !visible.contains(id)
                        && h.bytes <= budget
                        && self.gpu_bytes + h.bytes <= self.budget
                    {
                        budget -= h.bytes;
                        self.upload(canvas, id);
                    }
                }
                None => missing.push(id.clone()),
            }
        }
        let near: Vec<String> = ids.iter().map(|(_, id)| id.clone()).collect();
        if near != self.near {
            self.near = near;
            self.near_gen += 1;
        }
        if missing != self.missing {
            self.missing = missing;
            self.near_gen += 1;
        }
        self.found_scratch = found;
        self.near_ids_scratch = ids;
    }

    /// Beyond the budget: the least recently used scenes leave the GPU (they stay on the CPU),
    /// those far from the view first, never one in view. Defers eviction during tight gestures
    /// until memory exceeds 1.15x budget to avoid mid-gesture GPU buffer stalls.
    fn evict(&mut self) {
        let soft_limit = (self.budget as f64 * 1.15) as u64;
        if self.gpu_bytes <= soft_limit {
            return;
        }
        let tick = self.tick;
        let mut cands: Vec<(bool, u64, String)> = self
            .resident
            .iter()
            .filter(|id| !self.visible.contains(*id))
            .filter_map(|id| {
                let h = self.scenes.get(id)?;
                Some((h.used >= tick, h.used.max(h.seen), id.clone()))
            })
            .collect();
        cands.sort();
        for (_, _, id) in cands {
            if self.gpu_bytes <= self.budget {
                break;
            }
            if let Some(h) = self.scenes.get_mut(&id) {
                if h.gpu.take().is_some() {
                    self.gpu_bytes = self.gpu_bytes.saturating_sub(h.gpu_bytes);
                    h.gpu_bytes = 0;
                    h.gpu_dirty = true;
                    self.evictions += 1;
                }
            }
            self.resident.remove(&id);
        }
    }

    /// Scene ids near the view the last frame (the view's first).
    pub fn near(&self) -> &[String] {
        &self.near
    }

    /// Of those, the ones not here (in view first, then nearest first).
    pub fn missing(&self) -> &[String] {
        &self.missing
    }

    pub fn tick(&self) -> u64 {
        self.tick
    }

    /// Changes whenever `near` or `missing` does.
    pub fn near_gen(&self) -> u64 {
        self.near_gen
    }

    pub fn capsules(&self) -> usize {
        self.caps_total
    }

    pub fn held(&self) -> usize {
        self.scenes.len()
    }

    pub fn stats(&self) -> PageStats {
        PageStats {
            held: self.scenes.len(),
            resident: self.resident.len(),
            capsules: self.caps_total,
            gpu_bytes: self.gpu_bytes,
            budget: self.budget,
            uploads: self.uploads,
            evictions: self.evictions,
            drawn: self.drawn,
            drawn_caps: self.drawn_caps,
            visible_missing: self.visible_missing,
            ink_unfilled: self.unfilled,
            ink_samples: self.waits.len(),
        }
    }

    /// Pages that entered the view: how long until their ink was drawn (ms), the newest last.
    pub fn ink_waits(&self) -> Vec<f32> {
        self.waits.iter().copied().collect()
    }

    /// The time-to-ink samples start again (a bench's run).
    pub fn reset_waits(&mut self) {
        self.waits.clear();
        self.unfilled = 0;
    }
}
