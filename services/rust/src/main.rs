//! Pawa "rust" service stub.
//!
//! Role in the polyglot stack: CPU-bound, perf-critical, memory-safe compute —
//! fare/seat-map math, route optimization across many listings, geo distance
//! over big sets — and **Rust->WASM** for heavy in-browser math (ship the
//! prebuilt `.wasm` into `js/` so the frontend root stays buildless).
//! See ../../docs/LANGUAGE-ROUTING.md.
//!
//! Dependency-free: standard library only. Run with:  cargo run

use std::io::{Read, Write};
use std::net::TcpListener;

fn main() {
    let port = std::env::var("PORT").unwrap_or_else(|_| "8092".to_string());
    let addr = format!("127.0.0.1:{port}");
    let listener = TcpListener::bind(&addr).expect("failed to bind");
    println!("rust service listening on http://127.0.0.1:{port}/health");

    for stream in listener.incoming() {
        let mut stream = match stream {
            Ok(s) => s,
            Err(_) => continue,
        };
        // Read and discard the request line/headers; this stub doesn't route.
        let mut buf = [0u8; 1024];
        let _ = stream.read(&mut buf);

        let body = r#"{"lang":"rust","status":"ok","role":"CPU-bound / perf-critical / WASM"}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\n\
             Content-Type: application/json\r\n\
             Content-Length: {}\r\n\
             Connection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let _ = stream.write_all(response.as_bytes());
    }
}
