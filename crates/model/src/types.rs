use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolType {
    Pen,
    Shape,
    Highlighter,
    Eraser,
    Lasso,
    Text,
    Hand,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ShapeMode {
    Curve,
    Line,
    Rectangle,
    Ellipse,
    Point,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FillType {
    None,
    Solid,
    NorthEast,
    NorthWest,
    Crosshatch,
    Hole,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PenStyle {
    Fountain,
    Ballpoint,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EraserMode {
    Stroke,
    Partial,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PaperStyle {
    Blank,
    Ruled,
    Narrow,
    Lines,
    NarrowLines,
    Grid,
    Graph,
    Dots,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PaperColor {
    Name(String),
    Hex(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PageSize {
    Letter,
    Legal,
    A3,
    A4,
    A5,
    B5,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PageOrientation {
    Portrait,
    Landscape,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LineStyle {
    Solid,
    Dashed,
    Dotted,
    Dashdot,
    Longdash,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ShapeKind {
    Line,
    Arrow,
    Polyline,
    Triangle,
    Rectangle,
    Polygon,
    Ellipse,
    Circle,
    Curve,
    Point,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ModeledKind {
    Variable,
    Uniform,
    Proportional,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
    pub pressure: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub t: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alt: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub az: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stroke {
    pub id: String,
    pub tool: String,
    pub color: String,
    pub width: f64,
    pub opacity: f64,
    #[serde(default)]
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
pub struct TextSpan {
    pub start: usize,
    pub end: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub italic: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub underline: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strike: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextPara {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub list: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub num: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub align: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextBlock {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
    pub text: String,
    pub font_size: f64,
    pub color: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub italic: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub underline: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub align: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_height: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strike: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spans: Option<Vec<TextSpan>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paras: Option<Vec<TextPara>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub radius: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub padding: Option<[f64; 2]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rotation: Option<f64>,
    pub created_at: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LatexBlock {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scale: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stretch_x: Option<f64>,
    pub latex_code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_tikz: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tikz_svg: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tikz_svg_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rotation: Option<f64>,
    pub created_at: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageBlock {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub data_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rotation: Option<f64>,
    pub created_at: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotePage {
    pub id: String,
    pub page_number: usize,
    #[serde(default)]
    pub strokes: Vec<Stroke>,
    #[serde(default)]
    pub latex_blocks: Vec<LatexBlock>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_blocks: Option<Vec<TextBlock>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_blocks: Option<Vec<ImageBlock>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfPageRef {
    pub file: String,
    pub page: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSheet {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paper_style: Option<PaperStyle>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paper_color: Option<PaperColor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pattern_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<PageSize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orientation: Option<PageOrientation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pdf: Option<PdfPageRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bookmarked: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteDocument {
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
    pub paper_style: PaperStyle,
    pub paper_color: PaperColor,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pattern_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_size: Option<PageSize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orientation: Option<PageOrientation>,
    pub pages: Vec<NotePage>,
    pub sheets: Vec<PageSheet>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema_version: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Subject {
    pub id: String,
    pub name: String,
    pub color: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    pub created_at: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub color: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioRecording {
    pub id: String,
    pub note_id: String,
    pub created_at: f64,
    pub duration_ms: f64,
    pub mime_type: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupFile {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
    pub base64: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryBackup {
    pub format: String,
    pub version: usize,
    pub exported_at: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subjects: Option<Vec<Subject>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folders: Option<Vec<Folder>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<Tag>>,
    pub notes: Vec<NoteDocument>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<BackupFile>>,
}

pub const PAGE_WIDTH: f64 = 816.0;
pub const PAGE_HEIGHT: f64 = 1056.0;
pub const SCHEMA_VERSION: usize = 5;

