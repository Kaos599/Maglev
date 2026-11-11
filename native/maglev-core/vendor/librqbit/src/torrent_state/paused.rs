use std::{collections::HashSet, sync::Arc};

use crate::{
    chunk_tracker::{ChunkTracker, HaveNeededSelected},
    storage::TorrentStorage,
    type_aliases::FileStorage,
};

use super::{ManagedTorrentShared, TorrentMetadata, streaming::TorrentStreams};

pub struct TorrentStatePaused {
    pub(crate) shared: Arc<ManagedTorrentShared>,
    pub(crate) metadata: Arc<TorrentMetadata>,
    pub(crate) files: FileStorage,
    pub(crate) chunk_tracker: ChunkTracker,
    pub(crate) streams: Arc<TorrentStreams>,
}

/// MAGLEV PATCH (hunk 24): what `TorrentStatePaused::remove_files_data` did.
pub struct RemovedFilesData {
    /// Verified bytes the removed files held.
    pub freed_bytes: u64,
    /// The first error met while deleting files from disk. The chunk tracker was already updated,
    /// so the torrent never claims bytes that are gone even when this is set.
    pub io_error: Option<anyhow::Error>,
}

impl TorrentStatePaused {
    pub(crate) fn update_only_files(&mut self, only_files: &HashSet<usize>) -> anyhow::Result<()> {
        self.chunk_tracker
            .update_only_files(&self.metadata.file_infos, only_files)?;
        Ok(())
    }

    pub(crate) fn hns(&self) -> &HaveNeededSelected {
        self.chunk_tracker.get_hns()
    }

    /// MAGLEV PATCH (hunk 24): drops the data of `remove` (see MAGLEV_PATCH.md).
    ///
    /// Order: chunk tracker first (selection, have bits, per-file bytes, totals), then the files on
    /// disk, then a flush of the persisted bitfield. Each removed file is first cut to length 0 through
    /// its open handle, so the space returns at once even if a descriptor outlives the unlink, and then
    /// unlinked. A file that is already gone is not an error. Subfolders left empty are removed.
    pub(crate) fn remove_files_data(
        &mut self,
        new_only_files: &HashSet<usize>,
        remove: &HashSet<usize>,
    ) -> anyhow::Result<RemovedFilesData> {
        let freed_bytes = self.chunk_tracker.remove_files_data(
            &self.metadata.file_infos,
            new_only_files,
            remove,
        )?;

        let mut io_error: Option<anyhow::Error> = None;
        let mut indices: Vec<usize> = remove.iter().copied().collect();
        indices.sort_unstable();
        for idx in indices {
            let fi = &self.metadata.file_infos[idx];
            if fi.attrs.padding {
                continue;
            }
            if let Err(e) = self.files.ensure_file_length(idx, 0) {
                tracing::debug!(idx, "could not cut the file before removing it: {e:#}");
            }
            if let Err(e) = self.files.remove_file(idx, &fi.relative_filename) {
                let not_found = e
                    .downcast_ref::<std::io::Error>()
                    .map(|io| io.kind() == std::io::ErrorKind::NotFound)
                    .unwrap_or(false);
                if !not_found && io_error.is_none() {
                    io_error = Some(e);
                }
            }
            // Folders the file leaves empty, nearest first. The torrent's own folder is never
            // touched: `ancestors()` ends with the empty path, which is skipped.
            for dir in fi.relative_filename.ancestors().skip(1) {
                if dir.as_os_str().is_empty() {
                    break;
                }
                let full = self.shared.options.output_folder.join(dir);
                let empty = std::fs::read_dir(&full)
                    .map(|mut it| it.next().is_none())
                    .unwrap_or(false);
                if !empty || self.files.remove_directory_if_empty(dir).is_err() {
                    break;
                }
            }
        }

        if let Err(e) = self.chunk_tracker.get_have_pieces_mut().flush(false) {
            if io_error.is_none() {
                io_error = Some(e);
            }
        }
        Ok(RemovedFilesData {
            freed_bytes,
            io_error,
        })
    }
}
