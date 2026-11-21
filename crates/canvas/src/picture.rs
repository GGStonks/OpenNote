//! Pictures (the page's `ImageBlock`s): their files, decoded off the render thread at the size the
//! zoom in view needs. TypeScript counterpart: Blocks.tsx `ImageBlockView` (an `<img>` of the
//! block's `dataUrl`, the browser decoding it), and the files the app stores (src/import/images.ts
//! `loadPicture`: PNG or JPEG; .ntb GIFs as they are; `solidImage`: an SVG for stickies and box
//! colours).
//!
//! The page sends each picture's file once (`Library::insert`, by the page's key; identical files
//! are kept once). Nothing is decoded then: the draw asks for a size (`Library::request`) when a
//! picture is on screen, a worker thread of the library's own decodes it (never the render thread,
//! never the shell's main thread) and leaves the pixels for the next draw to upload
//! (`Library::take_done`). A raster picture is decoded at its own size halved as often as the
//! screen allows (a band: never smaller than it is shown, never larger than the file), an SVG
//! rendered by resvg at its size times a power of two (sharp at any zoom); each comes with its mip
//! levels (area averages of premultiplied pixels), so the GPU's trilinear sampling shrinks it as
//! the browser does. One decode at a time, and a file whose decode would need more than
//! `MAX_DECODE_BYTES` is refused: the transient memory stays bounded whatever the page sends.

use base64::Engine;
use std::collections::{HashMap, HashSet, VecDeque};
use std::hash::{Hash, Hasher};
use std::io::Cursor;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// The most a decode may allocate (the decoded file at its own size): a 12000 x 9000 photo
/// (432 MB as RGBA) is decoded, anything far larger is refused.
pub const MAX_DECODE_BYTES: u64 = 640 << 20;
/// The largest file kept (a picture's encoded bytes).
pub const MAX_FILE_BYTES: usize = 256 << 20;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Raster,
    Svg,
}

/// A picture's file as the page sent it.
#[derive(Debug)]
pub struct Source {
    /// The id its textures are kept by (one per distinct file).
    pub id: u64,
    pub kind: Kind,
    /// Its own size (px; an SVG's size in user units), EXIF orientation applied.
    pub width: u32,
    pub height: u32,
    bytes: Arc<[u8]>,
}

/// A texture size (px).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Size {
    pub w: u32,
    pub h: u32,
}

/// One mip level: premultiplied RGBA8, `w` x `h`.
#[derive(Clone, Debug)]
pub struct Level {
    pub w: u32,
    pub h: u32,
    pub rgba: Vec<u8>,
}

/// A decoded picture: its levels, the first at the size asked for.
#[derive(Debug)]
pub struct Decoded {
    pub id: u64,
    pub levels: Vec<Level>,
}

impl Decoded {
    pub fn size(&self) -> Size {
        Size {
            w: self.levels[0].w,
            h: self.levels[0].h,
        }
    }
}

#[derive(Default)]
struct State {
    /// The page's key to its file.
    sources: HashMap<u64, Arc<Source>>,
    /// A file's content hash to its id (identical files kept once).
    by_hash: HashMap<u64, u64>,
    queue: VecDeque<(u64, Size)>,
    /// What is queued or being decoded, by id.
    pending: HashMap<u64, Size>,
    running: bool,
    done: Vec<Decoded>,
    /// Ids decoded at least once, and those whose file could not be decoded (never asked again).
    ok: HashSet<u64>,
    failed: HashMap<u64, String>,
    decodes: u64,
    decode_ms: f64,
    next_id: u64,
}

struct Inner {
    state: Mutex<State>,
    /// Signalled when a decode finishes (and when the queue empties).
    changed: Condvar,
}

/// The pictures the page sent, shared by the page's bridge (`insert`), the render thread
/// (`request`, `take_done`) and the decode worker.
#[derive(Clone)]
pub struct Library {
    inner: Arc<Inner>,
}

impl Default for Library {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Debug for Library {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Library")
    }
}

/// What the library holds, for `canvasStats`.
#[derive(Clone, Debug, Default)]
pub struct LibraryStats {
    pub files: usize,
    pub file_bytes: usize,
    pub pending: usize,
    pub decodes: u64,
    pub decode_ms: f64,
    pub failed: usize,
    pub last_failure: Option<String>,
}

