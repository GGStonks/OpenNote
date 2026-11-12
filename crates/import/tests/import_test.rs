use import::{import_file, import_latex_file, import_plain_text, FlatBuffer};
use std::io::{Cursor, Write};
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

#[test]
fn test_plain_text_import() {
    let text = "First line of note\nSecond line of note";
    let doc = import_plain_text(text, "My Note");
    assert_eq!(doc.title, "My Note");
    assert_eq!(doc.pages.len(), 1);
    let page = &doc.pages[0];
    let tbs = page.text_blocks.as_ref().unwrap();
    assert_eq!(tbs.len(), 1);
    assert_eq!(tbs[0].text, text);
}

#[test]
fn test_latex_import() {
    let latex = r"\int_{0}^{\infty} e^{-x^2} dx = \frac{\sqrt{\pi}}{2}";
    let doc = import_latex_file(latex, "Integral");
    assert_eq!(doc.title, "Integral");
    assert_eq!(doc.pages.len(), 1);
    let page = &doc.pages[0];
    assert_eq!(page.latex_blocks.len(), 1);
    assert_eq!(page.latex_blocks[0].latex_code, latex);
}

#[test]
fn test_docx_import_mock() {
    let mut zip_buf = Cursor::new(Vec::new());
    {
        let mut zip = ZipWriter::new(&mut zip_buf);
        let options = SimpleFileOptions::default();

        let doc_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
            <w:body>
                <w:p>
                    <w:r>
                        <w:rPr><w:b/><w:color w:val="FF0000"/></w:rPr>
                        <w:t>Hello Bold Red</w:t>
                    </w:r>
                    <w:r>
                        <w:t> Normal text</w:t>
                    </w:r>
                </w:p>
            </w:body>
        </w:document>"#;

        zip.start_file("word/document.xml", options).unwrap();
        zip.write_all(doc_xml.as_bytes()).unwrap();
        zip.finish().unwrap();
    }

    let bytes = zip_buf.into_inner();
    let doc = import_file("document.docx", &bytes).expect("import docx");
    assert_eq!(doc.title, "document");
    assert_eq!(doc.pages.len(), 1);
    let page = &doc.pages[0];
    let tbs = page.text_blocks.as_ref().unwrap();
    assert_eq!(tbs.len(), 1);
    assert_eq!(tbs[0].text, "Hello Bold Red Normal text");
    assert!(tbs[0].spans.is_some());
    let spans = tbs[0].spans.as_ref().unwrap();
    assert_eq!(spans.len(), 1);
    assert_eq!(spans[0].bold, Some(true));
    assert_eq!(spans[0].color, Some("#FF0000".to_string()));
}

#[test]
fn test_flatbuffer_reader() {
    // Construct small binary buffer with u16 and u32
    let mut data = vec![0u8; 16];
    data[0..4].copy_from_slice(&12u32.to_le_bytes());
    data[4..6].copy_from_slice(&42u16.to_le_bytes());

    let fb = FlatBuffer::new(&data);
    assert_eq!(fb.u32(0), Some(12));
    assert_eq!(fb.u16(4), Some(42));
    assert_eq!(fb.root(), Some(12));
}

