//! The library's entry point on the PC, for `npm run bench:ui -- --only rustcore` (a stand-in iOS
//! shell answers the page's `rust` command with it): `opennote_native_cli <method>`, the framed
//! request on stdin, the framed reply on stdout.
use std::io::{Read, Write};

fn main() {
    let method = std::env::args().nth(1).unwrap_or_default();
    let mut request = Vec::new();
    std::io::stdin().read_to_end(&mut request).expect("stdin");
    let reply = opennote_native::call_framed(&method, &request);
    std::io::stdout().write_all(&reply).expect("stdout");
}
