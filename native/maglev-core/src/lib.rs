//! Maglev Core Native Library.
//!
//! Provides the embedded BitTorrent engine, JNI dispatcher, direct storage I/O,
//! SIMD piece bitfield downsampling, local loopback HTTP streaming,
//! and Phase 2 system governance (token-bucket limiter, proxy tunneling, IP filter).

pub mod engine;
pub mod governance;
pub mod ip_filter;
pub mod simd;
pub mod storage;
pub mod streaming;

#[cfg(feature = "jni-bridge")]
pub mod jni;

// Re-export common types
pub use engine::{AggregatedTelemetry, MaglevEngine, TorrentTelemetry};
pub use governance::{NetworkGovernance, PowerGovernance, ProxyConfig, TokenBucketLimiter};
pub use ip_filter::IpFilterEngine;
pub use simd::{downsample_bitfield, MATRIX_SIZE};