fn lock(m: &Mutex<State>) -> MutexGuard<'_, State> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Library {
    pub fn new() -> Self {
        Library {
            inner: Arc::new(Inner {
                state: Mutex::new(State::default()),
                changed: Condvar::new(),
            }),
        }
    }

    /// The page's file for `key`: a data URL (`data:image/png;base64,…`, `data:image/svg+xml;
    /// charset=utf-8,…`) or the file's bytes. Its size is read from its header (nothing decoded).
    /// Identical bytes under another key share one source. Returns the source.
    pub fn insert(&self, key: u64, data: &[u8]) -> Result<Arc<Source>, String> {
        let bytes = file_bytes(data)?;
        if bytes.len() > MAX_FILE_BYTES {
            return Err(format!("picture of {} bytes is too large", bytes.len()));
        }
        let hash = {
            let mut h = std::collections::hash_map::DefaultHasher::new();
            bytes.hash(&mut h);
            h.finish()
        };
        if let Some(src) = self.linked(key, hash) {
            return Ok(src);
        }
        let (kind, width, height) = probe(&bytes)?;
        let mut st = lock(&self.inner.state);
        st.next_id += 1;
        let src = Arc::new(Source {
            id: st.next_id,
            kind,
            width,
            height,
            bytes: bytes.into(),
        });
        st.by_hash.insert(hash, src.id);
        st.sources.insert(key, src.clone());
        Ok(src)
    }

    /// The source already holding the bytes of `hash`, now also under `key`.
    fn linked(&self, key: u64, hash: u64) -> Option<Arc<Source>> {
        let mut st = lock(&self.inner.state);
        let id = *st.by_hash.get(&hash)?;
        let src = st.sources.values().find(|s| s.id == id)?.clone();
        st.sources.insert(key, src.clone());
        Some(src)
    }

    /// The source the page's `key` names.
    pub fn source(&self, key: u64) -> Option<Arc<Source>> {
        lock(&self.inner.state).sources.get(&key).cloned()
    }

    pub fn contains(&self, key: u64) -> bool {
        lock(&self.inner.state).sources.contains_key(&key)
    }

    /// Keeps only the files of `keys` (the pictures some page's scene still shows).
    pub fn retain(&self, keys: &HashSet<u64>) {
        let mut st = lock(&self.inner.state);
        st.sources.retain(|k, _| keys.contains(k));
        let live: HashSet<u64> = st.sources.values().map(|s| s.id).collect();
        st.by_hash.retain(|_, id| live.contains(id));
        st.queue.retain(|(id, _)| live.contains(id));
        st.pending.retain(|id, _| live.contains(id));
        st.done.retain(|d| live.contains(&d.id));
        st.ok.retain(|id| live.contains(id));
        st.failed.retain(|id, _| live.contains(id));
    }

    /// Whether the id has been decoded (true) or could not be (false); None while unknown.
    pub fn decodable(&self, id: u64) -> Option<bool> {
        let st = lock(&self.inner.state);
        if st.ok.contains(&id) {
            Some(true)
        } else if st.failed.contains_key(&id) {
            Some(false)
        } else {
            None
        }
    }

    /// Asks for `src` at `size`, decoded on the worker. A request for an id already queued
    /// replaces its size; one already being decoded at that size, or a file that failed, is not
    /// asked again.
    pub fn request(&self, src: &Source, size: Size) {
        let mut st = lock(&self.inner.state);
        if st.failed.contains_key(&src.id) || st.pending.get(&src.id) == Some(&size) {
            return;
        }
        if let Some(q) = st.queue.iter_mut().find(|(id, _)| *id == src.id) {
            q.1 = size;
        } else {
            st.queue.push_back((src.id, size));
        }
        st.pending.insert(src.id, size);
        if !st.running {
            st.running = true;
            let lib = self.clone();
            let spawned = std::thread::Builder::new()
                .name("opennote-pictures".into())
                .spawn(move || lib.work());
            if let Err(e) = spawned {
                st.running = false;
                st.queue.clear();
                st.pending.clear();
                st.failed.insert(src.id, format!("no decode thread: {e}"));
            }
        }
    }

    fn work(&self) {
        loop {
            let job = {
                let mut st = lock(&self.inner.state);
                match st.queue.pop_front() {
                    Some((id, size)) => st
                        .sources
                        .values()
                        .find(|s| s.id == id)
                        .cloned()
                        .map(|s| (s, size)),
                    None => {
                        st.running = false;
                        self.inner.changed.notify_all();
                        return;
                    }
                }
            };
            let Some((src, size)) = job else {
                continue;
            };
            let t0 = Instant::now();
            let result = std::panic::catch_unwind(|| decode(&src, size))
                .unwrap_or_else(|_| Err("the decoder panicked".into()));
            let mut st = lock(&self.inner.state);
            st.decodes += 1;
            st.decode_ms += t0.elapsed().as_secs_f64() * 1000.0;
            if st.pending.get(&src.id) == Some(&size) {
                st.pending.remove(&src.id);
            }
            match result {
                Ok(levels) => {
                    st.ok.insert(src.id);
                    st.done.retain(|d| d.id != src.id);
                    st.done.push(Decoded { id: src.id, levels });
                }
                Err(e) => {
                    st.failed.insert(src.id, e);
                }
            }
            self.inner.changed.notify_all();
        }
    }

    /// Whether decoded pictures wait for the draw.
    pub fn has_done(&self) -> bool {
        !lock(&self.inner.state).done.is_empty()
    }

    /// The decoded pictures, for the render thread to upload.
    pub fn take_done(&self) -> Vec<Decoded> {
        std::mem::take(&mut lock(&self.inner.state).done)
    }

    /// Nothing queued or being decoded.
    pub fn idle(&self) -> bool {
        let st = lock(&self.inner.state);
        !st.running && st.queue.is_empty()
    }

    /// Waits (at most `timeout`) until nothing is queued or being decoded; true when idle.
    pub fn wait_idle(&self, timeout: Duration) -> bool {
        let end = Instant::now() + timeout;
        let mut st = lock(&self.inner.state);
        while st.running || !st.queue.is_empty() {
            let now = Instant::now();
            if now >= end {
                return false;
            }
            st = self
                .inner
                .changed
                .wait_timeout(st, end - now)
                .map(|r| r.0)
                .unwrap_or_else(|e| e.into_inner().0);
        }
        true
    }

    pub fn stats(&self) -> LibraryStats {
        let st = lock(&self.inner.state);
        let mut seen = HashSet::new();
        let file_bytes = st
            .sources
            .values()
            .filter(|s| seen.insert(s.id))
            .map(|s| s.bytes.len())
            .sum();
        LibraryStats {
            files: seen.len(),
            file_bytes,
            pending: st.pending.len(),
            decodes: st.decodes,
            decode_ms: st.decode_ms,
            failed: st.failed.len(),
            last_failure: st.failed.values().next().cloned(),
        }
    }
}

