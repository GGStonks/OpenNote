use crate::types::{FillType, LineStyle, ModeledKind, NoteDocument, NotePage, PenStyle, Point, ShapeKind, Stroke};
use serde::{Deserialize, Serialize};

pub const PACKED_STRIDE: usize = 6;

fn deserialize_nan_vec<'de, D>(deserializer: D) -> Result<Vec<f64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct NanVecVisitor;
    impl<'de> serde::de::Visitor<'de> for NanVecVisitor {
        type Value = Vec<f64>;
        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("a sequence of numbers or nulls representing packed points")
        }
        fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
        where
            A: serde::de::SeqAccess<'de>,
        {
            let mut vec = Vec::new();
            while let Some(elem) = seq.next_element::<Option<f64>>()? {
                vec.push(elem.unwrap_or(f64::NAN));
            }
            Ok(vec)
        }
    }
    deserializer.deserialize_seq(NanVecVisitor)
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredStroke {
    pub id: String,
    pub tool: String,
    pub color: String,
    pub width: f64,
    pub opacity: f64,
    #[serde(default, deserialize_with = "deserialize_nan_vec")]
    pub pts: Vec<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub points: Vec<Point>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_style: Option<LineStyle>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pen_style: Option<PenStyle>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_shape: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub closed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shape_kind: Option<ShapeKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill: Option<FillType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill_opacity: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arrow: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modeled: Option<ModeledKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pen_end: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rotation: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub highlight_alpha: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dash_offset: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill_only: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredPage {
    pub id: String,
    pub page_number: usize,
    #[serde(default)]
    pub strokes: Vec<StoredStroke>,
    #[serde(default)]
    pub latex_blocks: Vec<crate::types::LatexBlock>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_blocks: Option<Vec<crate::types::TextBlock>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_blocks: Option<Vec<crate::types::ImageBlock>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredNoteDocument {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag_ids: Option<Vec<String>>,
    pub created_at: f64,
    pub updated_at: f64,
    pub paper_style: crate::types::PaperStyle,
    pub paper_color: crate::types::PaperColor,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pattern_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_size: Option<crate::types::PageSize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orientation: Option<crate::types::PageOrientation>,
    pub pages: Vec<StoredPage>,
    pub sheets: Vec<crate::types::PageSheet>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema_version: Option<usize>,
}

pub fn pack_stroke(s: &Stroke) -> StoredStroke {
    let mut pts = Vec::with_capacity(s.points.len() * PACKED_STRIDE);
    for p in &s.points {
        pts.push(p.x);
        pts.push(p.y);
        pts.push(p.pressure);
        pts.push(p.t.unwrap_or(f64::NAN));
        pts.push(p.alt.unwrap_or(f64::NAN));
        pts.push(p.az.unwrap_or(f64::NAN));
    }
    StoredStroke {
        id: s.id.clone(),
        tool: s.tool.clone(),
        color: s.color.clone(),
        width: s.width,
        opacity: s.opacity,
        pts,
        points: Vec::new(),
        line_style: s.line_style,
        pen_style: s.pen_style,
        is_shape: s.is_shape,
        closed: s.closed,
        shape_kind: s.shape_kind,
        fill: s.fill,
        fill_color: s.fill_color.clone(),
        fill_opacity: s.fill_opacity,
        arrow: s.arrow,
        modeled: s.modeled,
        pen_end: s.pen_end,
        rotation: s.rotation,
        created_at: s.created_at,
        highlight_alpha: s.highlight_alpha,
        dash_offset: s.dash_offset,
        fill_only: s.fill_only,
    }
}

pub fn decode_points(pts: &[f64]) -> Vec<Point> {
    let mut points = Vec::with_capacity(pts.len() / PACKED_STRIDE);
    let mut o = 0;
    while o + PACKED_STRIDE <= pts.len() {
        let x = pts[o];
        let y = pts[o + 1];
        let pressure = pts[o + 2];
        let t_val = pts[o + 3];
        let alt_val = pts[o + 4];
        let az_val = pts[o + 5];

        let t = if t_val.is_nan() { None } else { Some(t_val) };
        let alt = if alt_val.is_nan() { None } else { Some(alt_val) };
        let az = if az_val.is_nan() { None } else { Some(az_val) };

        points.push(Point {
            x,
            y,
            pressure,
            t,
            alt,
            az,
        });
        o += PACKED_STRIDE;
    }
    points
}

pub fn unpack_stroke(s: &StoredStroke) -> Stroke {
    let points = if !s.pts.is_empty() {
        decode_points(&s.pts)
    } else {
        s.points.clone()
    };
    Stroke {
        id: s.id.clone(),
        tool: s.tool.clone(),
        color: s.color.clone(),
        width: s.width,
        opacity: s.opacity,
        points,
        line_style: s.line_style,
        pen_style: s.pen_style,
        is_shape: s.is_shape,
        closed: s.closed,
        shape_kind: s.shape_kind,
        fill: s.fill,
        fill_color: s.fill_color.clone(),
        fill_opacity: s.fill_opacity,
        arrow: s.arrow,
        modeled: s.modeled,
        pen_end: s.pen_end,
        rotation: s.rotation,
        created_at: s.created_at,
        highlight_alpha: s.highlight_alpha,
        dash_offset: s.dash_offset,
        fill_only: s.fill_only,
    }
}

pub fn pack_note(note: &NoteDocument) -> StoredNoteDocument {
    StoredNoteDocument {
        id: note.id.clone(),
        title: note.title.clone(),
        subject_id: note.subject_id.clone(),
        folder_id: note.folder_id.clone(),
        tag_ids: note.tag_ids.clone(),
        created_at: note.created_at,
        updated_at: note.updated_at,
        paper_style: note.paper_style,
        paper_color: note.paper_color.clone(),
        pattern_color: note.pattern_color.clone(),
        page_size: note.page_size,
        orientation: note.orientation,
        pages: note
            .pages
            .iter()
            .map(|p| StoredPage {
                id: p.id.clone(),
                page_number: p.page_number,
                strokes: p.strokes.iter().map(pack_stroke).collect(),
                latex_blocks: p.latex_blocks.clone(),
                text_blocks: p.text_blocks.clone(),
                image_blocks: p.image_blocks.clone(),
            })
            .collect(),
        sheets: note.sheets.clone(),
        schema_version: note.schema_version,
    }
}

pub fn unpack_note(stored: &StoredNoteDocument) -> NoteDocument {
    NoteDocument {
        id: stored.id.clone(),
        title: stored.title.clone(),
        subject_id: stored.subject_id.clone(),
        folder_id: stored.folder_id.clone(),
        tag_ids: stored.tag_ids.clone(),
        created_at: stored.created_at,
        updated_at: stored.updated_at,
        paper_style: stored.paper_style,
        paper_color: stored.paper_color.clone(),
        pattern_color: stored.pattern_color.clone(),
        page_size: stored.page_size,
        orientation: stored.orientation,
        pages: stored
            .pages
            .iter()
            .map(|p| NotePage {
                id: p.id.clone(),
                page_number: p.page_number,
                strokes: p.strokes.iter().map(unpack_stroke).collect(),
                latex_blocks: p.latex_blocks.clone(),
                text_blocks: p.text_blocks.clone(),
                image_blocks: p.image_blocks.clone(),
            })
            .collect(),
        sheets: stored.sheets.clone(),
        schema_version: stored.schema_version,
    }
}
