pub mod docx;
pub mod flatbuffer;
pub mod notability;
pub mod text;

pub use docx::*;
pub use flatbuffer::*;
pub use notability::*;
pub use text::*;

use model::NoteDocument;
use std::path::Path;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum ImportError {
    #[error("Docx import error: {0}")]
    Docx(#[from] docx::DocxError),
    #[error("Notability import error: {0}")]
    Notability(#[from] notability::NotabilityError),
    #[error("Unsupported file extension: {0}")]
    Unsupported(String),
}

pub fn import_file(name: &str, bytes: &[u8]) -> Result<NoteDocument, ImportError> {
    let path = Path::new(name);
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Imported");

    match ext.as_str() {
        "docx" => Ok(docx::import_docx(bytes, stem)?),
        "note" | "ntb" => Ok(notability::import_notability(bytes, stem)?),
        "txt" | "md" => {
            let content = String::from_utf8_lossy(bytes);
            Ok(text::import_plain_text(&content, stem))
        }
        "tex" => {
            let content = String::from_utf8_lossy(bytes);
            Ok(text::import_latex_file(&content, stem))
        }
        _ => Err(ImportError::Unsupported(ext)),
    }
}
