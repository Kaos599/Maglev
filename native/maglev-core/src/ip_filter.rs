//! IP Filtering / Blocklist Engine for Maglev Core.
//!
//! Parses PeerGuardian and eMule `.dat` formats and performs O(log N)
//! binary search range checks to drop untrusted peer connections during
//! wire handshakes.

use std::net::Ipv4Addr;
use std::str::FromStr;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IpBlockRange {
    pub start_ip: u32,
    pub end_ip: u32,
    pub name: String,
}

pub struct IpFilterEngine {
    ranges: Vec<IpBlockRange>,
    enabled: bool,
}

impl IpFilterEngine {
    pub fn new() -> Self {
        Self {
            ranges: Vec::new(),
            enabled: false,
        }
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    pub fn rules_count(&self) -> usize {
        self.ranges.len()
    }

    /// Parses PeerGuardian or eMule `.dat` text content.
    ///
    /// Accepts:
    /// - `Name:1.2.3.4-1.2.3.255`
    /// - `1.2.3.4 - 1.2.3.255 , 000 , Name`
    pub fn parse_dat(&mut self, content: &str) -> usize {
        let mut parsed = Vec::new();

        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') || line.starts_with("//") {
                continue;
            }

            // Format 1: "Name:1.2.3.4-1.2.3.255"
            if let Some(colon_pos) = line.find(':') {
                if let Some(dash_pos) = line[colon_pos + 1..].find('-') {
                    let name = line[..colon_pos].trim();
                    let start_str = line[colon_pos + 1..colon_pos + 1 + dash_pos].trim();
                    let end_str = line[colon_pos + 1 + dash_pos + 1..].trim();

                    if let (Ok(start), Ok(end)) = (Ipv4Addr::from_str(start_str), Ipv4Addr::from_str(end_str)) {
                        let start_u32 = u32::from(start);
                        let end_u32 = u32::from(end);
                        if start_u32 <= end_u32 {
                            parsed.push(IpBlockRange {
                                start_ip: start_u32,
                                end_ip: end_u32,
                                name: name.to_string(),
                            });
                            continue;
                        }
                    }
                }
            }

            // Format 2: "1.2.3.4 - 1.2.3.255 , 000 , Range Name"
            if line.contains('-') && line.contains(',') {
                let parts: Vec<&str> = line.split(',').collect();
                let range_part = parts[0].trim();
                let name = if parts.len() > 2 {
                    parts[2].trim()
                } else {
                    "Blocked"
                };

                let dash_parts: Vec<&str> = range_part.split('-').collect();
                if dash_parts.len() == 2 {
                    if let (Ok(start), Ok(end)) = (
                        Ipv4Addr::from_str(dash_parts[0].trim()),
                        Ipv4Addr::from_str(dash_parts[1].trim()),
                    ) {
                        let start_u32 = u32::from(start);
                        let end_u32 = u32::from(end);
                        if start_u32 <= end_u32 {
                            parsed.push(IpBlockRange {
                                start_ip: start_u32,
                                end_ip: end_u32,
                                name: name.to_string(),
                            });
                        }
                    }
                }
            }
        }

        // Sort by start_ip for binary search
        parsed.sort_by_key(|r| r.start_ip);
        let count = parsed.len();
        self.ranges = parsed;
        self.enabled = count > 0;
        count
    }

    /// Performs binary search to verify if an IPv4 address falls within a blocked range.
    pub fn is_ip_blocked(&self, ip: Ipv4Addr) -> bool {
        if !self.enabled || self.ranges.is_empty() {
            return false;
        }

        let target = u32::from(ip);
        let mut low = 0;
        let mut high = self.ranges.len();

        while low < high {
            let mid = low + (high - low) / 2;
            let rule = &self.ranges[mid];

            if target >= rule.start_ip && target <= rule.end_ip {
                return true;
            } else if target < rule.start_ip {
                high = mid;
            } else {
                low = mid + 1;
            }
        }

        false
    }
}
