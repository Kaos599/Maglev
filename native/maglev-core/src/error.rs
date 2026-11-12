//! Error codes, the `Result` envelope, and mapping of raw librqbit / OS errors to codes.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

/// The closed set of codes from `docs/NATIVE_CONTRACT.md` section 3, plus `TRACKER`,
/// which only appears inside a torrent snapshot's `error` object.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    InvalidSource,
    Duplicate,
    MetadataTimeout,
    Network,
    NotFound,
    DiskFull,
    Permission,
    FilesMissing,
    Tracker,
    NotInitialized,
    EngineUnavailable,
    Unsupported,
    /// A caller-supplied value is malformed (for example a tracker address). Nothing was changed.
    InvalidArgument,
    /// The torrent has no metadata yet (a magnet that is still resolving).
    NotReady,
    /// The torrent is moving or checking, so the call can't run now.
    InvalidState,
    Internal,
    /// The app cancelled a magnet resolve. Not an error to show.
    Cancelled,
    /// URL downloads (section 17): the server answered with a failing status (`http_status`).
    HttpStatus,
    /// URL downloads: 401 or 403. The link needs a sign in or has expired.
    AuthRequired,
    /// URL downloads: the link has expired (410) and needs a new one.
    LinkExpired,
    /// URL downloads: the file on the server is not the one that was started.
    FileChanged,
    /// URL downloads: the link opens a web page, not a file.
    NotAFile,
    /// URL downloads: the finished file does not match the checksum.
    ChecksumMismatch,
    /// URL downloads: a redirect pointed at a device on the local network, so it was refused.
    LocalRedirect,
    /// URL downloads: the Wi-Fi-only or VPN-only setting blocks the request.
    Blocked,
    /// URL downloads: the server kept the connection open but sent almost nothing, again and again.
    Stalled,
    /// URL downloads: the link's own address points to a device on the local network (the user may allow it).
    LanAddress,
    /// Opening a finished file: no app on the phone can open it. Returned by the Kotlin layer only.
    NoApp,
}

impl ErrorCode {
    pub fn as_str(&self) -> &'static str {
        match self {
            ErrorCode::InvalidSource => "INVALID_SOURCE",
            ErrorCode::Duplicate => "DUPLICATE",
            ErrorCode::MetadataTimeout => "METADATA_TIMEOUT",
            ErrorCode::Network => "NETWORK",
            ErrorCode::NotFound => "NOT_FOUND",
            ErrorCode::DiskFull => "DISK_FULL",
            ErrorCode::Permission => "PERMISSION",
            ErrorCode::FilesMissing => "FILES_MISSING",
            ErrorCode::Tracker => "TRACKER",
            ErrorCode::NotInitialized => "NOT_INITIALIZED",
            ErrorCode::EngineUnavailable => "ENGINE_UNAVAILABLE",
            ErrorCode::Unsupported => "UNSUPPORTED",
            ErrorCode::InvalidArgument => "INVALID_ARGUMENT",
            ErrorCode::NotReady => "NOT_READY",
            ErrorCode::InvalidState => "INVALID_STATE",
            ErrorCode::Internal => "INTERNAL",
            ErrorCode::Cancelled => "CANCELLED",
            ErrorCode::HttpStatus => "HTTP_STATUS",
            ErrorCode::AuthRequired => "AUTH_REQUIRED",
            ErrorCode::LinkExpired => "LINK_EXPIRED",
            ErrorCode::FileChanged => "FILE_CHANGED",
            ErrorCode::NotAFile => "NOT_A_FILE",
            ErrorCode::ChecksumMismatch => "CHECKSUM_MISMATCH",
            ErrorCode::LocalRedirect => "LOCAL_REDIRECT",
            ErrorCode::Blocked => "BLOCKED",
            ErrorCode::Stalled => "STALLED",
            ErrorCode::NoApp => "NO_APP",
            ErrorCode::LanAddress => "LAN_ADDRESS",
        }
    }
}

