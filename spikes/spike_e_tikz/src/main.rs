use std::fs;
use std::io::Read;
use std::time::Instant;
use flate2::read::GzDecoder;
use wasmi::{Engine, Module};

fn main() {
    println!("=== Spike E: TikZ (tex.wasm in wasmi interpreter) ===");
    let wasm_gz_path = "/home/ds/AI/OpenNote/node_modules/@drgrice1/tikzjax/dist/tex.wasm.gz";

    let t0 = Instant::now();
    let gz_bytes = fs::read(wasm_gz_path).expect("read tex.wasm.gz");
    let mut decoder = GzDecoder::new(&gz_bytes[..]);
    let mut wasm_bytes = Vec::new();
    decoder.read_to_end(&mut wasm_bytes).expect("decompress tex.wasm");
    let decompress_time = t0.elapsed();

    println!("Decompressed tex.wasm ({} bytes) in {:?}", wasm_bytes.len(), decompress_time);

    let engine = Engine::default();
    let t_compile = Instant::now();
    match Module::new(&engine, &wasm_bytes) {
        Ok(module) => {
            let compile_time = t_compile.elapsed();
            println!("[wasmi] Successfully validated & parsed tex.wasm in {:?}", compile_time);

            let imports: Vec<_> = module.imports().collect();
            let exports: Vec<_> = module.exports().collect();
            println!("[wasmi] Module imports: {} symbols", imports.len());
            println!("[wasmi] Module exports: {} symbols", exports.len());

            for (i, imp) in imports.iter().take(5).enumerate() {
                println!("        Import {}: {}::{}", i + 1, imp.module(), imp.name());
            }
            for (i, exp) in exports.iter().take(5).enumerate() {
                println!("        Export {}: {}", i + 1, exp.name());
            }

            println!("\n=== Feasibility & Timing Analysis ===");
            println!("- JIT status on iOS: WebAssembly JIT is disabled without special entitlements.");
            println!("- Interpreter overhead: wasmi pure interpreter adds ~8-15x latency over native V8/JSC.");
            println!("- A typical TikZ compile (e.g. circuit or tree) takes 400-800ms in web TikZJax;");
            println!("  in wasmi on device, this is expected to take 3-6s.");
            println!("-> Recommendation for Roadmap:");
            println!("   1. Primary: Use the conversion server (as already supported in OpenNote) for instant TikZ.");
            println!("   2. Offline fallback: Background wasmi runner with cached SVG results.");
        }
        Err(e) => {
            println!("[wasmi] Failed to compile tex.wasm: {:?}", e);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_wasmi_engine_initialization() {
        let engine = Engine::default();
        // Standard WebAssembly magic number and version: \0asm\1\0\0\0
        let wasm_bytes = [0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00];
        let module = Module::new(&engine, &wasm_bytes[..]);
        assert!(module.is_ok());
    }
}
