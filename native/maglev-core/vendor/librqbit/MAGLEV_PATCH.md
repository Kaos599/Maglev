# Maglev patch to librqbit 9.1.0

Source: the crates.io package `librqbit 9.1.0` (tag v9.1.0 of github.com/ikatson/rqbit).
Wired in by `[patch.crates-io] librqbit = { path = "vendor/librqbit" }` in `native/maglev-core/Cargo.toml`.

Not copied from the package: `webui/` (an npm project, only used by the `webui` feature, which Maglev keeps off)
and `Cargo.lock`. Everything else is byte-identical except the hunks below.

Why (hunks 1-6): librqbit downloads files in a hardcoded order (sorted by file name, `// TODO: make it configurable`).
Maglev's "Download first" needs to change that order at run time. `ChunkTracker::iter_queued_pieces`
(`src/chunk_tracker.rs:236`) walks `file_priorities` in list order, so replacing that list is enough.

`file_priorities` lives in `TorrentStateLocked`, behind `TorrentStateLive::_locked: RwLock` (`live/mod.rs:131`, `:166`),
so the live list can be replaced under `lock_write`. It is rebuilt every time the torrent goes live
(`TorrentStateLive::new`), so the chosen order is also stored in `ManagedTorrentShared`.

## Hunks (line numbers are in the patched files)

1. `src/torrent_state/mod.rs:198-201` (struct `ManagedTorrentShared`, first new field)
   New field `pub(crate) file_priority_order: parking_lot::Mutex<Option<Vec<usize>>>`. `None` keeps the upstream order.
   The `Shared` struct is used because `TorrentStateLive::new` only has `paused.shared`, not the `ManagedTorrent`.
2. `src/session.rs:1379` (the only constructor of `ManagedTorrentShared`, in `add_torrent`)
   Adds `file_priority_order: Default::default()`.
3. `src/torrent_state/mod.rs:265-276` (`impl ManagedTorrent`)
   New public method `set_file_priority_order(&self, order: Vec<usize>)`. It stores the order, then calls
   `self.live()` (which takes `locked.read()`). A concurrent paused-to-live transition holds `locked.write()` while it
   builds the live state, so either the new live state reads the stored order, or `live()` waits and then updates it.
4. `src/torrent_state/live/mod.rs:175-190`
   New private fn `normalize_file_priority_order(order, file_count)`: drops out-of-range and repeated indices, then
   appends the indices that were not listed, in index order. The result always has `file_count` unique entries.
5. `src/torrent_state/live/mod.rs:278-282` (`TorrentStateLive::new`)
   After the upstream default list is built, replaces it with the stored order when one exists.
6. `src/torrent_state/live/mod.rs:721-726` (`impl TorrentStateLive`)
   New `pub(crate) fn set_file_priority_order(&self, order)`: `lock_write`, then replaces `file_priorities`.

12. `src/limits.rs:15-26` (new `CHUNK_MAX`, `burst_for`) and `src/limits.rs:36` (`Limit::new_inner`)
    The quota is `Quota::per_second(bps).allow_burst(burst_for(bps))` instead of `Quota::per_second(bps)`.
    `burst_for(bps) = min(bps, max(CHUNK_MAX, bps / 8))`, `CHUNK_MAX` = 16 KiB. Why: `per_second` sets the burst to one
    full second of quota, so a 512 KB/s limit averaged 630 KB/s with peaks near 1 MB/s on device. The burst is now about
    125 ms of traffic. It stays at least one chunk (the largest `until_n_ready` request: `CHUNK_SIZE` = 16 KiB, used at
    `live/mod.rs:1752,1758,483,492`), so governor never returns `InsufficientCapacity`. Applies to session and per-torrent limits
    (same struct). Sources: https://docs.rs/governor/0.10.0/governor/struct.Quota.html (`per_second`, `allow_burst`),
    https://docs.rs/governor/0.10.0/governor/struct.RateLimiter.html (`until_n_ready` fails when n > capacity).
    Test: `torrent_limits::tests::burst_is_strict_but_never_below_one_chunk` in maglev-core (imports `librqbit::limits::burst_for`).

Behaviour notes: the order only changes which file's pieces are requested first. It does not weight bandwidth.
Already-requested pieces are not cancelled. Files that are not selected (`only_files`) are skipped by
`iter_queued_pieces` through the `queue_pieces` filter, wherever they sit in the list.

## Per-torrent speed limits (hunks 7-11, Wave 4, contract section 11.2)

