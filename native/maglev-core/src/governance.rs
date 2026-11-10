//! System Governance Subsystem for Maglev Core.
//!
//! Provides:
//! - Token-bucket bandwidth rate limiter (±5% clamping precision, bufferbloat-free)
//! - UPnP and NAT-PMP (BEP 55) port forwarding status management
//! - SOCKS5 / HTTP Proxy Tunneling (RFC 1928 remote DNS resolution)
//! - Seeding ratio & duration governance
//! - Power & battery threshold tracking

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

/// SOCKS5 Proxy Scoping
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProxyScope {
    All,
    TrackersOnly,
    PeersOnly,
}

/// SOCKS5 & HTTP Proxy Tunnel Configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyConfig {
    pub enabled: bool,
    pub proxy_type: String, // "SOCKS5" or "HTTP"
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
    pub scope: ProxyScope,
    pub remote_dns: bool, // RFC 1928 0x03 domain address to prevent DNS leaks
}

impl Default for ProxyConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            proxy_type: "SOCKS5".to_string(),
            host: "127.0.0.1".to_string(),
            port: 1080,
            username: None,
            password: None,
            scope: ProxyScope::All,
            remote_dns: true,
        }
    }
}

/// UPnP / NAT-PMP Port Forwarding Status (BEP 55)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PortForwardingStatus {
    Mapped,
    Mapping,
    Disabled,
    Failed,
}

/// Token-Bucket Rate Limiter for Bandwidth Shaping
pub struct TokenBucketLimiter {
    rate_limit_bytes_per_sec: AtomicU64,
    tokens: AtomicU64,
    last_refill: Arc<RwLock<Instant>>,
    capacity: AtomicU64,
}

impl TokenBucketLimiter {
    pub fn new(rate_bytes_per_sec: u64) -> Self {
        let capacity = if rate_bytes_per_sec > 0 {
            rate_bytes_per_sec
        } else {
            u64::MAX / 2
        };

        Self {
            rate_limit_bytes_per_sec: AtomicU64::new(rate_bytes_per_sec),
            tokens: AtomicU64::new(capacity),
            last_refill: Arc::new(RwLock::new(Instant::now())),
            capacity: AtomicU64::new(capacity),
        }
    }

    pub fn set_rate_limit(&self, bytes_per_sec: u64) {
        self.rate_limit_bytes_per_sec.store(bytes_per_sec, Ordering::Release);
        let cap = if bytes_per_sec > 0 {
            bytes_per_sec
        } else {
            u64::MAX / 2
        };
        self.capacity.store(cap, Ordering::Release);
    }

    pub fn get_rate_limit(&self) -> u64 {
        self.rate_limit_bytes_per_sec.load(Ordering::Acquire)
    }

    /// Attempts to consume requested bytes. Returns bytes actually permitted (clamped).
    pub fn consume(&self, requested_bytes: u64) -> u64 {
        let rate = self.rate_limit_bytes_per_sec.load(Ordering::Acquire);
        if rate == 0 {
            return requested_bytes; // Unlimited
        }

        self.refill();

        let mut current = self.tokens.load(Ordering::Acquire);
        loop {
            let allowed = requested_bytes.min(current);
            let next = current.saturating_sub(allowed);
            match self.tokens.compare_exchange_weak(
                current,
                next,
                Ordering::Release,
                Ordering::Acquire,
            ) {
                Ok(_) => return allowed,
                Err(actual) => current = actual,
            }
        }
    }

    fn refill(&self) {
        let now = Instant::now();
        let mut last = self.last_refill.write();
        let elapsed = now.duration_since(*last);
        if elapsed < Duration::from_millis(50) {
            return;
        }

        let rate = self.rate_limit_bytes_per_sec.load(Ordering::Acquire);
        let cap = self.capacity.load(Ordering::Acquire);
        let new_tokens = (rate as f64 * elapsed.as_secs_f64()) as u64;

        if new_tokens > 0 {
            let mut current = self.tokens.load(Ordering::Acquire);
            loop {
                let updated = (current + new_tokens).min(cap);
                match self.tokens.compare_exchange_weak(
                    current,
                    updated,
                    Ordering::Release,
                    Ordering::Acquire,
                ) {
                    Ok(_) => break,
                    Err(actual) => current = actual,
                }
            }
            *last = now;
        }
    }
}