// ------------------------------------------------------------------------------------------------
// Files

/// The bytes of a data URL (base64 or percent-encoded), or `data` itself when it is not one.
pub fn file_bytes(data: &[u8]) -> Result<Vec<u8>, String> {
    if !data.starts_with(b"data:") {
        return Ok(data.to_vec());
    }
    let comma = data
        .iter()
        .position(|&b| b == b',')
        .ok_or("a data URL without a comma")?;
    let head = std::str::from_utf8(&data[5..comma]).map_err(|_| "data URL header")?;
    let body = &data[comma + 1..];
    if head.split(';').any(|p| p.eq_ignore_ascii_case("base64")) {
        let clean: Vec<u8> = body
            .iter()
            .copied()
            .filter(|b| !b.is_ascii_whitespace())
            .collect();
        base64::engine::general_purpose::STANDARD
            .decode(&clean)
            .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(&clean))
            .map_err(|e| format!("data URL base64: {e}"))
    } else {
        Ok(percent_decode(body))
    }
}

fn percent_decode(s: &[u8]) -> Vec<u8> {
    let hex = |b: u8| match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    };
    let mut out = Vec::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        if s[i] == b'%' && i + 2 < s.len() {
            if let (Some(a), Some(b)) = (hex(s[i + 1]), hex(s[i + 2])) {
                out.push(a * 16 + b);
                i += 3;
                continue;
            }
        }
        out.push(s[i]);
        i += 1;
    }
    out
}

fn is_svg(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(512)];
    let text = String::from_utf8_lossy(head);
    let t = text.trim_start_matches('\u{feff}').trim_start();
    t.starts_with("<svg")
        || ((t.starts_with("<?xml") || t.starts_with("<!--")) && text.contains("<svg"))
}

fn svg_tree(bytes: &[u8]) -> Result<resvg::usvg::Tree, String> {
    resvg::usvg::Tree::from_data(bytes, &resvg::usvg::Options::default())
        .map_err(|e| format!("svg: {e}"))
}