Why: librqbit builds the per-torrent limiter (`TorrentStateLive::ratelimits`) once, from
`AddTorrentOptions.ratelimits` (`ManagedTorrentOptions.ratelimits`, stored immutably in `ManagedTorrentShared.options`),
when the live state is created. Maglev changes it at run time, so the chosen limit is stored in `ManagedTorrentShared`
(same reason as the priority order: `TorrentStateLive::new` only has `paused.shared`) and the live limiter is updated in place.

Checked, no patch needed: the DOWNLOAD path already acquires the per-torrent limiter, then the session limiter
(`src/torrent_state/live/mod.rs:1752` `self.state.ratelimits.prepare_for_download(..)`, then `:1758`
`session.ratelimits.prepare_for_download(..)`), and the upload path does the same (`:479`, `:488`). So no extra call was added.
`Limits::set_download_bps` / `set_upload_bps` (`src/limits.rs`) take `&self` and swap the limiter atomically.

7. `src/torrent_state/mod.rs:203-205` (struct `ManagedTorrentShared`)
   New field `pub(crate) ratelimits_override: parking_lot::Mutex<Option<LimitsConfig>>`. `None` keeps `options.ratelimits`.
   `LimitsConfig` was already imported at `torrent_state/mod.rs:43`.
8. `src/session.rs:1380` (the only constructor of `ManagedTorrentShared`, in `add_torrent`)
   Adds `ratelimits_override: Default::default()`.
9. `src/torrent_state/mod.rs:278-288` (`impl ManagedTorrent`)
   New public method `set_ratelimits(&self, cfg: LimitsConfig)`. It stores `cfg`, then calls `self.live()` and updates the
   live limiter if there is one. Same race argument as hunk 3: a concurrent paused-to-live transition either reads the stored
   value or `live()` waits for it and then updates it.
10. `src/torrent_state/live/mod.rs:290-294` (`TorrentStateLive::new`)
    `Limits::new(..)` now takes the stored override when one exists, otherwise `paused.shared.options.ratelimits` as before.
11. `src/torrent_state/live/mod.rs:728-732` (`impl TorrentStateLive`)
    New `pub(crate) fn set_ratelimits(&self, cfg: crate::limits::LimitsConfig)`: sets the download and upload bps on the live limiter.

Behaviour notes: `None` in `LimitsConfig` means "no per-torrent limit" in that direction. Session limits still apply on top.
The limiter's burst is now `burst_for(bps)` (hunk 12) and librqbit asks for one 16 KiB chunk at a time, so a quota under
16 KiB/s makes the limiter refuse the request and ends the peer task. Maglev raises smaller non-zero values to 16 KiB/s
before calling `set_ratelimits` (`src/torrent_limits.rs`).


## Web seeds, BEP 19 (hunks 13-23, contract section 16)

Source: https://github.com/ikatson/rqbit/pull/739 (open, head 272a3bf, "feat(webseed): download from BEP 19 web seeds"),
applied with `patch -p3` onto the 9.1.0 sources; every hunk below applied without fuzz except the two marked CONFLICT.
`librqbit-core` 9.1.0 is vendored next to this crate (`vendor/librqbit-core`, `[patch.crates-io]`): crates.io package
contents, no LICENSE file in the package (the Apache-2.0 notice from `vendor/librqbit/LICENSE` was copied in), plus the PR's
core hunks (`grep -rn "web_seed\|url_list\|name_utf8\|path_utf8" vendor/librqbit-core/src`).

Taken from the PR:

