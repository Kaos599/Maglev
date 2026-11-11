# Maglev patch to librqbit 9.1.0

Source: the crates.io package `librqbit 9.1.0` (tag v9.1.0 of github.com/ikatson/rqbit).
Wired in by `[patch.crates-io] librqbit = { path = "vendor/librqbit" }` in `native/maglev-core/Cargo.toml`.

Not copied from the package: `webui/` (an npm project, only used by the `webui` feature, which Maglev keeps off)
and `Cargo.lock`. Everything else is byte-identical except the hunks below.

Why: librqbit downloads files in a hardcoded order (sorted by file name, `// TODO: make it configurable`).
Maglev's "Download first" needs to change that order at run time. `ChunkTracker::iter_queued_pieces`
(`src/chunk_tracker.rs:236`) walks `file_priorities` in list order, so replacing that list is enough.

`file_priorities` lives in `TorrentStateLocked`, behind `TorrentStateLive::_locked: RwLock` (`live/mod.rs:131`, `:166`),
so the live list can be replaced under `lock_write`. It is rebuilt every time the torrent goes live
(`TorrentStateLive::new`), so the chosen order is also stored in `ManagedTorrentShared`.

## Hunks (line numbers are in the patched files)

1. `src/torrent_state/mod.rs:198-201` (struct `ManagedTorrentShared`)
   New field `pub(crate) file_priority_order: parking_lot::Mutex<Option<Vec<usize>>>`. `None` keeps the upstream order.
   The `Shared` struct is used because `TorrentStateLive::new` only has `paused.shared`, not the `ManagedTorrent`.
2. `src/session.rs:1379` (the only constructor of `ManagedTorrentShared`, in `add_torrent`)
   Adds `file_priority_order: Default::default()`.
3. `src/torrent_state/mod.rs:261-271` (`impl ManagedTorrent`)
   New public method `set_file_priority_order(&self, order: Vec<usize>)`. It stores the order, then calls
   `self.live()` (which takes `locked.read()`). A concurrent paused-to-live transition holds `locked.write()` while it
   builds the live state, so either the new live state reads the stored order, or `live()` waits and then updates it.
4. `src/torrent_state/live/mod.rs:175-190`
   New private fn `normalize_file_priority_order(order, file_count)`: drops out-of-range and repeated indices, then
   appends the indices that were not listed, in index order. The result always has `file_count` unique entries.
5. `src/torrent_state/live/mod.rs:278-282` (`TorrentStateLive::new`)
   After the upstream default list is built, replaces it with the stored order when one exists.
6. `src/torrent_state/live/mod.rs:717-722` (`impl TorrentStateLive`)
   New `pub(crate) fn set_file_priority_order(&self, order)`: `lock_write`, then replaces `file_priorities`.

Behaviour notes: the order only changes which file's pieces are requested first. It does not weight bandwidth.
Already-requested pieces are not cancelled. Files that are not selected (`only_files`) are skipped by
`iter_queued_pieces` through the `queue_pieces` filter, wherever they sit in the list.

To rebase on a new librqbit version: re-apply these six hunks (`grep -rn "MAGLEV PATCH" src`).