/// A failure that is turned into `{"ok":false,"code":...,"message":...}`.
#[derive(Debug, Clone, PartialEq)]
pub struct EngineError {
    pub code: ErrorCode,
    pub message: String,
    /// Set for `DUPLICATE`: the id of the torrent that already exists.
    pub id: Option<String>,
    /// Set when a call was refused only because it came too soon (`nativeReannounce`).
    pub retry_after_secs: Option<u64>,
    /// Set for `DUPLICATE`: how many trackers of the new source were added to the existing torrent (section 21).
    pub merged_trackers: Option<usize>,
    /// Set for `HTTP_STATUS`: the status the server answered.
    pub http_status: Option<u16>,
}

impl EngineError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            id: None,
            retry_after_secs: None,
            merged_trackers: None,
            http_status: None,
        }
    }

    /// `HTTP_STATUS` with the status the server answered.
    pub fn http_status(status: u16, message: impl Into<String>) -> Self {
        Self {
            http_status: Some(status),
            ..Self::new(ErrorCode::HttpStatus, message)
        }
    }

    /// `UNSUPPORTED` with a wait time, for calls that are rate limited.
    pub fn retry_later(message: impl Into<String>, secs: u64) -> Self {
        Self {
            retry_after_secs: Some(secs),
            ..Self::new(ErrorCode::Unsupported, message)
        }
    }

    pub fn duplicate(id: impl Into<String>) -> Self {
        Self {
            code: ErrorCode::Duplicate,
            message: "This torrent is already in your list".to_string(),
            id: Some(id.into()),
            retry_after_secs: None,
            merged_trackers: None,
            http_status: None,
        }
    }

    /// Same as `duplicate`, with the count of trackers merged into the existing torrent.
    pub fn duplicate_merged(id: impl Into<String>, merged: usize) -> Self {
        Self {
            merged_trackers: Some(merged),
            ..Self::duplicate(id)
        }
    }

    pub fn not_found() -> Self {
        Self::new(ErrorCode::NotFound, "That torrent isn't in your list")
    }

    pub fn not_initialized() -> Self {
        Self::new(
            ErrorCode::NotInitialized,
            "The download engine isn't running yet",
        )
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message)
    }

    pub fn to_json(&self) -> String {
        let mut m = Map::new();
        m.insert("ok".into(), Value::Bool(false));
        m.insert("code".into(), Value::String(self.code.as_str().into()));
        m.insert("message".into(), Value::String(self.message.clone()));
        if let Some(id) = &self.id {
            m.insert("id".into(), Value::String(id.clone()));
        }
        if let Some(n) = self.merged_trackers {
            m.insert("mergedTrackers".into(), Value::from(n));
        }
        if let Some(secs) = self.retry_after_secs {
            m.insert("retry_after_secs".into(), Value::from(secs));
        }
        if let Some(status) = self.http_status {
            m.insert("http_status".into(), Value::from(status));
        }
        Value::Object(m).to_string()
    }
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for EngineError {}

/// Shown when a Rust panic is caught at the JNI boundary.
pub fn panic_envelope() -> String {
    EngineError::internal("Something went wrong inside the download engine").to_json()
}

/// `{"ok":true}` with the fields of `payload` merged in. A payload that is not a
/// JSON object is stored under `"value"`.
pub fn ok_envelope<T: Serialize>(payload: &T) -> String {
    let mut m = Map::new();
    m.insert("ok".into(), Value::Bool(true));
    match serde_json::to_value(payload) {
        Ok(Value::Object(obj)) => {
            for (k, v) in obj {
                m.insert(k, v);
            }
        }
        Ok(Value::Null) => {}
        Ok(other) => {
            m.insert("value".into(), other);
        }
        Err(_) => {
            return EngineError::internal("Couldn't encode the engine's answer").to_json();
        }
    }
    Value::Object(m).to_string()
}

pub fn ok_empty() -> String {
    json!({ "ok": true }).to_string()
}

