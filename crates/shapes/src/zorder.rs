use model::{ImageBlock, LatexBlock, NotePage, Stroke, TextBlock};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn item_time(id: &str, created_at: Option<f64>) -> f64 {
    if let Some(t) = created_at {
        return t;
    }
    let parts: Vec<&str> = id.split('_').collect();
    if parts.len() > 1 {
        if let Ok(t) = u64::from_str_radix(parts[1], 36) {
            return t as f64;
        }
    }
    0.0
}

#[derive(Clone, Debug, PartialEq)]
pub enum ZLayer {
    Ink { key: String, strokes: Vec<Stroke> },
    Image { key: String, block: ImageBlock },
    Latex { key: String, block: LatexBlock },
    Text { key: String, block: TextBlock },
}

pub fn z_layers(page: &NotePage) -> Vec<ZLayer> {
    #[derive(Clone)]
    enum BlockKind {
        Image(ImageBlock),
        Latex(LatexBlock),
        Text(TextBlock),
    }

    struct BlockItem {
        t: f64,
        id: String,
        kind: BlockKind,
    }

    let mut blocks: Vec<BlockItem> = Vec::new();

    if let Some(image_blocks) = &page.image_blocks {
        for b in image_blocks {
            blocks.push(BlockItem {
                t: item_time(&b.id, Some(b.created_at)),
                id: b.id.clone(),
                kind: BlockKind::Image(b.clone()),
            });
        }
    }
    for b in &page.latex_blocks {
        blocks.push(BlockItem {
            t: item_time(&b.id, Some(b.created_at)),
            id: b.id.clone(),
            kind: BlockKind::Latex(b.clone()),
        });
    }
    if let Some(text_blocks) = &page.text_blocks {
        for b in text_blocks {
            blocks.push(BlockItem {
                t: item_time(&b.id, Some(b.created_at)),
                id: b.id.clone(),
                kind: BlockKind::Text(b.clone()),
            });
        }
    }

    blocks.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap());

    let mut ink_layers: Vec<Vec<Stroke>> = (0..=blocks.len()).map(|_| Vec::new()).collect();
    for s in &page.strokes {
        let t = item_time(&s.id, s.created_at);
        let mut lo = 0;
        let mut hi = blocks.len();
        while lo < hi {
            let mid = (lo + hi) / 2;
            if blocks[mid].t <= t {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        ink_layers[lo].push(s.clone());
    }

    let mut out: Vec<ZLayer> = Vec::new();
    if !ink_layers[0].is_empty() {
        out.push(ZLayer::Ink {
            key: "ink:base".to_string(),
            strokes: ink_layers[0].clone(),
        });
    }
    for (i, b) in blocks.into_iter().enumerate() {
        match b.kind {
            BlockKind::Image(img) => out.push(ZLayer::Image {
                key: b.id.clone(),
                block: img,
            }),
            BlockKind::Latex(lat) => out.push(ZLayer::Latex {
                key: b.id.clone(),
                block: lat,
            }),
            BlockKind::Text(txt) => out.push(ZLayer::Text {
                key: b.id.clone(),
                block: txt,
            }),
        }
        if !ink_layers[i + 1].is_empty() {
            out.push(ZLayer::Ink {
                key: format!("ink:{}", b.id),
                strokes: ink_layers[i + 1].clone(),
            });
        }
    }

    out
}

pub fn restamp(page: &mut NotePage, now_opt: Option<f64>) {
    let now = now_opt.unwrap_or_else(|| {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as f64
    });

    #[derive(Clone)]
    enum ItemRef {
        Stroke(usize),
        Latex(usize),
        Text(usize),
        Image(usize),
    }

    let mut items: Vec<(f64, ItemRef)> = Vec::new();
    for (i, s) in page.strokes.iter().enumerate() {
        items.push((item_time(&s.id, s.created_at), ItemRef::Stroke(i)));
    }
    for (i, b) in page.latex_blocks.iter().enumerate() {
        items.push((item_time(&b.id, Some(b.created_at)), ItemRef::Latex(i)));
    }
    if let Some(text_blocks) = &page.text_blocks {
        for (i, b) in text_blocks.iter().enumerate() {
            items.push((item_time(&b.id, Some(b.created_at)), ItemRef::Text(i)));
        }
    }
    if let Some(image_blocks) = &page.image_blocks {
        for (i, b) in image_blocks.iter().enumerate() {
            items.push((item_time(&b.id, Some(b.created_at)), ItemRef::Image(i)));
        }
    }

    items.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());

    for (rank, (_, item_ref)) in items.into_iter().enumerate() {
        let t = now + (rank as f64) / 1000.0;
        match item_ref {
            ItemRef::Stroke(i) => page.strokes[i].created_at = Some(t),
            ItemRef::Latex(i) => page.latex_blocks[i].created_at = t,
            ItemRef::Text(i) => {
                if let Some(tb) = &mut page.text_blocks {
                    tb[i].created_at = t;
                }
            }
            ItemRef::Image(i) => {
                if let Some(ib) = &mut page.image_blocks {
                    ib[i].created_at = t;
                }
            }
        }
    }
}