/// The file's kind and size, from its header (an SVG is parsed: they are small).
fn probe(bytes: &[u8]) -> Result<(Kind, u32, u32), String> {
    if is_svg(bytes) {
        let t = svg_tree(bytes)?;
        let s = t.size();
        return Ok((
            Kind::Svg,
            s.width().ceil().max(1.0) as u32,
            s.height().ceil().max(1.0) as u32,
        ));
    }
    let mut dec = raster_decoder(bytes)?;
    let (w, h) = image::ImageDecoder::dimensions(&dec);
    let o = image::ImageDecoder::orientation(&mut dec)
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    if w == 0 || h == 0 {
        return Err("a picture of no pixels".into());
    }
    Ok(match o {
        image::metadata::Orientation::Rotate90
        | image::metadata::Orientation::Rotate270
        | image::metadata::Orientation::Rotate90FlipH
        | image::metadata::Orientation::Rotate270FlipH => (Kind::Raster, h, w),
        _ => (Kind::Raster, w, h),
    })
}

fn raster_decoder(bytes: &[u8]) -> Result<Box<dyn image::ImageDecoder + '_>, String> {
    let mut r = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| format!("picture: {e}"))?;
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    r.limits(limits);
    let d = r.into_decoder().map_err(|e| format!("picture: {e}"))?;
    Ok(Box::new(d))
}

// ------------------------------------------------------------------------------------------------
// Sizes

/// The texture size a picture shown `need` px wide and high (its whole file, device px) gets:
/// a raster picture its own size halved while that still covers `need` (never above its own
/// size), an SVG its size times the power of two that covers `need`; then halved until it fits
/// `max_side` per side and `max_px` pixels.
pub fn band(src: &Source, need_w: f32, need_h: f32, max_side: u32, max_px: u64) -> Size {
    let (nw, nh) = (src.width.max(1), src.height.max(1));
    let fits = |s: Size| s.w <= max_side && s.h <= max_side && (s.w as u64 * s.h as u64) <= max_px;
    match src.kind {
        Kind::Raster => {
            let at = |l: u32| Size {
                w: (nw >> l.min(31)).max(1),
                h: (nh >> l.min(31)).max(1),
            };
            let mut l = 0;
            while l < 31 {
                let next = at(l + 1);
                if (next.w as f32) < need_w || (next.h as f32) < need_h || at(l) == next {
                    break;
                }
                l += 1;
            }
            while !fits(at(l)) && at(l) != at(l + 1) {
                l += 1;
            }
            at(l)
        }
        Kind::Svg => {
            let k = (need_w / nw as f32).max(need_h / nh as f32).max(1e-6);
            let mut e = k.log2().ceil().clamp(-30.0, 30.0) as i32;
            let at = |e: i32| {
                let s = 2f64.powi(e);
                Size {
                    w: ((nw as f64 * s).ceil() as u32).max(1),
                    h: ((nh as f64 * s).ceil() as u32).max(1),
                }
            };
            while !fits(at(e)) && e > -30 {
                e -= 1;
            }
            at(e)
        }
    }
}

// ------------------------------------------------------------------------------------------------
// Decoding

/// `src` at `size` with its mip levels (premultiplied RGBA8).
pub fn decode(src: &Source, size: Size) -> Result<Vec<Level>, String> {
    let base = match src.kind {
        Kind::Svg => render_svg(&src.bytes, size)?,
        Kind::Raster => decode_raster(&src.bytes, size)?,
    };
    Ok(mips(base))
}

fn render_svg(bytes: &[u8], size: Size) -> Result<Level, String> {
    let tree = svg_tree(bytes)?;
    let s = tree.size();
    let mut pm = resvg::tiny_skia::Pixmap::new(size.w, size.h).ok_or("svg: no pixmap")?;
    resvg::render(
        &tree,
        resvg::tiny_skia::Transform::from_scale(
            size.w as f32 / s.width().max(1e-6),
            size.h as f32 / s.height().max(1e-6),
        ),
        &mut pm.as_mut(),
    );
    Ok(Level {
        w: size.w,
        h: size.h,
        rgba: pm.take(),
    })
}

