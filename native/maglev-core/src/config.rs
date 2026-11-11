//! `NativeConfig` from `docs/NATIVE_CONTRACT.md` section 3.

use serde::{Deserialize, Deserializer, Serialize};

use crate::error::{EngineError, ErrorCode};
use crate::scheduler::SchedulerConfig;

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
}
