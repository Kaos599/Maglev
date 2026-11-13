//! Maglev Core: the native BitTorrent engine behind the Android app.
//!
//! The engine wraps librqbit 9.x. Everything the app sees goes through the JSON
//! contract in `docs/NATIVE_CONTRACT.md`.
//!
//! Pure, JVM-free and session-free modules (unit tested on any host):
//! `activity`, `config`, `error`, `file_health`, `http_dl` (all but its driver), `source`, `scheduler`, `meta`, `priority`, `readiness`, `relocate`, `storage_guard`, `torrent_limits`, `trackers`, `simd`, and the parsing half of `streaming`.

pub mod activity;
pub mod config;
pub mod engine;
pub mod error;
pub mod file_health;
pub mod http_dl;
pub mod meta;
pub mod priority;
pub mod readiness;
pub mod relocate;
pub mod scheduler;
pub mod simd;
pub mod source;
pub mod storage_guard;
pub mod streaming;
pub mod torrent_limits;
pub mod trackers;
pub mod types;

#[cfg(feature = "jni-bridge")]
pub mod jni;

pub use config::NativeConfig;
pub use engine::MaglevEngine;
pub use error::{EngineError, ErrorCode};
