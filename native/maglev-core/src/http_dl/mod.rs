//! Downloads from any http(s) link (`docs/NATIVE_CONTRACT.md` section 17, state machine SM-30).
//!
//! - `machine`: the pure transition table, `step(state, event) -> (state, effects)`.
//! - `rules`: pure decisions (probe answer, resume answer, backoff, pacing).
//! - `content_disposition`: file names (RFC 6266) and sanitising.
//! - `sidecar`: the resume record beside the `.part` file.
//! - `stream`: HLS and DASH downloads (contract section 24.8): playlist parsers, plan, segment fetching.
//! - `driver`: reqwest, files, the persisted list and the governance pass.

pub mod content_disposition;
pub mod driver;
pub mod machine;
pub mod rules;
pub mod sidecar;
pub mod stream;

pub use driver::{AddedDownload, Downloads, ProbeResult};