fn decode_raster(bytes: &[u8], size: Size) -> Result<Level, String> {
    let mut dec = raster_decoder(bytes)?;
    let o = image::ImageDecoder::orientation(&mut dec)
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut img = image::DynamicImage::from_decoder(dec).map_err(|e| format!("picture: {e}"))?;
    if o != image::metadata::Orientation::NoTransforms {
        img.apply_orientation(o);
    }
    let (w, h) = (img.width(), img.height());
    // Rows read straight from the decoder's own buffer, premultiplied one row at a time: no
    // second copy of a large picture.
    let mut row = vec![0u8; w as usize * 4];
    let mut fill: Box<dyn FnMut(u32, &mut [u8])> = match &img {
        image::DynamicImage::ImageRgba8(b) => {
            let raw = b.as_raw();
            Box::new(move |y, out: &mut [u8]| {
                let o = y as usize * w as usize * 4;
                out.copy_from_slice(&raw[o..o + w as usize * 4]);
                premultiply(out);
            })
        }
        image::DynamicImage::ImageRgb8(b) => {
            let raw = b.as_raw();
            Box::new(move |y, out: &mut [u8]| {
                let o = y as usize * w as usize * 3;
                for (x, px) in out.chunks_exact_mut(4).enumerate() {
                    px[..3].copy_from_slice(&raw[o + x * 3..o + x * 3 + 3]);
                    px[3] = 255;
                }
            })
        }
        image::DynamicImage::ImageLuma8(b) => {
            let raw = b.as_raw();
            Box::new(move |y, out: &mut [u8]| {
                let o = y as usize * w as usize;
                for (x, px) in out.chunks_exact_mut(4).enumerate() {
                    let v = raw[o + x];
                    px.copy_from_slice(&[v, v, v, 255]);
                }
            })
        }
        image::DynamicImage::ImageLumaA8(b) => {
            let raw = b.as_raw();
            Box::new(move |y, out: &mut [u8]| {
                let o = y as usize * w as usize * 2;
                for (x, px) in out.chunks_exact_mut(4).enumerate() {
                    let (v, a) = (raw[o + x * 2], raw[o + x * 2 + 1]);
                    px.copy_from_slice(&[v, v, v, a]);
                }
                premultiply(out);
            })
        }
        other => {
            let b = other.to_rgba8();
            Box::new(move |y, out: &mut [u8]| {
                let o = y as usize * w as usize * 4;
                out.copy_from_slice(&b.as_raw()[o..o + w as usize * 4]);
                premultiply(out);
            })
        }
    };
    let (dw, dh) = (size.w.clamp(1, w), size.h.clamp(1, h));
    let rgba = area_resize(w, h, dw, dh, |y, out| {
        fill(y, &mut row);
        out.copy_from_slice(&row);
    });
    Ok(Level { w: dw, h: dh, rgba })
}

fn premultiply(px: &mut [u8]) {
    for p in px.chunks_exact_mut(4) {
        let a = p[3] as u32;
        if a < 255 {
            for c in &mut p[..3] {
                *c = ((*c as u32 * a + 127) / 255) as u8;
            }
        }
    }
}

/// Spans of source pixels each destination pixel covers, with their shares (area averaging).
fn spans(src: u32, dst: u32) -> Vec<(u32, Vec<f32>)> {
    let k = src as f64 / dst as f64;
    (0..dst)
        .map(|i| {
            let (a, b) = (i as f64 * k, ((i + 1) as f64 * k).min(src as f64));
            let first = a.floor() as u32;
            let last = (b.ceil() as u32).clamp(first + 1, src);
            let w: Vec<f32> = (first..last)
                .map(|s| {
                    let lo = (s as f64).max(a);
                    let hi = ((s + 1) as f64).min(b);
                    ((hi - lo).max(0.0) / k) as f32
                })
                .collect();
            (first, w)
        })
        .collect()
}

