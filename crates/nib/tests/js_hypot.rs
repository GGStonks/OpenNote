//! `js_hypot` gives JavaScript's `Math.hypot` bit for bit: the XOR of the result bits over 200,000
//! pairs (small, large, tiny, and equal magnitudes) from a fixed xorshift generator, against the
//! value Node prints for the same pairs (V8; JavaScriptCore computes `Math.hypot` the same way).
//! The script: generate the pairs as below and XOR `Math.hypot(a, b)`'s bits.
use nib::geometry::JsMath;

#[test]
fn js_hypot_is_math_hypot() {
    let mut s: u64 = 0x2545f4914f6cdd1d;
    let mut next = || {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        (s >> 11) as f64 / (1u64 << 53) as f64
    };
    let (mut x, mut libm): (u64, u64) = (0, 0);
    for i in 0..200_000 {
        let k = i % 4;
        let a = (next() - 0.5) * [2.0, 2000.0, 1e-3, 4e4][k];
        let b = if k == 3 { a * if next() < 0.5 { 1.0 } else { -1.0 } } else { (next() - 0.5) * if k == 2 { 1e-3 } else { 2000.0 } };
        x ^= a.js_hypot(b).to_bits();
        libm ^= a.hypot(b).to_bits();
    }
    assert_eq!(format!("{x:x}"), "4f27643d3b7035", "js_hypot differs from Math.hypot");
    // libm's hypot does differ (why js_hypot exists).
    assert_ne!(format!("{libm:x}"), "4f27643d3b7035", "libm's hypot now matches: js_hypot may be unneeded");
    assert_eq!(0.0f64.js_hypot(0.0), 0.0);
    assert!(f64::NAN.js_hypot(1.0).is_nan() && f64::INFINITY.js_hypot(f64::NAN).is_infinite());
}
