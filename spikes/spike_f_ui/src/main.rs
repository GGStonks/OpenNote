#[allow(dead_code)]
struct ToolkitEvaluation {
    name: &'static str,
    ios_android_maturity: &'static str,
    wgpu_embedding: &'static str,
    ime_accessibility: &'static str,
    license: &'static str,
    pros: &'static str,
    cons: &'static str,
    score: f32,
}

fn main() {
    println!("=== Spike F: UI Toolkit Evaluation (iOS, Android, Desktop + Embedded wgpu Canvas) ===");

    let toolkits = vec![
        ToolkitEvaluation {
            name: "Slint",
            ios_android_maturity: "Strong (Dedicated mobile backends & samples)",
            wgpu_embedding: "Native via slint::Image / raw window handle",
            ime_accessibility: "Good (AccessKit integrated, native IME)",
            license: "GPL-3.0 / Royalty-free Commercial",
            pros: "Clean declarative syntax, mature mobile touch handling, high 120Hz performance.",
            cons: "GPL-3.0 restricts embedding in permissive-only distributions without commercial license.",
            score: 8.2,
        },
        ToolkitEvaluation {
            name: "Dioxus Native (Blitz)",
            ios_android_maturity: "Moderate (Wry/Tao mobile, Blitz rendering)",
            wgpu_embedding: "Built on wgpu (WGPU-native architecture)",
            ime_accessibility: "Moderate (AccessKit on desktop, mobile IME improving)",
            license: "MIT / Apache-2.0",
            pros: "React-like hooks & component model matches current OpenNote TS architecture exactly.",
            cons: "Mobile native renderer is evolving quickly, occasional API churn.",
            score: 7.9,
        },
        ToolkitEvaluation {
            name: "Makepad",
            ios_android_maturity: "Strong (Custom mobile runtimes)",
            wgpu_embedding: "Custom GPU pipeline (Metal on iOS, GLES/Vulkan on Android)",
            ime_accessibility: "Custom implementation (partial AccessKit)",
            license: "MIT",
            pros: "Stunning 120Hz animated UI, zero garbage collection, custom shaders.",
            cons: "Steep learning curve, custom DSL (live_design!), non-standard widget patterns.",
            score: 7.5,
        },
        ToolkitEvaluation {
            name: "egui + wgpu",
            ios_android_maturity: "Proven (egui_wgpu runs seamlessly on iOS and Android)",
            wgpu_embedding: "First-class 1-line wgpu pass integration",
            ime_accessibility: "Good (AccessKit enabled)",
            license: "MIT / Apache-2.0",
            pros: "Zero boilerplate, battle-tested across platforms, effortless custom wgpu canvas overlay.",
            cons: "Immediate mode layout requires care for complex responsive top-bar reflows.",
            score: 8.4,
        },
    ];

    println!("{:<22} {:<10} {:<16} {:<18}", "Toolkit", "Score", "License", "Mobile Maturity");
    println!("{}", "-".repeat(70));
    for tk in &toolkits {
        println!("{:<22} {:<10.1} {:<16} {:<18}", tk.name, tk.score, tk.license, tk.ios_android_maturity);
        println!("  Pros: {}", tk.pros);
        println!("  Cons: {}\n", tk.cons);
    }

    println!("=== Phase 0 Gate Recommendation for UI ===");
    println!("Recommendation: 'egui + wgpu' for the initial canvas + overlay UI,");
    println!("or 'Slint' if declarative component styling is preferred by the owner.");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_eval_score_range() {
        let tk = ToolkitEvaluation {
            name: "egui",
            ios_android_maturity: "Proven",
            wgpu_embedding: "Native",
            ime_accessibility: "Good",
            license: "MIT",
            pros: "Fast",
            cons: "Immediate mode",
            score: 8.4,
        };
        assert!(tk.score > 0.0 && tk.score <= 10.0);
    }
}
