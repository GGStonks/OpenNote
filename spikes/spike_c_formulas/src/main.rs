use std::fs;
use std::path::Path;

fn extract_latex_from_conversion_file(content: &str) -> Option<String> {
    if let Some(pos) = content.find("=== REPLY ===") {
        let reply = &content[pos + 13..].trim();
        // Remove tikz pictures, keep formulas
        if reply.contains("\\begin{tikzpicture}") {
            return None;
        }
        let formula = reply.lines().next().unwrap_or("").trim().to_string();
        if !formula.is_empty() {
            return Some(formula);
        }
    }
    None
}

fn main() {
    let mut formulas = vec![
        r"E = mc^2".to_string(),
        r"\frac{-b \pm \sqrt{b^2 - 4ac}}{2a}".to_string(),
        r"\int_{-\infty}^{\infty} e^{-x^2} dx = \sqrt{\pi}".to_string(),
        r"\sum_{n=1}^{\infty} \frac{1}{n^2} = \frac{\pi^2}{6}".to_string(),
        r"\begin{pmatrix} a & b \\ c & d \end{pmatrix}".to_string(),
        r"\lim_{x \to 0} \frac{\sin x}{x} = 1".to_string(),
        r"f(x) = \begin{cases} x & x \ge 0 \\ -x & x < 0 \end{cases}".to_string(),
    ];

    // Read real notes conversions if present
    let conv_dir = Path::new("/home/ds/AI/notes2latex/conversions");
    if conv_dir.exists() {
        if let Ok(entries) = fs::read_dir(conv_dir) {
            for entry in entries.flatten() {
                if entry.path().extension().and_then(|s| s.to_str()) == Some("txt") {
                    if let Ok(txt) = fs::read_to_string(entry.path()) {
                        if let Some(f) = extract_latex_from_conversion_file(&txt) {
                            formulas.push(f);
                        }
                    }
                }
            }
        }
    }

    println!("Testing mitex on {} formula samples...", formulas.len());
    let mut success = 0;
    let mut failures = 0;

    for (idx, f) in formulas.iter().enumerate() {
        match mitex::convert_math(f, None) {
            Ok(typst_code) => {
                success += 1;
                if idx < 5 {
                    println!("[OK] LaTeX: {}", f);
                    println!("     Typst: {}", typst_code);
                }
            }
            Err(e) => {
                failures += 1;
                println!("[FAIL] LaTeX: {}\n       Error: {:?}", f, e);
            }
        }
    }

    println!("\n=== Spike C Result ===");
    println!("Total formulas: {}", formulas.len());
    println!("Success: {}", success);
    println!("Failures: {}", failures);
    println!("Pass rate: {:.1}%", (success as f64 / formulas.len() as f64) * 100.0);
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_mitex_conversion() {
        let latex = r"\frac{a}{b} + c^2";
        let res = mitex::convert_math(latex, None);
        assert!(res.is_ok());
        let typst = res.unwrap();
        assert!(typst.contains("frac(a ,b )"));
    }
}
