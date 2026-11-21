//! SVG export reference: layer_svg and svg_head against TypeScript.
//!
//! Note: text/formula foreignObjects are out of scope (TS needs a DOM): skipped blocks that are not strokes.

use model::NotePage;
use serde_json::Value;
use svg::{layer_svg, svg_head};

#[derive(Debug, PartialEq)]
enum PathToken {
    Cmd(char),
    Num(f64),
}

fn tokenize_path(d: &str) -> Vec<PathToken> {
    let mut tokens = Vec::new();
    let mut chars = d.chars().peekable();
    while let Some(&c) = chars.peek() {
        if c.is_ascii_whitespace() || c == ',' {
            chars.next();
        } else if c.is_ascii_alphabetic() {
            tokens.push(PathToken::Cmd(c));
            chars.next();
        } else if c == '-' || c == '+' || c == '.' || c.is_ascii_digit() {
            let mut num_str = String::new();
            while let Some(&nc) = chars.peek() {
                if nc == '-' || nc == '+' {
                    if !num_str.is_empty() && !num_str.ends_with('e') && !num_str.ends_with('E') {
                        break;
                    }
                } else if nc != '.' && !nc.is_ascii_digit() && nc != 'e' && nc != 'E' {
                    break;
                }
                num_str.push(nc);
                chars.next();
            }
            if let Ok(v) = num_str.parse::<f64>() {
                tokens.push(PathToken::Num(v));
            }
        } else {
            chars.next();
        }
    }
    tokens
}

fn check_path_d(got_d: &str, want_d: &str) -> Result<(), String> {
    let got_tok = tokenize_path(got_d);
    let want_tok = tokenize_path(want_d);
    if got_tok.len() != want_tok.len() {
        return Err(format!(
            "Path token count mismatch: got {} vs want {}",
            got_tok.len(),
            want_tok.len()
        ));
    }
    for (i, (g, w)) in got_tok.iter().zip(want_tok.iter()).enumerate() {
        match (g, w) {
            (PathToken::Cmd(c1), PathToken::Cmd(c2)) => {
                if c1 != c2 {
                    return Err(format!(
                        "Path command mismatch at token {i}: '{c1}' vs '{c2}'"
                    ));
                }
            }
            (PathToken::Num(n1), PathToken::Num(n2)) => {
                if (n1 - n2).abs() > 1e-4 {
                    return Err(format!(
                        "Path number mismatch at token {i}: {n1} vs {n2} (diff {})",
                        (n1 - n2).abs()
                    ));
                }
            }
            _ => {
                return Err(format!(
                    "Path token type mismatch at {i}: got {g:?}, want {w:?}"
                ))
            }
        }
    }
    Ok(())
}

#[allow(dead_code)]
fn compare_path_d(got_d: &str, want_d: &str) {
    if let Err(e) = check_path_d(got_d, want_d) {
        panic!("{e}");
    }
}

fn check_attr(key: &str, val_got: &str, val_want: &str) -> Result<(), String> {
    if key == "d" {
        check_path_d(val_got, val_want)
    } else if key == "viewBox" || key == "points" || key == "stroke-dasharray" {
        let nums_got: Vec<f64> = val_got
            .split(|c: char| c.is_ascii_whitespace() || c == ',')
            .filter(|s| !s.is_empty())
            .map(|s| s.parse::<f64>().expect("valid float"))
            .collect();
        let nums_want: Vec<f64> = val_want
            .split(|c: char| c.is_ascii_whitespace() || c == ',')
            .filter(|s| !s.is_empty())
            .map(|s| s.parse::<f64>().expect("valid float"))
            .collect();
        if nums_got.len() != nums_want.len() {
            return Err(format!(
                "Attribute '{key}' count mismatch: {} vs {}",
                nums_got.len(),
                nums_want.len()
            ));
        }
        for (i, (g, w)) in nums_got.iter().zip(nums_want.iter()).enumerate() {
            if (g - w).abs() > 1e-4 {
                return Err(format!(
                    "Attribute '{key}' number mismatch at {i}: {g} vs {w}"
                ));
            }
        }
        Ok(())
    } else if let (Ok(g), Ok(w)) = (val_got.parse::<f64>(), val_want.parse::<f64>()) {
        if (g - w).abs() > 1e-4 {
            return Err(format!("Attribute '{key}' numeric mismatch: {g} vs {w}"));
        }
        Ok(())
    } else {
        if val_got != val_want {
            return Err(format!(
                "Attribute '{key}' text mismatch: '{val_got}' vs '{val_want}'"
            ));
        }
        Ok(())
    }
}

#[allow(dead_code)]
fn compare_attr(key: &str, val_got: &str, val_want: &str) {
    if let Err(e) = check_attr(key, val_got, val_want) {
        panic!("{e}");
    }
}

struct XmlElement {
    tag: String,
    attrs: Vec<(String, String)>,
}

