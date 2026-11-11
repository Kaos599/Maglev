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

## Remove a file's data (hunk 24, contract section 14)

Why: librqbit can deselect a file (`update_only_files`) but never forgets pieces it already has, and never deletes
a single file of a running torrent. Maglev's "Remove" needs both, and the have bits must go too or a restart (fast
resume) would claim bytes that are gone.

Grounding (upstream code, unchanged): `ChunkTracker` keeps `have` (a `BoxBitV`, disk-backed through the session's bitfield
factory), `queue_pieces`, `chunk_status`, `selected`, `per_file_bytes` and `hns` (`chunk_tracker.rs:15-45`).
Nothing upstream clears a have bit; the only writers are `mark_piece_downloaded` (`:272`) and `ChunkTracker::new`.
`update_only_files` (`:328`) re-derives `selected`, requeues and recomputes `hns`. `per_file_bytes` is rebuilt by
`recalculate_per_file_bytes` (`:187`). The persisted bitfield is flushed by `BitV::flush` (`bitv.rs:141`, `DiskBackedBitV`);
fast resume (`initializing.rs:86-187`) validates one claimed piece per file by hash and clears the whole bitfield if any
fails, so stale have bits would also force a full recheck. `FilesystemStorage` opens every file at `init`
(`storage/filesystem/fs.rs:125-180`), `remove_file` is a plain `std::fs::remove_file` (`:90`), `ensure_file_length` is `set_len` on the open handle (`:94`), and a failed chunk write is
fatal to the torrent (`live/mod.rs:1924-1933`). That last point is why the work is done on a *paused* torrent:
a live one has in-flight pieces and open writers, and closing a handle under them would put the torrent in ERROR.

24. Four additions, all named `remove_files_data`:
    - `src/chunk_tracker.rs:385` `ChunkTracker::remove_files_data(file_infos, new_only_files, removed) -> Result<u64>`:
      runs `update_only_files`, then for every piece in `piece_range` of a removed file clears the have bit and the piece's
      chunk bits and sets its queue bit to `selected[piece]`; recomputes `per_file_bytes` and `hns`. Returns the verified
      bytes the removed files held. Test: `chunk_tracker::tests::test_remove_files_data_clears_inside_and_boundary_pieces`.
    - `src/torrent_state/paused.rs:45` `TorrentStatePaused::remove_files_data`: tracker first, then per file
      `ensure_file_length(idx, 0)` (returns the blocks even if a descriptor stays open) and `remove_file` (a missing file is
      not an error), then empty parent folders (never the torrent's own folder), then `flush(false)` of the bitfield.
      A disk error is kept and returned after the tracker is already consistent.
    - `src/torrent_state/mod.rs:690` `ManagedTorrent::remove_files_data(&HashSet<usize>) -> Result<u64>`: validates indices
      (in range, not padding), computes the new include set, refuses if it is empty, requires `Paused`, runs the above under
      `locked.write()`, then stores `only_files`.
    - `src/session.rs:1645` `Session::remove_files_data(handle, indices)`: the call above plus
      `try_update_persistence_metadata` (the include set lives in the session JSON, `session_persistence/json.rs:148`).
    A live torrent is paused first and started again by the caller (`engine.rs`), exactly as reannounce does.

Boundary pieces: every piece that overlaps a removed file, wholly inside or shared with a kept file, loses its have bit.
A shared piece cannot be verified without the deleted bytes, so it is downloaded again and rewrites the kept file's bytes
unchanged. The boundary piece's bytes that belong to the removed file are written again too (the piece is one write
stream). The file is unlinked but its descriptor stays open in the storage (`take()` hands descriptors over on pause/unpause),
so those few bytes land in an unlinked inode and vanish when the torrent is dropped or the app restarts. After a restart
`FilesystemStorage::init` creates an empty file at that path again and a boundary download can leave up to one piece of
that file's bytes there; the file is not selected, so nothing else is downloaded into it.

