use arc_swap::ArcSwapOption;
use governor::DefaultDirectRateLimiter as RateLimiter;
use governor::Quota;
use serde::Deserialize;
use serde::Serialize;
use std::num::NonZeroU32;
use std::sync::Arc;

#[derive(Default, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct LimitsConfig {
    pub upload_bps: Option<NonZeroU32>,
    pub download_bps: Option<NonZeroU32>,
}

/// MAGLEV PATCH: largest single `until_n_ready` request librqbit makes (one BitTorrent chunk,
/// `librqbit_core::constants::CHUNK_SIZE` = 16 KiB). The burst must never be below this or governor
/// returns `InsufficientCapacity`.
pub const CHUNK_MAX: u32 = 16 * 1024;

/// MAGLEV PATCH: token-bucket burst for a limit of `bps` bytes per second.
/// `Quota::per_second(bps)` alone allows a full second of burst, which made a 512 KB/s limit peak near
/// 1 MB/s. The burst is `max(CHUNK_MAX, bps / 8)` (about 125 ms of traffic), clamped to `bps`.
pub fn burst_for(bps: NonZeroU32) -> NonZeroU32 {
    let b = CHUNK_MAX.max(bps.get() / 8).min(bps.get());
    NonZeroU32::new(b).unwrap_or(bps)
}

struct Limit {
    limiter: ArcSwapOption<RateLimiter>,
    current_bps: std::sync::atomic::AtomicU32,
}

impl Limit {
    fn new_inner(bps: Option<NonZeroU32>) -> Option<Arc<RateLimiter>> {
        let bps = bps?;
        Some(Arc::new(RateLimiter::direct(Quota::per_second(bps).allow_burst(burst_for(bps)))))
    }

    fn new(bps: Option<NonZeroU32>) -> Self {
        use std::sync::atomic::AtomicU32;
        Self {
            limiter: ArcSwapOption::new(Self::new_inner(bps)),
            current_bps: AtomicU32::new(bps.map(|v| v.get()).unwrap_or(0)),
        }
    }

    async fn acquire(&self, size: NonZeroU32) -> crate::Result<()> {
        let lim = self.limiter.load().clone();
        if let Some(rl) = lim.as_ref() {
            rl.until_n_ready(size).await?;
        }
        Ok(())
    }

    fn set(&self, limit: Option<NonZeroU32>) {
        use std::sync::atomic::Ordering;
        let new = Self::new_inner(limit);
        self.limiter.swap(new);
        self.current_bps
            .store(limit.map(|v| v.get()).unwrap_or(0), Ordering::Relaxed);
    }

    fn get(&self) -> Option<NonZeroU32> {
        use std::sync::atomic::Ordering;
        NonZeroU32::new(self.current_bps.load(Ordering::Relaxed))
    }
}

pub struct Limits {
    down: Limit,
    up: Limit,
}

impl Limits {
    pub fn new(config: LimitsConfig) -> Self {
        Self {
            down: Limit::new(config.download_bps),
            up: Limit::new(config.upload_bps),
        }
    }

    pub async fn prepare_for_upload(&self, len: NonZeroU32) -> crate::Result<()> {
        self.up.acquire(len).await
    }

    pub async fn prepare_for_download(&self, len: NonZeroU32) -> crate::Result<()> {
        self.down.acquire(len).await
    }

    pub fn set_upload_bps(&self, bps: Option<NonZeroU32>) {
        self.up.set(bps);
    }

    pub fn set_download_bps(&self, bps: Option<NonZeroU32>) {
        self.down.set(bps);
    }

    pub fn get_upload_bps(&self) -> Option<NonZeroU32> {
        self.up.get()
    }

    pub fn get_download_bps(&self) -> Option<NonZeroU32> {
        self.down.get()
    }

    pub fn get_config(&self) -> LimitsConfig {
        LimitsConfig {
            upload_bps: self.get_upload_bps(),
            download_bps: self.get_download_bps(),
        }
    }
}