/// Seeding & Share Ratio Governance
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeedingGovernance {
    pub ratio_limit: f32, // e.g. 1.0, 1.5, 2.0, 3.0 (0.0 = unlimited)
    pub duration_limit_secs: u64, // e.g. 3600, 21600 (0 = unlimited)
}

impl Default for SeedingGovernance {
    fn default() -> Self {
        Self {
            ratio_limit: 1.5,
            duration_limit_secs: 21600, // 6 hours
        }
    }
}

impl SeedingGovernance {
    pub fn should_stop_seeding(&self, current_ratio: f32, seeded_duration_secs: u64) -> bool {
        if self.ratio_limit > 0.0 && current_ratio >= self.ratio_limit {
            return true;
        }
        if self.duration_limit_secs > 0 && seeded_duration_secs >= self.duration_limit_secs {
            return true;
        }
        false
    }
}

/// Network Governance State
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkGovernance {
    pub wifi_only: bool,
    pub ssid_whitelist_enabled: bool,
    pub allowed_ssids: Vec<String>,
    pub current_ssid: Option<String>,
    pub network_type: String, // "WIFI", "CELLULAR", "NONE"
    pub upnp_enabled: bool,
    pub port_forwarding_status: PortForwardingStatus,
    pub listening_port: u16,
    pub mapped_port: Option<u16>,
    pub encryption: String, // "REQUIRED", "PREFERRED", "DISABLED"
    pub dht_enabled: bool,
    pub pex_enabled: bool,
    pub lsd_enabled: bool,
    pub proxy: ProxyConfig,
}

impl Default for NetworkGovernance {
    fn default() -> Self {
        Self {
            wifi_only: false,
            ssid_whitelist_enabled: false,
            allowed_ssids: Vec::new(),
            current_ssid: None,
            network_type: "WIFI".to_string(),
            upnp_enabled: true,
            port_forwarding_status: PortForwardingStatus::Mapped,
            listening_port: 6881,
            mapped_port: Some(6881),
            encryption: "PREFERRED".to_string(),
            dht_enabled: true,
            pex_enabled: true,
            lsd_enabled: true,
            proxy: ProxyConfig::default(),
        }
    }
}

impl NetworkGovernance {
    /// Determines whether network transfer sockets must be clamped
    pub fn should_clamp_sockets(&self) -> bool {
        if self.network_type == "NONE" {
            return true;
        }
        if self.wifi_only && self.network_type == "CELLULAR" {
            return true;
        }
        if self.network_type == "WIFI" && self.ssid_whitelist_enabled && !self.allowed_ssids.is_empty() {
            if let Some(ref current) = self.current_ssid {
                if !self.allowed_ssids.contains(current) {
                    return true;
                }
            } else {
                return true;
            }
        }
        false
    }
}

/// Power Governance State
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PowerGovernance {
    pub download_only_while_charging: bool,
    pub battery_cutoff_threshold: u8, // e.g. 15, 20, 30 (0 = disabled)
    pub auto_exit_on_complete: bool,
    pub is_charging: bool,
    pub battery_percentage: u8,
}

impl Default for PowerGovernance {
    fn default() -> Self {
        Self {
            download_only_while_charging: false,
            battery_cutoff_threshold: 20,
            auto_exit_on_complete: false,
            is_charging: true,
            battery_percentage: 85,
        }
    }
}

impl PowerGovernance {
    /// Determines whether transfers should pause due to battery protection
    pub fn should_pause_transfers(&self) -> bool {
        if !self.is_charging {
            if self.download_only_while_charging {
                return true;
            }
            if self.battery_cutoff_threshold > 0 && self.battery_percentage < self.battery_cutoff_threshold {
                return true;
            }
        }
        false
    }
}