pub fn result_envelope<T: Serialize>(r: Result<T, EngineError>) -> String {
    match r {
        Ok(v) => ok_envelope(&v),
        Err(e) => e.to_json(),
    }
}

/// Maps a raw runtime error text (anyhow chain, OS error) to a code and a plain English message.
/// The raw text is only used for matching; it is never shown to the user.
pub fn classify_runtime_error(raw: &str) -> (ErrorCode, String) {
    let t = raw.to_ascii_lowercase();
    if t.contains("no space left")
        || t.contains("os error 28")
        || t.contains("disk quota")
        || t.contains("os error 122")
        || t.contains("storage full")
    {
        return (
            ErrorCode::DiskFull,
            "Storage is full. Free up some space, then resume.".to_string(),
        );
    }
    if t.contains("permission denied")
        || t.contains("operation not permitted")
        || t.contains("os error 13")
        || t.contains("os error 1)")
        || t.contains("read-only file system")
        || t.contains("os error 30")
    {
        return (
            ErrorCode::Permission,
            "Maglev can't write to this download folder. Check the folder permission.".to_string(),
        );
    }
    if t.contains("no such file")
        || t.contains("os error 2)")
        || t.contains("file not found")
        || t.contains("files are missing")
    {
        return (
            ErrorCode::FilesMissing,
            "Some downloaded files are missing. Recheck to download them again.".to_string(),
        );
    }
    if t.contains("tracker") {
        return (
            ErrorCode::Tracker,
            "A tracker isn't responding.".to_string(),
        );
    }
    (
        ErrorCode::Internal,
        "Something went wrong with this torrent.".to_string(),
    )
}