25. Open only included files, and `close_file` (contract section 18.1; also `forget_files_data` for section 18.3 "Download again").
    - `src/storage/filesystem/fs.rs` `FilesystemStorage::init`: a file outside the include set gets `OpenedFile::new_lazy(path)`: no
      `create_dir_all`, no 0-byte file, no handle. The include set comes from the new `ManagedTorrentShared::init_only_files`
      (`src/torrent_state/mod.rs`, a `Mutex<Option<Vec<usize>>>`), because `StorageFactory::create_and_init(shared, metadata)` has no
      room for it. It is set in `Session::add_torrent` (`src/session.rs`, the `ManagedTorrentShared` literal, from the `only_files` that
      call computed) and just before `create_and_init` in the error-to-initializing branch of `ManagedTorrent::start`.
    - `src/storage/filesystem/opened_file.rs`: `OpenedFile::new_lazy`, `close` (drops the `File`, keeps the path), `reopen(create)` and
      `lock_or_open(create)`. A closed file with a path opens by that path; a file with no path (padding, or the old storage after
      `take()`, which `mem::take`s the path away) stays closed and still gives `FsFileIsNone`, so pausing keeps working as before.
    - `src/storage/filesystem/fs.rs` I/O: `pwrite_all` and `pwrite_all_vectored` use `lock_or_open(true)` (create the file and its folders
      on first write); `pread_exact` and `ensure_file_length` use `lock_or_open(false)` (never make an empty file just to read or cut
      it; a missing file is an error, which `initial_check` already reads as "pieces missing"). Windows paths are unchanged.
    - `src/storage/mod.rs`: `TorrentStorage::close_file(&self, file_id) -> Result<()>` with a default that does nothing, forwarded by
      `impl TorrentStorage for Box<U>`. The three middlewares in `storage/middleware` (feature `storage_middleware`, not built by
      Maglev) do not forward it.
    - `src/torrent_state/mod.rs` `ManagedTorrent::close_file(idx)`: closes the handle in the initializing, paused or live storage
      (other states do nothing). The live storage is the same `Box<dyn TorrentStorage>` that `TorrentStatePaused::files` hands over
      on unpause, so a closed handle stays closed across pause and unpause.
    - `src/torrent_state/{mod,paused}.rs` `ManagedTorrent::forget_files_data(&HashSet<usize>) -> Result<u64>` and
      `TorrentStatePaused::forget_files_data`: the hunk-24 chunk tracker call (`ChunkTracker::remove_files_data`) with the files left
      in the selection, so their pieces (boundary pieces too) lose their have bits and are queued again; then `close_file` for each and
      a flush of the persisted bitfield. Nothing is deleted from disk. Requires `Paused`, like `remove_files_data`.
    Why: a file deleted from outside keeps an open handle to the deleted inode, and pre-hunk `init` made a 0-byte file for every skipped
    file. After this hunk the engine calls `close_file` for every included file it finds gone, so the next write re-creates it.

To rebase on a new librqbit version: re-apply hunks 1-12, 24 and 25 (`grep -rn "MAGLEV PATCH" src`) and hunks 13-23 (web seed
files are whole files; diff them against the PR or its merged form).

## Live tracker list (hunks T1-T4, Wave 6, contract section 15)

How librqbit holds trackers (checked, v9.1.0): `ManagedTorrentShared.trackers: HashSet<url::Url>` (`src/torrent_state/mod.rs:186`) is
filled once in `add_torrent` (`src/session.rs:1358`, from the .torrent announce list, the magnet `tr=` params and
`AddTorrentOptions.trackers`) and is never mutated. It is read each time a peer stream is built:
`Session::make_peer_rx_managed_torrent` (`src/session.rs:1528`, called from `unpause` at `:1635`) passes it to `make_peer_rx`, which hands
the set to `TrackerComms::start` (`:1595`) as a fixed set; each tracker gets its own announce task for the life of that peer stream.
So there is no API to change trackers on a torrent, live or not, and a live torrent keeps announcing to the set it started with.
The new list therefore takes effect when the peer stream is rebuilt, which is what pause + unpause does (the `nativeReannounce` mechanism, contract 10.2).

The hunks keep `trackers` as it is (it stays the list the torrent was added with) and add an override next to it, the same way hunks 1-3 and 7-9 do:

T1. `src/torrent_state/mod.rs:207-209` (struct `ManagedTorrentShared`)
    New field `pub(crate) trackers_override: parking_lot::Mutex<Option<HashSet<url::Url>>>`. `None` keeps `trackers`; `Some(empty)` means no trackers.
T2. `src/session.rs:1381` (the only constructor of `ManagedTorrentShared`, in `add_torrent`)
    Adds `trackers_override: Default::default()`.
T3. `src/torrent_state/mod.rs:294-316` (`impl ManagedTorrent`)
    New public `trackers(&self) -> Vec<String>` (the override if set, else `trackers`; sorted) and `set_trackers(&self, urls: Vec<String>)`
    (parses each with `url::Url::parse`, drops the ones that fail, stores the set). Strings are used so maglev-core needs no `url` dependency.
    `set_trackers` does not touch a live torrent: it only changes what the next peer stream is built from.
T4. `src/session.rs:1534-1541` (`make_peer_rx_managed_torrent`)
    Reads the override when there is one, otherwise `trackers`, before calling `make_peer_rx`.

Not patched: `session_persistence/json.rs:139` still writes the original set, so after a restart librqbit brings back the original list. Maglev keeps
its own edits in `<sessionDir>/maglev-trackers.json` (`native/maglev-core/src/trackers.rs`) and applies them again after every restore, recheck and move
(`engine.rs` `apply_saved_trackers`). The session-wide `SessionOptions.trackers` still apply on top (`make_peer_rx`, `src/session.rs:1588`).
A private torrent uses only one tracker, picked from the set (`src/session.rs:1581-1586`), so Maglev refuses to edit the list of a private torrent.

To rebase on a new librqbit version: re-apply the twelve hunks above and T1-T4 (`grep -rn "MAGLEV PATCH" src`).