/// `sw` x `sh` pixels (rows from `row`, RGBA8 premultiplied) averaged down to `dw` x `dh`
/// (each destination pixel the mean of the source area it covers), one source row at a time.
fn area_resize(sw: u32, sh: u32, dw: u32, dh: u32, mut row: impl FnMut(u32, &mut [u8])) -> Vec<u8> {
    let (dw, dh) = (dw.clamp(1, sw), dh.clamp(1, sh));
    let mut out = vec![0u8; dw as usize * dh as usize * 4];
    let mut src = vec![0u8; sw as usize * 4];
    if dw == sw && dh == sh {
        for y in 0..sh {
            row(y, &mut src);
            let o = y as usize * sw as usize * 4;
            out[o..o + src.len()].copy_from_slice(&src);
        }
        return out;
    }
    let xs = spans(sw, dw);
    let ys = spans(sh, dh);
    // Each source row's share of each destination row: source row y feeds destination rows
    // whose spans include it.
    let mut feeds: Vec<Vec<(u32, f32)>> = vec![Vec::new(); sh as usize];
    for (dy, (first, w)) in ys.iter().enumerate() {
        for (j, wj) in w.iter().enumerate() {
            if *wj > 0.0 {
                feeds[(*first as usize) + j].push((dy as u32, *wj));
            }
        }
    }
    let mut hrow = vec![0f32; dw as usize * 4];
    let mut acc: HashMap<u32, Vec<f32>> = HashMap::new();
    let mut next_out = 0u32;
    for y in 0..sh {
        if feeds[y as usize].is_empty() {
            continue;
        }
        row(y, &mut src);
        for (dx, (first, w)) in xs.iter().enumerate() {
            let mut c = [0f32; 4];
            for (j, wj) in w.iter().enumerate() {
                let o = (*first as usize + j) * 4;
                for k in 0..4 {
                    c[k] += src[o + k] as f32 * wj;
                }
            }
            hrow[dx * 4..dx * 4 + 4].copy_from_slice(&c);
        }
        for (dy, wy) in &feeds[y as usize] {
            let a = acc
                .entry(*dy)
                .or_insert_with(|| vec![0f32; dw as usize * 4]);
            for (v, h) in a.iter_mut().zip(&hrow) {
                *v += h * wy;
            }
        }
        // Destination rows whose last source row this was are finished.
        while next_out < dh {
            let (first, w) = &ys[next_out as usize];
            if first + w.len() as u32 - 1 > y {
                break;
            }
            if let Some(a) = acc.remove(&next_out) {
                let o = next_out as usize * dw as usize * 4;
                for (d, v) in out[o..o + dw as usize * 4].iter_mut().zip(&a) {
                    *d = v.round().clamp(0.0, 255.0) as u8;
                }
            }
            next_out += 1;
        }
    }
    out
}

/// `base` and its mip levels down to 1 x 1 (sizes as the GPU's: each side halved, rounded down).
fn mips(base: Level) -> Vec<Level> {
    let mut levels = vec![base];
    loop {
        let l = levels.last().unwrap_or_else(|| unreachable!());
        if l.w == 1 && l.h == 1 {
            break;
        }
        let (w, h) = ((l.w / 2).max(1), (l.h / 2).max(1));
        let rgba = {
            let (sw, src) = (l.w as usize, &l.rgba);
            area_resize(l.w, l.h, w, h, |y, out| {
                let o = y as usize * sw * 4;
                out.copy_from_slice(&src[o..o + sw * 4]);
            })
        };
        levels.push(Level { w, h, rgba });
    }
    levels
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_urls_of_both_kinds() {
        let b = file_bytes(b"data:image/png;base64,aGVsbG8=").unwrap();
        assert_eq!(b, b"hello");
        let s = file_bytes(b"data:image/svg+xml;charset=utf-8,%3Csvg%20x%3D%221%22%3E").unwrap();
        assert_eq!(s, b"<svg x=\"1\">");
        assert_eq!(file_bytes(b"\x89PNG").unwrap(), b"\x89PNG");
    }

    #[test]
    fn area_averages_keep_the_mean() {
        // A 3 x 1 row of 0, 255, 0 to 2 x 1: each half covers 1.5 px.
        let src = [0u8, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255];
        let out = area_resize(3, 1, 2, 1, |_, o| o.copy_from_slice(&src));
        assert_eq!(&out[..4], &[85, 85, 85, 255]);
        assert_eq!(&out[4..], &[85, 85, 85, 255]);
    }

    #[test]
    fn bands_follow_the_screen() {
        let src = Source {
            id: 1,
            kind: Kind::Raster,
            width: 12000,
            height: 9000,
            bytes: Arc::from(&b""[..]),
        };
        let b = band(&src, 1000.0, 700.0, 8192, 1 << 26);
        assert_eq!(b, Size { w: 1500, h: 1125 });
        let big = band(&src, 20000.0, 15000.0, 8192, 1 << 26);
        assert!(big.w <= 8192 && big.h <= 8192 && big.w as u64 * big.h as u64 <= 1 << 26);
        let svg = Source {
            kind: Kind::Svg,
            width: 100,
            height: 50,
            ..src
        };
        assert_eq!(
            band(&svg, 300.0, 150.0, 8192, 1 << 26),
            Size { w: 400, h: 200 }
        );
    }
}
