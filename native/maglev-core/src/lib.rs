//! Maglev Core Native Library.
//!
//! Provides the embedded BitTorrent engine, JNI dispatcher, direct storage I/O,
//! SIMD piece bitfield downsampling, and local loopback HTTP streaming.

pub mod engine;
pub mod simd;
pub mod storage;
pub mod streaming;

#[cfg(feature = "jni-bridge")]
pub mod jni;

// Re-export common types
pub use engine::{AggregatedTelemetry, MaglevEngine, TorrentTelemetry};
pub use simd::{downsample_bitfield, MATRIX_SIZE};
