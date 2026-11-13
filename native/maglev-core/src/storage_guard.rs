//! Low-storage reserve math (docs/contracts-0.19/play-and-storage.md section 2). Pure: no session, no I/O.
//!
//! Transfers pause when free space on the download volume drops below the reserve and resume once it is back
//! above the reserve plus a hysteresis margin, so a volume sitting on the line does not flap. Kotlin
//! (`StorageGuard.kt`) ports these functions; both read `scripts/fixtures/storage-reserve-vectors.json`.

/// Smallest reserve, whatever the volume size.
pub const RESERVE_FLOOR_BYTES: u64 = 500 * 1024 * 1024;
/// The reserve is this share of the volume, when that is larger than the floor (1 / 50 = 2%).
pub const RESERVE_DIVISOR: u64 = 50;
/// Largest reserve: 2% of a 256 GB phone is 5 GB, which paused every download on a phone with 4 GB free.
pub const RESERVE_CAP_BYTES: u64 = 1024 * 1024 * 1024;
/// Free space must climb this far above the reserve before paused transfers resume.
pub const HYSTERESIS_BYTES: u64 = 200 * 1024 * 1024;

/// `min(1 GiB, max(500 MiB, 2% of the volume))`. An unknown volume size (0) gives the floor.
pub fn reserve_bytes(total: u64) -> u64 {
    RESERVE_FLOOR_BYTES.max(total / RESERVE_DIVISOR).min(RESERVE_CAP_BYTES)
}

/// Free space is under the reserve: transfers must pause.
pub fn is_low(free: u64, total: u64) -> bool {
    free < reserve_bytes(total)
}

/// Free space is back at reserve plus the hysteresis margin: paused transfers may resume.
pub fn has_recovered(free: u64, total: u64) -> bool {
    free >= reserve_bytes(total).saturating_add(HYSTERESIS_BYTES)
}

/// The next blocked state. Not blocked: block when low. Blocked: stay blocked until recovered.
pub fn next_blocked(blocked: bool, free: u64, total: u64) -> bool {
    if blocked {
        !has_recovered(free, total)
    } else {
        is_low(free, total)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIB: u64 = 1024 * 1024;
    const GIB: u64 = 1024 * MIB;

    #[test]
    fn reserve_is_the_floor_on_small_volumes() {
        assert_eq!(reserve_bytes(0), 500 * MIB);
        assert_eq!(reserve_bytes(16 * GIB), 500 * MIB);
        // 2% of 24 GiB is under 500 MiB, so the floor holds; at 26 GiB the percentage is larger.
        assert_eq!(reserve_bytes(24 * GIB), 500 * MIB);
        assert!(reserve_bytes(26 * GIB) > 500 * MIB);
    }

    #[test]
    fn reserve_is_two_percent_between_floor_and_cap() {
        assert_eq!(reserve_bytes(40 * GIB), 40 * GIB / 50);
    }

    #[test]
    fn reserve_is_capped_at_one_gib_on_big_volumes() {
        assert_eq!(reserve_bytes(64 * GIB), GIB);
        assert_eq!(reserve_bytes(256 * GIB), GIB);
        // A 231 GiB phone with 3.7 GiB free keeps downloading.
        assert!(!is_low(37 * GIB / 10, 231 * GIB));
    }

    #[test]
    fn low_is_strictly_under_the_reserve() {
        assert!(is_low(500 * MIB - 1, 16 * GIB));
        assert!(!is_low(500 * MIB, 16 * GIB));
    }

    #[test]
    fn hysteresis_holds_until_reserve_plus_200_mib() {
        let total = 16 * GIB;
        assert!(next_blocked(false, 500 * MIB - 1, total));
        assert!(!next_blocked(false, 500 * MIB, total));
        assert!(next_blocked(true, 500 * MIB, total));
        assert!(next_blocked(true, 700 * MIB - 1, total));
        assert!(!next_blocked(true, 700 * MIB, total));
    }

    #[test]
    fn shared_vectors_hold() {
        let raw = include_str!("../../../scripts/fixtures/storage-reserve-vectors.json");
        let v: serde_json::Value = serde_json::from_str(raw).expect("fixture parses");
        let list = v.as_array().expect("fixture is an array");
        assert!(list.len() >= 10);
        for (i, e) in list.iter().enumerate() {
            let total = e["total"].as_u64().unwrap();
            let free = e["free"].as_u64().unwrap();
            let blocked = e["blocked"].as_bool().unwrap();
            assert_eq!(reserve_bytes(total), e["reserve"].as_u64().unwrap(), "reserve of vector {i}");
            assert_eq!(next_blocked(blocked, free, total), e["expectBlocked"].as_bool().unwrap(), "vector {i}");
        }
    }
}