13. `librqbit-core/src/web_seed.rs` (new): `MAX_WEB_SEEDS` = 64, `is_web_seed_url`, `push_web_seed`, `web_seed_file_url`
    (libtorrent's URL mapping, byte-wise percent encoding), `deserialize_url_list` (string or list, garbage skipped).
14. `librqbit-core/src/lib.rs` (`pub mod web_seed`), `magnet.rs` (`Magnet::web_seeds`, `ws=` parsed and written),
    `torrent_metainfo.rs` (`TorrentMetaV1::url_list`, `TorrentMetaV1Info::name_utf8`, `TorrentMetaV1File::path_utf8`;
    BEP 17 `httpseeds` stays ignored; `url-list` is outside the info dict so the info hash is unchanged).
15. `src/webseed/mod.rs` (new): `WebSeeds` list, `WebSeedState`, `WebSeedStats`, `ManagedTorrent::web_seeds()`,
    `Session::add_web_seed` / `remove_web_seed`, `merge_web_seed_urls`; `src/lib.rs` exports `WebSeedState`, `WebSeedStats`.
16. `src/webseed/worker.rs` (new): one manager task per live torrent, up to 4 workers (one per web seed), runs of up to 8
    pieces / 2 MiB fetched with one HTTP range request per file; padding and empty files are never requested (zeros are fed
    locally); transient errors (timeout, 5xx, 429, 408) back off 2 s doubling to 5 min and honour `Retry-After` (seconds form,
    max 10 min, never shorter than the backoff); 404/403/410/416 mark one file missing; wrong range answers disable the mirror
    for the run; a mirror is disabled after 2 pieces that failed the hash check (and only when the mirror supplied all chunks
    of the piece). Download rate: each filled chunk (at most `CHUNK_SIZE` = 16 KiB, the hunk 12 burst floor) waits on the
    torrent limiter and then the session limiter before it is written.
17. `src/torrent_state/live/web_seed.rs` (new, child of `live`): `web_seed_reserve` (same `acquire_piece` as peers, then
    consecutive queued pieces inside the same file), `web_seed_owns`, `web_seed_release`, `wait_for_web_seed_download_rate`.
18. `src/torrent_state/live/mod.rs`: `mod web_seed;`, `crate::webseed::spawn_web_seeds(&state)` at the end of
    `TorrentStateLive::new`, and `on_received_piece` split: the write/verify tail is now `TorrentStateLive::process_received_chunk`
    (counts `received` bytes, so padding zeros are not counted), which returns `PieceHashFailed` on a failed hash
    (peers still die on it, as before).
19. `src/piece_tracker.rs` (`reserve_queued` + test), `src/chunk_tracker.rs` (`is_piece_queued`).
20. `src/session.rs`: `AddTorrentOptions::{web_seeds, replace_web_seeds, disable_web_seeds}`,
    `SessionOptions::disable_web_seeds`, `Session::disable_web_seeds`, `InternalAddResult::web_seeds` (from the magnet's `ws`
    or the torrent's `url_list`), `reqwest_client` and `try_update_persistence_metadata` made `pub(crate)`.
    CONFLICT with hunks 2/8 (`ManagedTorrentShared` literal): both lines kept, `web_seeds: WebSeeds::new(..)` added after them.
21. `src/torrent_state/mod.rs`: `ManagedTorrentShared::web_seeds`. CONFLICT with hunks 1/7 (same struct tail): new field
    added after `ratelimits_override`.
22. `src/session_persistence/{mod,json}.rs`: web seeds (and the per-torrent disable flag) are saved in the JSON state, so a
    seed removed at run time stays removed after a restart (`replace_web_seeds` is set when the list was stored). This is
    not Postgres persistence; Maglev uses JSON.
23. Struct-literal fixes for the new core fields: `src/create_torrent_file.rs` (`name_utf8`, `path_utf8`, `url_list` only),
    `src/upnp_server_adapter.rs` (test data).

Dropped: Postgres persistence (`session_persistence/postgres.rs`; it is behind the `postgres` feature, which Maglev keeps
off, but that file would need the two new `SerializedTorrent` fields if the feature were ever turned on), the HTTP API
(`api.rs`, `http_api/handlers/*`), the `create_torrent_file.rs` piece-count fix and its tests (create-torrent change), the
`rqbit` CLI, the `tokio/process` dev-dependency, the libtorrent interop tests, and the in-process e2e tests
(`tests/e2e_webseed.rs`, `tests/web_seed_server.rs`; they need upstream test helpers that 9.1.0 does not have, `fake_peer`,
`e2e_have`). The unit tests that live inside the taken files are kept (`web_seed.rs`, `magnet.rs`, `torrent_metainfo.rs`,
`webseed/mod.rs`, `webseed/worker.rs`, `piece_tracker.rs`, `session_persistence/mod.rs`).

Maglev wiring (`native/maglev-core/src/engine.rs`): `Snapshot.web_seeds` = `ManagedTorrent::web_seeds().len()`; the peers list
gets one row per web seed with `client: "Web seed"`, the URL's host as `addr`, and a speed computed from
`WebSeedStats::downloaded_bytes`.

To rebase on a new librqbit version: re-apply these hunks (`grep -rn "MAGLEV PATCH" src` for 1-12 and the markers above; the
web seed files are whole files, diff them against the PR or its merged form).
