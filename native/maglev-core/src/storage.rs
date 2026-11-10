//! Android storage and POSIX disk I/O mechanics.
//!
//! Provides zero-copy direct file writes with graceful fallback for Android FUSE
//! filesystems where `posix_fallocate` returns `EOPNOTSUPP`.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::Path;

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("I/O error: {0}")]
    Io(#[from] io::Error),
    #[error("Invalid path: {0}")]
    InvalidPath(String),
    #[error("Permission denied: {0}")]
    PermissionDenied(String),
}

/// Disk allocator with Android FUSE compatibility.
pub struct AndroidDiskAllocator;

impl AndroidDiskAllocator {
    /// Pre-allocates disk space for a file.
    ///
    /// Attempts `posix_fallocate` first. If Android's FUSE emulation returns
    /// `EOPNOTSUPP` (Operation not supported) or `ENOSYS`, falls back to
    /// `ftruncate` / sparse sizing.
    pub fn allocate_file(path: &Path, size_bytes: u64) -> Result<File, StorageError> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }

        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .open(path)?;

        #[cfg(unix)]
        {
            use std::os::unix::io::AsRawFd;
            let fd = file.as_raw_fd();

            // Attempt posix_fallocate
            let res = unsafe { libc::posix_fallocate(fd, 0, size_bytes as libc::off_t) };

            if res != 0 {
                // EOPNOTSUPP is 95 on Linux/Android; ENOSYS is 38
                if res == libc::EOPNOTSUPP || res == libc::ENOSYS || res == libc::EINVAL {
                    tracing::debug!(
                        "posix_fallocate returned {} on Android FUSE; falling back to ftruncate",
                        res
                    );
                    file.set_len(size_bytes)?;
                } else {
                    return Err(StorageError::Io(io::Error::from_raw_os_error(res)));
                }
            }
        }

        #[cfg(not(unix))]
        {
            file.set_len(size_bytes)?;
        }

        Ok(file)
    }

    /// Verifies that a target directory is writable via direct POSIX access.
    pub fn verify_writable_directory(dir: &Path) -> Result<(), StorageError> {
        fs::create_dir_all(dir)?;
        let probe_file = dir.join(".maglev_probe_write");
        let mut f = File::create(&probe_file)?;
        f.write_all(b"probe")?;
        f.sync_all()?;
        drop(f);
        let _ = fs::remove_file(probe_file);
        Ok(())
    }
}