fn extract_elements(xml: &str) -> Vec<XmlElement> {
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let mut reader = Reader::from_str(xml);
    let mut elements = Vec::new();

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                let tag = String::from_utf8_lossy(e.name().as_ref()).to_string();
                let mut attrs = Vec::new();
                for a in e.attributes().flatten() {
                    let key = String::from_utf8_lossy(a.key.as_ref()).to_string();
                    let val = a
                        .decode_and_unescape_value(reader.decoder())
                        .unwrap()
                        .to_string();
                    attrs.push((key, val));
                }
                elements.push(XmlElement { tag, attrs });
            }
            Ok(Event::Eof) => break,
            Err(e) => panic!("Error parsing XML: {e}"),
            _ => {}
        }
    }
    elements
}

fn check_xml_structurally(got_xml: &str, want_xml: &str) -> Result<(), String> {
    let got_elems = extract_elements(got_xml);
    let want_elems = extract_elements(want_xml);

    if got_elems.len() != want_elems.len() {
        return Err(format!(
            "Element count mismatch: got {} vs want {}",
            got_elems.len(),
            want_elems.len()
        ));
    }

    for (i, (g, w)) in got_elems.iter().zip(want_elems.iter()).enumerate() {
        if g.tag != w.tag {
            return Err(format!("Element {i} tag mismatch: {} vs {}", g.tag, w.tag));
        }
        if g.attrs.len() != w.attrs.len() {
            return Err(format!(
                "Element {i} ({}) attribute count mismatch: got {} vs want {}",
                g.tag,
                g.attrs.len(),
                w.attrs.len()
            ));
        }
        for ((k_got, v_got), (k_want, v_want)) in g.attrs.iter().zip(w.attrs.iter()) {
            if k_got != k_want {
                return Err(format!(
                    "Element {i} ({}) attribute key mismatch: '{}' vs '{}'",
                    g.tag, k_got, k_want
                ));
            }
            check_attr(k_got, v_got, v_want)?;
        }
    }
    Ok(())
}

fn compare_xml_structurally(got_xml: &str, want_xml: &str) {
    if let Err(e) = check_xml_structurally(got_xml, want_xml) {
        panic!("{e}");
    }
}

fn reference() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../bench/rust-ref/svg.json");
    let text = std::fs::read_to_string(path)
        .unwrap_or_else(|_| panic!("{path} is missing: run bench:rustref to generate svg.json"));
    serde_json::from_str(&text).expect("svg.json is valid JSON")
}

#[test]
fn test_svg_reference() {
    let ref_data = reference();

    let page: NotePage = serde_json::from_value(ref_data["page"].clone()).expect("valid page");
    let vb = ref_data["viewBox"].as_array().expect("viewBox array");
    let view_box = [
        vb[0].as_f64().unwrap(),
        vb[1].as_f64().unwrap(),
        vb[2].as_f64().unwrap(),
        vb[3].as_f64().unwrap(),
    ];
    let paper = ref_data["paper"].as_str().unwrap_or("#ffffff");
    let ink = ref_data["ink"].as_str().unwrap_or("#000000");

    let layers = shapes::zorder::z_layers(&page);

    // Test svg_head
    let rust_head = svg_head(view_box, &layers);
    let want_head = ref_data["svgHead"].as_str().unwrap();
    compare_xml_structurally(&format!("{rust_head}</svg>"), &format!("{want_head}</svg>"));

    // Test layer_svg
    assert!(!layers.is_empty(), "expected at least one layer");
    let strokes = match &layers[0] {
        shapes::zorder::ZLayer::Ink { strokes, .. } => strokes,
        _ => panic!("expected ink layer"),
    };
    let order: Vec<&model::Stroke> = strokes
        .iter()
        .filter(|s| s.tool == "highlighter")
        .chain(strokes.iter().filter(|s| s.tool != "highlighter"))
        .collect();

    let want_layer = ref_data["layerSvg"].as_str().unwrap();
    let want_lines: Vec<&str> = want_layer.lines().collect();

    let mut differing = Vec::new();
    for (i, s) in order.iter().enumerate() {
        let rust_s = svg::stroke_to_svg_with_paper(s, 0.0, paper);
        let want_s = want_lines.get(i).copied().unwrap_or("");
        if let Err(e) =
            check_xml_structurally(&format!("<g>{rust_s}</g>"), &format!("<g>{want_s}</g>"))
        {
            eprintln!("Difference on stroke {}: {}", s.id, e);
            differing.push(s.id.clone());
        }
    }

    if !differing.is_empty() {
        panic!(
            "Differing stroke ids ({}): {:?}",
            differing.len(),
            differing
        );
    }

    let rust_layer = layer_svg(&layers[0], 0.0, paper, ink);
    compare_xml_structurally(
        &format!("<g>{rust_layer}</g>"),
        &format!("<g>{want_layer}</g>"),
    );
}
