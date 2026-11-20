//! `NativeConfig` from `docs/NATIVE_CONTRACT.md` section 3.

use serde::{Deserialize, Deserializer, Serialize};

use crate::error::{EngineError, ErrorCode};
use crate::scheduler::{SchedulerConfig, DEFAULT_PEER_TIMEOUT_SECS};

/// Accepts `5`, `5.0` and `null` for an unsigned field. Negative or non-finite values become 0.
fn lenient_u64<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
    let v = serde_json::Value::deserialize(d)?;
    match v {
        serde_json::Value::Null => Ok(0),
        serde_json::Value::Number(n) => Ok(n.as_u64().unwrap_or_else(|| match n.as_f64() {
            Some(f) if f.is_finite() && f > 0.0 => f as u64,
            _ => 0,
        })),
        _ => Err(serde::de::Error::custom("expected a number")),
    }
}

fn lenient_u32<'de, D: Deserializer<'de>>(d: D) -> Result<u32, D::Error> {
    lenient_u64(d).map(|v| v.min(u32::MAX as u64) as u32)
}

fn lenient_u16<'de, D: Deserializer<'de>>(d: D) -> Result<u16, D::Error> {
    lenient_u64(d).map(|v| if v > u16::MAX as u64 { 0 } else { v as u16 })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Encryption {
    #[default]
    Prefer,
    Require,
    Disable,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct NativeConfig {
    /// 0 = random port.
    #[serde(deserialize_with = "lenient_u16")]
    pub listen_port: u16,
    pub enable_upnp: bool,
    pub enable_dht: bool,
    /// Applied: librqbit's local service discovery is switched off when false (needs a restart).
    pub enable_lsd: bool,
    /// Stored only. librqbit has no switch for peer exchange.
    pub enable_pex: bool,
    /// Stored only. librqbit 9.1 has no protocol encryption (MSE).
    pub encryption: Encryption,
    /// 0 = no limit.
    #[serde(deserialize_with = "lenient_u32")]
    pub max_active_downloads: u32,
    /// 0 = no limit.
    #[serde(deserialize_with = "lenient_u32")]
    pub max_active_seeds: u32,
    /// 0 = librqbit default (no cap).
    #[serde(deserialize_with = "lenient_u32")]
    pub max_connections_per_torrent: u32,
    /// 0 = unlimited.
    #[serde(deserialize_with = "lenient_u64")]
    pub download_limit_bps: u64,
    /// 0 = unlimited.
    #[serde(deserialize_with = "lenient_u64")]
    pub upload_limit_bps: u64,
    /// 0 = none.
    pub seed_ratio_limit: f64,
    /// 0 = none.
    #[serde(deserialize_with = "lenient_u32")]
    pub seed_time_limit_mins: u32,
    /// "Stop waiting for peers after" (contract section 20.1), seconds. 0 = never.
    #[serde(deserialize_with = "lenient_u32")]
    pub peer_timeout_secs: u32,
    /// `socks5://user:pass@host:port`, or null.
    pub proxy_url: Option<String>,
    /// Absolute path to a PeerGuardian style text list (`name:1.2.3.4-1.2.3.255`), plain or gzip.
    pub ip_filter_path: Option<String>,
}

impl Default for NativeConfig {
    fn default() -> Self {
        Self {
            listen_port: 0,
            enable_upnp: true,
            enable_dht: true,
            enable_lsd: true,
            enable_pex: true,
            encryption: Encryption::Prefer,
            max_active_downloads: 3,
            max_active_seeds: 3,
            max_connections_per_torrent: 50,
            download_limit_bps: 0,
            upload_limit_bps: 0,
            seed_ratio_limit: 0.0,
            seed_time_limit_mins: 0,
            peer_timeout_secs: DEFAULT_PEER_TIMEOUT_SECS,
            proxy_url: None,
            ip_filter_path: None,
        }
    }
}

impl NativeConfig {
    /// Parses a config JSON. Missing fields take their defaults.
    pub fn from_json(json: &str) -> Result<Self, EngineError> {
        let mut cfg: NativeConfig = serde_json::from_str(json).map_err(|_| {
            EngineError::new(ErrorCode::Internal, "The settings couldn't be read")
        })?;
        cfg.sanitize();
        cfg.validate()?;
        Ok(cfg)
    }

    /// Clamps values into sane ranges. Never fails.
    pub fn sanitize(&mut self) {
        if !self.seed_ratio_limit.is_finite() || self.seed_ratio_limit < 0.0 {
            self.seed_ratio_limit = 0.0;
        }
        self.proxy_url = self.proxy_url.take().filter(|s| !s.trim().is_empty());
        self.ip_filter_path = self.ip_filter_path.take().filter(|s| !s.trim().is_empty());
    }

    pub fn validate(&self) -> Result<(), EngineError> {
        if let Some(p) = &self.proxy_url {
            let lower = p.to_ascii_lowercase();
            let ok = (lower.starts_with("socks5://") || lower.starts_with("socks5h://"))
                && lower.rsplit('@').next().is_some_and(|hostport| {
                    let hp = hostport
                        .trim_start_matches("socks5h://")
                        .trim_start_matches("socks5://");
                    match hp.rsplit_once(':') {
                        Some((host, port)) => !host.is_empty() && port.parse::<u16>().is_ok(),
                        None => false,
                    }
                });
            if !ok {
                return Err(EngineError::new(
                    ErrorCode::Internal,
                    "That proxy address isn't valid. Use socks5://host:port",
                ));
            }
        }
        Ok(())
    }

    pub fn scheduler(&self) -> SchedulerConfig {
        SchedulerConfig {
            max_active_downloads: self.max_active_downloads,
            max_active_seeds: self.max_active_seeds,
            seed_ratio_limit: self.seed_ratio_limit,
            seed_time_limit_mins: self.seed_time_limit_mins,
        }
    }

    /// True when `new` differs from `self` in a field that librqbit only reads when the session is built.
    pub fn restart_required(&self, new: &NativeConfig) -> bool {
        self.listen_port != new.listen_port
            || self.enable_upnp != new.enable_upnp
            || self.enable_dht != new.enable_dht
            || self.enable_lsd != new.enable_lsd
            || self.proxy_url != new.proxy_url
            || self.ip_filter_path != new.ip_filter_path
            || self.max_connections_per_torrent != new.max_connections_per_torrent
    }
}

/// Contract section 41 (B3): what the IP blocklist setting is doing right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BlocklistState {
    /// No file chosen, or the setting is off.
    Off,
    /// A file with at least one rule is loaded.
    On,
    /// The setting is on but the file is missing, empty or holds no rule we can read.
    Unreadable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct BlocklistStatus {
    pub state: BlocklistState,
    pub rules: usize,
}

/// `file_usable` is false when the file is missing, not a file, or shorter than 2 bytes. `rules` is the number of
/// rules read from it (`None` when it cannot be counted yet, for example a gzip file that no session has loaded).
/// A readable file with zero rules is `Unreadable`: it is what a parse failure looks like. `None` is only passed for
/// a file no session loaded and this crate cannot decode (gzip chosen after start, restart pending): `On` with 0 rules,
/// shown as "will apply on restart". A path the running session loaded always passes `Some(its count)`, never `None`.
pub fn blocklist_status(has_path: bool, file_usable: bool, rules: Option<usize>) -> BlocklistStatus {
    if !has_path {
        return BlocklistStatus { state: BlocklistState::Off, rules: 0 };
    }
    if !file_usable {
        return BlocklistStatus { state: BlocklistState::Unreadable, rules: 0 };
    }
    match rules {
        Some(0) => BlocklistStatus { state: BlocklistState::Unreadable, rules: 0 },
        Some(n) => BlocklistStatus { state: BlocklistState::On, rules: n },
        None => BlocklistStatus { state: BlocklistState::On, rules: 0 },
    }
}

/// True for a line librqbit's blocklist reader accepts (`name:start-end`, v4 or v6, both ends the same family).
/// Mirrors `vendor/librqbit/src/ip_ranges.rs` `parse_ip_range`, which is not exported.
fn is_blocklist_rule(line: &str) -> bool {
    use std::net::IpAddr;
    use std::str::FromStr;
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return false;
    }
    let is_ipv6 = line.matches(':').count() > 2;
    let split = if is_ipv6 { line.split_once(':') } else { line.rsplit_once(':') };
    let ips = match split {
        Some((_, ips)) => ips,
        None => return false,
    };
    let (start, end) = match ips.split_once('-') {
        Some(p) => p,
        None => return false,
    };
    matches!(
        (IpAddr::from_str(start), IpAddr::from_str(end)),
        (Ok(IpAddr::V4(_)), Ok(IpAddr::V4(_))) | (Ok(IpAddr::V6(_)), Ok(IpAddr::V6(_)))
    )
}

/// Rules in a plain-text blocklist. `None` for a gzip file (this crate has no decoder; the session that loaded it
/// knows the real count).
pub fn count_plain_rules(bytes: &[u8]) -> Option<usize> {
    if bytes.len() >= 2 && bytes[0] == 0x1F && bytes[1] == 0x8B {
        return None;
    }
    Some(String::from_utf8_lossy(bytes).lines().filter(|l| is_blocklist_rule(l)).count())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_object_gives_defaults() {
        let cfg = NativeConfig::from_json("{}").unwrap();
        assert_eq!(cfg, NativeConfig::default());
        assert_eq!(cfg.max_active_downloads, 3);
        assert_eq!(cfg.max_connections_per_torrent, 50);
        assert!(cfg.enable_dht && cfg.enable_upnp && cfg.enable_lsd && cfg.enable_pex);
        assert_eq!(cfg.encryption, Encryption::Prefer);
    }

    #[test]
    fn peer_timeout_defaults_to_ten_minutes_and_zero_means_never() {
        assert_eq!(NativeConfig::from_json("{}").unwrap().peer_timeout_secs, 600);
        assert_eq!(
            NativeConfig::from_json(r#"{"peer_timeout_secs":0}"#).unwrap().peer_timeout_secs,
            0
        );
        assert_eq!(
            NativeConfig::from_json(r#"{"peer_timeout_secs":3600.0}"#).unwrap().peer_timeout_secs,
            3600
        );
        // A changed timeout needs no restart.
        let a = NativeConfig::default();
        let b = NativeConfig { peer_timeout_secs: 0, ..NativeConfig::default() };
        assert!(!a.restart_required(&b));
    }

    #[test]
    fn missing_fields_fall_back_and_present_fields_win() {
        let cfg = NativeConfig::from_json(
            r#"{"listen_port":51413,"enable_dht":false,"encryption":"require","seed_ratio_limit":1.5,"unknown_future_field":1}"#,
        )
        .unwrap();
        assert_eq!(cfg.listen_port, 51413);
        assert!(!cfg.enable_dht);
        assert!(cfg.enable_upnp);
        assert_eq!(cfg.encryption, Encryption::Require);
        assert_eq!(cfg.seed_ratio_limit, 1.5);
        assert_eq!(cfg.max_active_seeds, 3);
    }

    #[test]
    fn numbers_may_arrive_as_floats() {
        let cfg = NativeConfig::from_json(
            r#"{"listen_port":6881.0,"download_limit_bps":2000000.0,"max_active_downloads":4.0,"upload_limit_bps":null}"#,
        )
        .unwrap();
        assert_eq!(cfg.listen_port, 6881);
        assert_eq!(cfg.download_limit_bps, 2_000_000);
        assert_eq!(cfg.max_active_downloads, 4);
        assert_eq!(cfg.upload_limit_bps, 0);
    }

    #[test]
    fn round_trip_is_lossless() {
        let mut cfg = NativeConfig::default();
        cfg.listen_port = 6881;
        cfg.download_limit_bps = 2_000_000;
        cfg.proxy_url = Some("socks5://u:p@127.0.0.1:9050".into());
        cfg.ip_filter_path = Some("/data/filter.txt".into());
        let json = serde_json::to_string(&cfg).unwrap();
        assert_eq!(NativeConfig::from_json(&json).unwrap(), cfg);
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["encryption"], "prefer");
        assert!(v["proxy_url"].is_string());
        assert!(NativeConfig::default().proxy_url.is_none());
    }

    #[test]
    fn bad_values_are_rejected_or_clamped() {
        assert!(NativeConfig::from_json("not json").is_err());
        assert!(NativeConfig::from_json(r#"{"encryption":"sometimes"}"#).is_err());
        assert!(NativeConfig::from_json(r#"{"proxy_url":"http://x:1"}"#).is_err());
        assert!(NativeConfig::from_json(r#"{"proxy_url":"socks5://host"}"#).is_err());
        let cfg = NativeConfig::from_json(r#"{"seed_ratio_limit":-3,"proxy_url":"  "}"#).unwrap();
        assert_eq!(cfg.seed_ratio_limit, 0.0);
        assert!(cfg.proxy_url.is_none());
    }

    #[test]
    fn restart_required_only_for_session_level_fields() {
        let base = NativeConfig::default();
        let mut c = base.clone();
        c.max_active_downloads = 9;
        c.download_limit_bps = 10;
        c.seed_ratio_limit = 2.0;
        c.encryption = Encryption::Disable;
        assert!(!base.restart_required(&c));
        let changes: [fn(&mut NativeConfig); 4] = [
            |c| c.listen_port = 1234,
            |c| c.enable_dht = false,
            |c| c.enable_upnp = false,
            |c| c.proxy_url = Some("socks5://h:1".into()),
        ];
        for change in changes {
            let mut c = base.clone();
            change(&mut c);
            assert!(base.restart_required(&c));
        }
    }

    #[test]
    fn restart_pending_compares_the_running_session_with_the_saved_config() {
        // `restart_pending` is `session.restart_required(&saved)`: false when nothing changed, true once a
        // session-level field differs, false again when the change is reverted.
        let session = NativeConfig::default();
        let mut saved = session.clone();
        assert!(!session.restart_required(&saved));
        saved.enable_lsd = false;
        assert!(session.restart_required(&saved));
        saved.enable_lsd = true;
        saved.ip_filter_path = Some("/data/list.txt".into());
        assert!(session.restart_required(&saved));
        saved.ip_filter_path = None;
        saved.max_active_downloads = 8;
        assert!(!session.restart_required(&saved));
    }

    #[test]
    fn blocklist_status_off_on_unreadable() {
        assert_eq!(blocklist_status(false, true, Some(5)), BlocklistStatus { state: BlocklistState::Off, rules: 0 });
        assert_eq!(blocklist_status(true, true, Some(12)), BlocklistStatus { state: BlocklistState::On, rules: 12 });
        // Missing or empty file.
        assert_eq!(blocklist_status(true, false, None).state, BlocklistState::Unreadable);
        // Readable file, nothing parses: unreadable, never "on".
        assert_eq!(blocklist_status(true, true, Some(0)).state, BlocklistState::Unreadable);
        // Not counted yet (gzip chosen after start, restart pending): on with an unknown (0) count.
        // A session-loaded path never reaches here with None: a corrupt gzip it parsed to 0 rules is Some(0).
        assert_eq!(blocklist_status(true, true, Some(0)), BlocklistStatus { state: BlocklistState::Unreadable, rules: 0 });
        assert_eq!(blocklist_status(true, true, None), BlocklistStatus { state: BlocklistState::On, rules: 0 });
        let json = serde_json::to_value(blocklist_status(true, true, Some(3))).unwrap();
        assert_eq!(json["state"], "on");
        assert_eq!(json["rules"], 3);
        assert_eq!(serde_json::to_value(blocklist_status(true, false, None)).unwrap()["state"], "unreadable");
    }

    #[test]
    fn plain_rule_counting_matches_the_session_reader() {
        let text = b"# comment\n\nlocal:192.168.1.1-192.168.1.255\nlocalv6:2001:db8::1-2001:db8::ffff\nmixed:1.2.3.4-2001:db8::1\nno range here\nname with: colon:10.0.0.1-10.0.0.9\n";
        assert_eq!(count_plain_rules(text), Some(3));
        // Parse failure: a wrong-format or binary file counts zero rules.
        assert_eq!(count_plain_rules(b"<html>not a list</html>\n"), Some(0));
        assert_eq!(count_plain_rules(&[0u8, 1, 2, 3, 255]), Some(0));
        assert_eq!(count_plain_rules(b""), Some(0));
        // Gzip is not counted here.
        assert_eq!(count_plain_rules(&[0x1F, 0x8B, 8, 0]), None);
    }
}
