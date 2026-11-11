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

## Remove a file's data (hunk 13, Wave 5, contract section 14)

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

13. Four additions, all named `remove_files_data`:
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

To rebase on a new librqbit version: re-apply these thirteen hunks (`grep -rn "MAGLEV PATCH" src`).