/// Classifies a failure while fetching or decoding torrent info.
pub fn classify_add_error(raw: &str) -> EngineError {
    let t = raw.to_ascii_lowercase();
    if t.contains("error decoding torrent")
        || t.contains("deserializ")
        || t.contains("bencode")
        || t.contains("not a valid magnet")
        || t.contains("infohash")
        || t.contains("unsupported url")
    {
        return EngineError::new(
            ErrorCode::InvalidSource,
            "That doesn't look like a valid torrent",
        );
    }
    let (code, message) = classify_runtime_error(raw);
    if matches!(code, ErrorCode::DiskFull | ErrorCode::Permission) {
        return EngineError::new(code, message);
    }
    const NETWORK_HINTS: [&str; 12] = [
        "error downloading torrent metadata",
        "connect",
        "dns",
        "resolve",
        "timed out",
        "timeout",
        "refused",
        "unreachable",
        "no known way to resolve peers",
        "error sending request",
        "returned 4",
        "returned 5",
    ];
    if NETWORK_HINTS.iter().any(|h| t.contains(h)) {
        return EngineError::new(
            ErrorCode::Network,
            "Couldn't reach the torrent. Check your connection and try again.",
        );
    }
    let first = raw.lines().next().unwrap_or("").trim();
    let detail: String = first.chars().take(200).collect();
    EngineError::internal(format!("Couldn't add this torrent: {detail}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enospc_maps_to_disk_full() {
        let (c, m) = classify_runtime_error("write failed\n\nCaused by:\n    No space left on device (os error 28)");
        assert_eq!(c, ErrorCode::DiskFull);
        assert!(m.contains("Storage is full"));
        assert_eq!(classify_runtime_error("os error 28").0, ErrorCode::DiskFull);
    }

    #[test]
    fn eacces_and_eperm_map_to_permission() {
        assert_eq!(
            classify_runtime_error("Permission denied (os error 13)").0,
            ErrorCode::Permission
        );
        assert_eq!(
            classify_runtime_error("Operation not permitted (os error 1)").0,
            ErrorCode::Permission
        );
    }

    #[test]
    fn missing_file_maps_to_files_missing() {
        assert_eq!(
            classify_runtime_error("No such file or directory (os error 2)").0,
            ErrorCode::FilesMissing
        );
    }

    #[test]
    fn unknown_errors_hide_raw_text() {
        let (c, m) = classify_runtime_error("bug: torrent in broken None state");
        assert_eq!(c, ErrorCode::Internal);
        assert!(!m.contains("bug"));
    }

    #[test]
    fn add_errors_split_between_invalid_and_network() {
        assert_eq!(
            classify_add_error("error decoding torrent").code,
            ErrorCode::InvalidSource
        );
        assert_eq!(
            classify_add_error("error downloading torrent metadata: connection refused").code,
            ErrorCode::Network
        );
    }

    #[test]
    fn unknown_add_errors_are_internal_with_the_underlying_message() {
        let e = classify_add_error("something odd happened in the engine");
        assert_eq!(e.code, ErrorCode::Internal);
        assert!(e.message.contains("something odd"));
        assert_eq!(
            classify_add_error("GET http://x returned 503").code,
            ErrorCode::Network
        );
        assert_eq!(ErrorCode::Unsupported.as_str(), "UNSUPPORTED");
        assert_eq!(ErrorCode::InvalidArgument.as_str(), "INVALID_ARGUMENT");
        assert_eq!(ErrorCode::NotReady.as_str(), "NOT_READY");
        assert_eq!(ErrorCode::InvalidState.as_str(), "INVALID_STATE");
    }

    #[test]
    fn envelopes_have_the_contract_shape() {
        let v: Value = serde_json::from_str(&EngineError::duplicate("abc").to_json()).unwrap();
        assert_eq!(v["ok"], false);
        assert_eq!(v["code"], "DUPLICATE");
        assert!(v.get("mergedTrackers").is_none());
        let m: Value = serde_json::from_str(&EngineError::duplicate_merged("abc", 2).to_json()).unwrap();
        assert_eq!(m["mergedTrackers"], 2);
        assert_eq!(m["id"], "abc");
        assert_eq!(v["id"], "abc");
        let v: Value = serde_json::from_str(&ok_envelope(&json!({"id": "x"}))).unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(v["id"], "x");
        let v: Value = serde_json::from_str(&panic_envelope()).unwrap();
        assert_eq!(v["code"], "INTERNAL");
        assert_eq!(v["ok"], false);
    }

    #[test]
    fn retry_later_carries_the_wait_time() {
        let v: Value = serde_json::from_str(&EngineError::retry_later("Wait", 42).to_json()).unwrap();
        assert_eq!(v["ok"], false);
        assert_eq!(v["code"], "UNSUPPORTED");
        assert_eq!(v["retry_after_secs"], 42);
        let v: Value = serde_json::from_str(&EngineError::not_found().to_json()).unwrap();
        assert!(v.get("retry_after_secs").is_none());
    }

    #[test]
    fn code_serializes_screaming_snake() {
        assert_eq!(
            serde_json::to_string(&ErrorCode::MetadataTimeout).unwrap(),
            "\"METADATA_TIMEOUT\""
        );
        assert_eq!(ErrorCode::MetadataTimeout.as_str(), "METADATA_TIMEOUT");
        assert_eq!(
            serde_json::to_string(&ErrorCode::Cancelled).unwrap(),
            "\"CANCELLED\""
        );
        assert_eq!(ErrorCode::Cancelled.as_str(), "CANCELLED");
    }

    #[test]
    fn link_download_codes_serialize_screaming_snake() {
        assert_eq!(serde_json::to_string(&ErrorCode::Stalled).unwrap(), "\"STALLED\"");
        assert_eq!(ErrorCode::Stalled.as_str(), "STALLED");
        assert_eq!(serde_json::to_string(&ErrorCode::NoApp).unwrap(), "\"NO_APP\"");
        assert_eq!(ErrorCode::NoApp.as_str(), "NO_APP");
        assert_eq!(serde_json::to_string(&ErrorCode::LanAddress).unwrap(), "\"LAN_ADDRESS\"");
    }
}
