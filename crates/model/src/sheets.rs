use crate::types::{
    ImageBlock, LatexBlock, NoteDocument, NotePage, PageOrientation, PageSheet, PageSize,
    PaperColor, PaperStyle, PdfPageRef, Stroke, TextBlock, PAGE_HEIGHT,
};
use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static ID_COUNTER: AtomicU64 = AtomicU64::new(1);

pub fn new_id(prefix: &str) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let cnt = ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{}_{:x}_{:x}", prefix, now, cnt)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PageDim {
    pub w: f64,
    pub h: f64,
}

pub fn page_size_dims(size: PageSize) -> PageDim {
    match size {
        PageSize::Letter => PageDim { w: 816.0, h: 1056.0 },
        PageSize::Legal => PageDim { w: 816.0, h: 1344.0 },
        PageSize::A3 => PageDim { w: 1123.0, h: 1587.0 },
        PageSize::A4 => PageDim { w: 794.0, h: 1123.0 },
        PageSize::A5 => PageDim { w: 559.0, h: 794.0 },
        PageSize::B5 => PageDim { w: 665.0, h: 945.0 },
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct PageSetup {
    pub custom: bool,
    pub pdf: Option<PdfPageRef>,
    pub paper_style: PaperStyle,
    pub paper_color: PaperColor,
    pub pattern_color: Option<String>,
    pub size: PageSize,
    pub orientation: PageOrientation,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SetupPatch {
    pub paper_style: Option<PaperStyle>,
    pub paper_color: Option<PaperColor>,
    pub pattern_color: Option<Option<String>>,
    pub size: Option<PageSize>,
    pub orientation: Option<PageOrientation>,
}

pub fn page_setup(doc: &NoteDocument, page: &PageSheet) -> PageSetup {
    let size = page.size.or(doc.page_size).unwrap_or(PageSize::Letter);
    let orientation = page.orientation.or(doc.orientation).unwrap_or(PageOrientation::Portrait);
    let s = page_size_dims(size);
    let landscape = orientation == PageOrientation::Landscape;
    let custom = page.width.is_some()
        && page.height.is_some()
        && page.width.unwrap() > 0.0
        && page.height.unwrap() > 0.0;
    PageSetup {
        custom,
        pdf: page.pdf.clone(),
        paper_style: page.paper_style.unwrap_or(doc.paper_style),
        paper_color: page.paper_color.clone().unwrap_or_else(|| doc.paper_color.clone()),
        pattern_color: page.pattern_color.clone().or_else(|| doc.pattern_color.clone()),
        size,
        orientation,
        width: if custom {
            page.width.unwrap()
        } else if landscape {
            s.h
        } else {
            s.w
        },
        height: if custom {
            page.height.unwrap()
        } else if landscape {
            s.w
        } else {
            s.h
        },
    }
}

pub fn has_own_setup(p: &PageSheet) -> bool {
    p.paper_style.is_some()
        || p.paper_color.is_some()
        || p.pattern_color.is_some()
        || p.size.is_some()
        || p.orientation.is_some()
}

#[derive(Clone, Debug, PartialEq)]
pub struct SheetBox {
    pub id: String,
    pub index: usize,
    pub top: f64,
    pub left: f64,
    pub bookmarked: bool,
    pub setup: PageSetup,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SurfaceLayout {
    pub width: f64,
    pub height: f64,
    pub sheets: Vec<SheetBox>,
}

pub fn surface_layout(doc: &NoteDocument) -> SurfaceLayout {
    let list: Vec<PageSheet> = if doc.sheets.is_empty() {
        vec![PageSheet {
            id: "_".to_string(),
            paper_style: None,
            paper_color: None,
            pattern_color: None,
            size: None,
            orientation: None,
            width: None,
            height: None,
            pdf: None,
            bookmarked: None,
        }]
    } else {
        doc.sheets.clone()
    };
    let setups: Vec<PageSetup> = list.iter().map(|s| page_setup(doc, s)).collect();
    let width = setups.iter().map(|s| s.width).fold(0.0, f64::max);
    let mut top = 0.0;
    let mut sheets = Vec::with_capacity(setups.len());
    for (i, s) in setups.into_iter().enumerate() {
        let h = s.height;
        let w = s.width;
        let b = SheetBox {
            id: list[i].id.clone(),
            index: i,
            top,
            left: (width - w) / 2.0,
            bookmarked: list[i].bookmarked.unwrap_or(false),
            setup: s,
        };
        top += h;
        sheets.push(b);
    }
    SurfaceLayout {
        width,
        height: top,
        sheets,
    }
}

pub fn sheet_index_at(layout: &SurfaceLayout, y: f64) -> usize {
    let s = &layout.sheets;
    let mut k = 0;
    while k + 1 < s.len() && s[k + 1].top <= y {
        k += 1;
    }
    k
}

pub fn stroke_y(s: &Stroke) -> (f64, f64) {
    let mut min_y = f64::INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for p in &s.points {
        if p.y < min_y {
            min_y = p.y;
        }
        if p.y > max_y {
            max_y = p.y;
        }
    }
    (min_y, max_y)
}

pub fn text_h(t: &TextBlock) -> f64 {
    let lines = t.text.split('\n').count().max(1) as f64;
    t.font_size * 1.4 * lines
}

pub fn content_bottom(p: &NotePage) -> f64 {
    let mut b = f64::NEG_INFINITY;
    for s in &p.strokes {
        let (_, max_y) = stroke_y(s);
        if max_y > b {
            b = max_y;
        }
    }
    for x in &p.latex_blocks {
        let y2 = x.y + x.height;
        if y2 > b {
            b = y2;
        }
    }
    if let Some(text_blocks) = &p.text_blocks {
        for x in text_blocks {
            let y2 = x.y + text_h(x);
            if y2 > b {
                b = y2;
            }
        }
    }
    if let Some(image_blocks) = &p.image_blocks {
        for x in image_blocks {
            let y2 = x.y + x.height;
            if y2 > b {
                b = y2;
            }
        }
    }
    b
}

#[derive(Clone, Debug, Default)]
pub struct Items {
    pub strokes: Vec<Stroke>,
    pub latex_blocks: Vec<LatexBlock>,
    pub text_blocks: Vec<TextBlock>,
    pub image_blocks: Vec<ImageBlock>,
}

impl Items {
    pub fn is_empty(&self) -> bool {
        self.strokes.is_empty()
            && self.latex_blocks.is_empty()
            && self.text_blocks.is_empty()
            && self.image_blocks.is_empty()
    }

    pub fn translate(&self, dx: f64, dy: f64) -> Self {
        if dx == 0.0 && dy == 0.0 {
            return self.clone();
        }
        Items {
            strokes: self
                .strokes
                .iter()
                .map(|s| {
                    let mut s2 = s.clone();
                    for p in &mut s2.points {
                        p.x += dx;
                        p.y += dy;
                    }
                    s2
                })
                .collect(),
            latex_blocks: self
                .latex_blocks
                .iter()
                .map(|b| {
                    let mut b2 = b.clone();
                    b2.x += dx;
                    b2.y += dy;
                    b2
                })
                .collect(),
            text_blocks: self
                .text_blocks
                .iter()
                .map(|b| {
                    let mut b2 = b.clone();
                    b2.x += dx;
                    b2.y += dy;
                    b2
                })
                .collect(),
            image_blocks: self
                .image_blocks
                .iter()
                .map(|b| {
                    let mut b2 = b.clone();
                    b2.x += dx;
                    b2.y += dy;
                    b2
                })
                .collect(),
        }
    }
}

pub fn ownership(surface: &NotePage, layout: &SurfaceLayout) -> Vec<Items> {
    let mut out: Vec<Items> = (0..layout.sheets.len()).map(|_| Items::default()).collect();
    if out.is_empty() {
        return out;
    }
    let at_idx = |y: f64| sheet_index_at(layout, y);

    for s in &surface.strokes {
        let (min_y, max_y) = stroke_y(s);
        let mid = (min_y + max_y) / 2.0;
        let idx = at_idx(mid);
        out[idx].strokes.push(s.clone());
    }
    for b in &surface.latex_blocks {
        let mid = b.y + b.height / 2.0;
        let idx = at_idx(mid);
        out[idx].latex_blocks.push(b.clone());
    }
    if let Some(text_blocks) = &surface.text_blocks {
        for b in text_blocks {
            let idx = at_idx(b.y);
            out[idx].text_blocks.push(b.clone());
        }
    }
    if let Some(image_blocks) = &surface.image_blocks {
        for b in image_blocks {
            let mid = b.y + b.height / 2.0;
            let idx = at_idx(mid);
            out[idx].image_blocks.push(b.clone());
        }
    }
    out
}

pub fn letter_sheets_for(surface: &NotePage) -> Vec<PageSheet> {
    let b = content_bottom(surface);
    let n = if b.is_finite() {
        (b.max(0.0) / PAGE_HEIGHT).floor() as usize + 1
    } else {
        1
    };
    (0..n)
        .map(|_| PageSheet {
            id: new_id("sheet"),
            paper_style: None,
            paper_color: None,
            pattern_color: None,
            size: None,
            orientation: None,
            width: None,
            height: None,
            pdf: None,
            bookmarked: None,
        })
        .collect()
}

pub fn surface_from_pages(
    doc: &NoteDocument,
    pages: &[NotePage],
) -> (NotePage, Vec<PageSheet>) {
    let sheets: Vec<PageSheet> = pages
        .iter()
        .map(|_| PageSheet {
            id: new_id("sheet"),
            paper_style: None,
            paper_color: None,
            pattern_color: None,
            size: None,
            orientation: None,
            width: None,
            height: None,
            pdf: None,
            bookmarked: None,
        })
        .collect();

    let mut doc_with_sheets = doc.clone();
    doc_with_sheets.sheets = sheets.clone();
    let layout = surface_layout(&doc_with_sheets);

    let mut out = Items::default();
    for (i, p) in pages.iter().enumerate() {
        let left = layout.sheets[i].left;
        let top = layout.sheets[i].top;
        let page_items = Items {
            strokes: p.strokes.clone(),
            latex_blocks: p.latex_blocks.clone(),
            text_blocks: p.text_blocks.clone().unwrap_or_default(),
            image_blocks: p.image_blocks.clone().unwrap_or_default(),
        };
        let translated = page_items.translate(left, top);
        out.strokes.extend(translated.strokes);
        out.latex_blocks.extend(translated.latex_blocks);
        out.text_blocks.extend(translated.text_blocks);
        out.image_blocks.extend(translated.image_blocks);
    }
    let first_id = pages
        .first()
        .map(|p| p.id.clone())
        .unwrap_or_else(|| new_id("page"));
    (
        NotePage {
            id: first_id,
            page_number: 1,
            strokes: out.strokes,
            latex_blocks: out.latex_blocks,
            text_blocks: Some(out.text_blocks),
            image_blocks: Some(out.image_blocks),
        },
        sheets,
    )
}

pub fn append_blank_sheet(d: &NoteDocument) -> NoteDocument {
    let mut nd = d.clone();
    nd.sheets.push(PageSheet {
        id: new_id("sheet"),
        paper_style: None,
        paper_color: None,
        pattern_color: None,
        size: None,
        orientation: None,
        width: None,
        height: None,
        pdf: None,
        bookmarked: None,
    });
    nd
}

const ROLL_ZONE: f64 = 0.75;

pub fn trailing_sheet_for(before: &NotePage, d: &NoteDocument) -> NoteDocument {
    if d.pages.is_empty() {
        return d.clone();
    }
    let after = &d.pages[0];
    let had_ids: HashSet<String> = before
        .strokes
        .iter()
        .map(|s| s.id.clone())
        .chain(before.latex_blocks.iter().map(|b| b.id.clone()))
        .chain(
            before
                .text_blocks
                .iter()
                .flatten()
                .map(|b| b.id.clone()),
        )
        .chain(
            before
                .image_blocks
                .iter()
                .flatten()
                .map(|b| b.id.clone()),
        )
        .collect();

    let mut bottom = f64::NEG_INFINITY;
    for s in &after.strokes {
        if !had_ids.contains(&s.id) {
            let (_, max_y) = stroke_y(s);
            if max_y > bottom {
                bottom = max_y;
            }
        }
    }
    for x in &after.latex_blocks {
        if !had_ids.contains(&x.id) {
            let y2 = x.y + x.height;
            if y2 > bottom {
                bottom = y2;
            }
        }
    }
    if let Some(text_blocks) = &after.text_blocks {
        for x in text_blocks {
            if !had_ids.contains(&x.id) {
                let y2 = x.y + text_h(x);
                if y2 > bottom {
                    bottom = y2;
                }
            }
        }
    }
    if let Some(image_blocks) = &after.image_blocks {
        for x in image_blocks {
            if !had_ids.contains(&x.id) {
                let y2 = x.y + x.height;
                if y2 > bottom {
                    bottom = y2;
                }
            }
        }
    }

    let layout = surface_layout(d);
    if let Some(last) = layout.sheets.last() {
        if bottom > last.top + last.setup.height * ROLL_ZONE {
            return append_blank_sheet(d);
        }
    }
    d.clone()
}

#[derive(Clone, Debug)]
pub struct SplitPage {
    pub page: NotePage,
    pub box_: SheetBox,
}

pub fn split_into_pages(doc: &NoteDocument) -> Vec<SplitPage> {
    if doc.pages.is_empty() {
        return Vec::new();
    }
    let l = surface_layout(doc);
    let own = ownership(&doc.pages[0], &l);
    let mut n = own.len();
    while n > 1 && own[n - 1].is_empty() {
        n -= 1;
    }
    l.sheets[..n]
        .iter()
        .zip(own.into_iter().take(n))
        .enumerate()
        .map(|(i, (b, item))| {
            let c = item.translate(-b.left, -b.top);
            let page = NotePage {
                id: format!("{}_p{}", doc.pages[0].id, i),
                page_number: i + 1,
                strokes: c.strokes,
                latex_blocks: c.latex_blocks,
                text_blocks: if c.text_blocks.is_empty() { None } else { Some(c.text_blocks) },
                image_blocks: if c.image_blocks.is_empty() { None } else { Some(c.image_blocks) },
            };
            SplitPage {
                page,
                box_: b.clone(),
            }
        })
        .collect()
}

