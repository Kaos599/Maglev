//! Maglev Core: the native BitTorrent engine behind the Android app.
//!
//! The engine wraps librqbit 9.x. Everything the app sees goes through the JSON
//! contract in `docs/NATIVE_CONTRACT.md`.
//!
//! Pure, JVM-free and session-free modules (unit tested on any host):
//! `config`, `error`, `source`, `scheduler`, `meta`, `simd`, and the parsing half of `streaming`.

pub mod config;
pub mod engine;
pub mod error;
pub mod meta;
pub mod scheduler;
pub mod simd;
pub mod source;
pub mod streaming;
pub mod types;

#[cfg(feature = "jni-bridge")]
pub mod jni;

pub use config::NativeConfig;
pub use engine::MaglevEngine;
pub use error::{EngineError, ErrorCode};
