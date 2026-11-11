//! Moving a torrent's files to another folder (contract section 11.3).
//!
//! Path planning, progress math and the file operations live here and are unit tested on any host.
//! The engine glue (pausing, forget + re-add, rollback of the torrent) is in `engine.rs`.

use std::collections::BTreeSet;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use tracing::warn;

use crate::error::{EngineError, ErrorCode};
use crate::types::subfolder_for;

/// Files that cannot be renamed are copied in chunks of this size.
pub const COPY_CHUNK: usize = 1024 * 1024;

/// Bytes handled so far out of the bytes that must move. Shared with the snapshot builder.
#[derive(Debug, Default)]
pub struct MoveProgress {
    done: AtomicU64,
    total: AtomicU64,
}

impl MoveProgress {
    pub fn new(total: u64) -> Self {
        Self {
            done: AtomicU64::new(0),
            total: AtomicU64::new(total),
        }
    }

    pub fn add(&self, n: u64) {
        self.done.fetch_add(n, Ordering::Relaxed);
    }

    pub fn reset_done(&self) {
        self.done.store(0, Ordering::Relaxed);
    }

    pub fn fraction(&self) -> f64 {
        progress_fraction(
            self.done.load(Ordering::Relaxed),
            self.total.load(Ordering::Relaxed),
        )
    }
}

/// 0 to 1 by bytes. With nothing to move the answer is 0 (the move then ends at once).
pub fn progress_fraction(done: u64, total: u64) -> f64 {
    if total == 0 {
        return 0.0;
    }
    (done as f64 / total as f64).clamp(0.0, 1.0)
}

/// Where the torrent's files end up for a chosen folder: a multi-file torrent gets
/// `<dest>/<name>/`, a single file goes straight into `<dest>`. Same rule as adding with a custom folder.
pub fn destination_folder(dest_dir: &Path, name: &str, file_count: usize) -> PathBuf {
    match subfolder_for(name, file_count) {
        Some(sub) => dest_dir.join(sub),
        None => dest_dir.to_path_buf(),
    }
}

/// Checks the chosen folder against the torrent's current one.
/// `own_folder` is true when the current folder belongs to this torrent alone (a multi-file torrent).
/// Errors: `INVALID_SOURCE` for a relative path, `UNSUPPORTED` for the same folder or a move into itself.
pub fn check_destination(
    dest_dir: &Path,
    old_folder: &Path,
    new_folder: &Path,
    own_folder: bool,
) -> Result<(), EngineError> {
    if !dest_dir.is_absolute() {
        return Err(EngineError::new(
            ErrorCode::InvalidSource,
            "Pick a folder to move this torrent to",
        ));
    }
    if new_folder == old_folder {
        return Err(EngineError::new(
            ErrorCode::Unsupported,
            "This torrent is already in that folder",
        ));
    }
    if own_folder && new_folder.starts_with(old_folder) {
        return Err(EngineError::new(
            ErrorCode::Unsupported,
            "Pick a folder outside this torrent's own folder",
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileMove {
    /// Path inside the torrent folder.
    pub rel: PathBuf,
    pub from: PathBuf,
    pub to: PathBuf,
}

/// One entry per relative path. A path that could leave the torrent folder (`..`, absolute) is dropped.
pub fn plan_moves(old_folder: &Path, new_folder: &Path, rels: &[PathBuf]) -> Vec<FileMove> {
    rels.iter()
        .filter(|r| {
            !r.as_os_str().is_empty() && r.components().all(|c| matches!(c, Component::Normal(_)))
        })
        .map(|r| FileMove {
            rel: r.clone(),
            from: old_folder.join(r),
            to: new_folder.join(r),
        })
        .collect()
}

/// Maps a file system error to the code shown on the torrent. Uses Linux errno values, which Android shares.
pub fn move_error(e: &std::io::Error) -> (ErrorCode, String) {
    match e.raw_os_error() {
        // ENOSPC, EDQUOT
        Some(28) | Some(122) => {
            return (
                ErrorCode::DiskFull,
                "Not enough space to move the files. Free up some space, then try again.".to_string(),
            )
        }
        // EPERM, EACCES, EROFS
        Some(1) | Some(13) | Some(30) => {
            return (
                ErrorCode::Permission,
                "Maglev can't write to that folder. Pick another folder and try again.".to_string(),
            )
        }
        _ => {}
    }
    if e.kind() == std::io::ErrorKind::PermissionDenied {
        return (
            ErrorCode::Permission,
            "Maglev can't write to that folder. Pick another folder and try again.".to_string(),
        );
    }
    (
        ErrorCode::Internal,
        "Couldn't move the files. Try again.".to_string(),
    )
}

/// Creates (or reuses) `dir` and checks that a file can be written there.
pub fn probe_writable(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let probe = dir.join(format!(".maglev-write-test-{}", std::process::id()));
    {
        let mut f = std::fs::File::create(&probe)?;
        f.write_all(b"x")?;
    }
    std::fs::remove_file(&probe)
}

/// Copies `from` to `to` in `COPY_CHUNK` pieces, then fsyncs. A failed copy removes the partial target.
pub fn copy_file_chunked(from: &Path, to: &Path, progress: &MoveProgress) -> std::io::Result<()> {
    let result = (|| {
        let mut src = std::fs::File::open(from)?;
        let mut dst = std::fs::File::create(to)?;
        let mut buf = vec![0u8; COPY_CHUNK];
        loop {
            let n = src.read(&mut buf)?;
            if n == 0 {
                break;
            }
            dst.write_all(&buf[..n])?;
            progress.add(n as u64);
        }
        dst.sync_all()
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(to);
    }
    result
}

/// Renames `from` to `to`. If the rename fails (for example across volumes, EXDEV), the file is
/// copied in chunks, fsynced, and the source is removed. Creates the target's parent folder.
pub fn move_file_with(
    from: &Path,
    to: &Path,
    progress: &MoveProgress,
    rename: impl Fn(&Path, &Path) -> std::io::Result<()>,
) -> std::io::Result<()> {
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let len = std::fs::metadata(from)?.len();
    match rename(from, to) {
        Ok(()) => {
            progress.add(len);
            Ok(())
        }
        Err(_) => {
            copy_file_chunked(from, to, progress)?;
            if let Err(e) = std::fs::remove_file(from) {
                // Leave exactly one copy: the original.
                let _ = std::fs::remove_file(to);
                return Err(e);
            }
            Ok(())
        }
    }
}

pub fn move_file(from: &Path, to: &Path, progress: &MoveProgress) -> std::io::Result<()> {
    move_file_with(from, to, progress, |a, b| std::fs::rename(a, b))
}

#[derive(Debug)]
pub struct MoveFailure {
    pub error: std::io::Error,
    /// Files already moved before the failure, in order. Pass to `rollback`.
    pub done: Vec<FileMove>,
}

/// Moves every file whose source exists. A missing source is skipped (the file was never downloaded).
/// Stops at the first error and reports what was already moved.
pub fn execute_moves(
    moves: &[FileMove],
    progress: &MoveProgress,
) -> Result<Vec<FileMove>, MoveFailure> {
    let mut done: Vec<FileMove> = Vec::with_capacity(moves.len());
    for m in moves {
        if !m.from.is_file() {
            continue;
        }
        match move_file(&m.from, &m.to, progress) {
            Ok(()) => done.push(m.clone()),
            Err(error) => return Err(MoveFailure { error, done }),
        }
    }
    Ok(done)
}

/// Puts moved files back, last first. Returns how many could not be restored.
pub fn rollback(done: &[FileMove]) -> usize {
    let scratch = MoveProgress::default();
    let mut failed = 0;
    for m in done.iter().rev() {
        if let Err(e) = move_file(&m.to, &m.from, &scratch) {
            warn!("could not move a file back: {e}");
            failed += 1;
        }
    }
    failed
}

/// Every folder strictly below `base` that holds one of `rels`, deepest first.
pub fn dirs_deepest_first(base: &Path, rels: &[PathBuf]) -> Vec<PathBuf> {
    let mut set: BTreeSet<PathBuf> = BTreeSet::new();
    for rel in rels {
        let mut dir = base.join(rel);
        while dir.pop() && dir != base && dir.starts_with(base) {
            set.insert(dir.clone());
        }
    }
    let mut dirs: Vec<PathBuf> = set.into_iter().collect();
    dirs.sort_by_key(|d| std::cmp::Reverse(d.components().count()));
    dirs
}

/// Removes the folders that held `rels`, if they are empty, and then `base` itself when `remove_base`.
/// A folder that still has other files is left alone. Errors are ignored.
pub fn remove_empty_dirs(base: &Path, rels: &[PathBuf], remove_base: bool) {
    for d in dirs_deepest_first(base, rels) {
        let _ = std::fs::remove_dir(&d);
    }
    if remove_base {
        let _ = std::fs::remove_dir(base);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("maglev-move-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn write(path: &Path, bytes: &[u8]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }

    #[test]
    fn destination_follows_the_torrent_layout() {
        let d = Path::new("/sdcard/Download/Maglev");
        assert_eq!(
            destination_folder(d, "Show S01", 3),
            PathBuf::from("/sdcard/Download/Maglev/Show S01")
        );
        assert_eq!(destination_folder(d, "movie.mkv", 1), d.to_path_buf());
        // a name that cannot be a folder falls back to the chosen folder itself
        assert_eq!(destination_folder(d, "../evil", 3), d.to_path_buf());
    }

    #[test]
    fn destination_checks() {
        let old = Path::new("/a/Show");
        // same folder
        assert_eq!(
            check_destination(Path::new("/a"), old, Path::new("/a/Show"), true)
                .unwrap_err()
                .code,
            ErrorCode::Unsupported
        );
        // into itself (multi-file only)
        assert_eq!(
            check_destination(Path::new("/a/Show/inner"), old, Path::new("/a/Show/inner/Show"), true)
                .unwrap_err()
                .code,
            ErrorCode::Unsupported
        );
        // a single file may move into a sub folder of its current folder
        assert!(check_destination(
            Path::new("/a/Show/inner"),
            Path::new("/a/Show"),
            Path::new("/a/Show/inner"),
            false
        )
        .is_ok());
        // relative path
        assert_eq!(
            check_destination(Path::new("rel"), old, Path::new("rel/Show"), true)
                .unwrap_err()
                .code,
            ErrorCode::InvalidSource
        );
        // a normal move, trailing slash on the old folder does not matter
        assert!(check_destination(Path::new("/b"), Path::new("/a/Show/"), Path::new("/b/Show"), true).is_ok());
    }

    #[test]
    fn plan_moves_maps_paths_and_drops_unsafe_ones() {
        let rels = vec![
            PathBuf::from("a.mkv"),
            PathBuf::from("sub/b.srt"),
            PathBuf::from("../escape"),
            PathBuf::from("/abs"),
            PathBuf::new(),
        ];
        let plan = plan_moves(Path::new("/old"), Path::new("/new/T"), &rels);
        assert_eq!(plan.len(), 2);
        assert_eq!(plan[0].from, PathBuf::from("/old/a.mkv"));
        assert_eq!(plan[0].to, PathBuf::from("/new/T/a.mkv"));
        assert_eq!(plan[1].from, PathBuf::from("/old/sub/b.srt"));
        assert_eq!(plan[1].to, PathBuf::from("/new/T/sub/b.srt"));
    }

    #[test]
    fn progress_math() {
        assert_eq!(progress_fraction(0, 0), 0.0);
        assert_eq!(progress_fraction(50, 200), 0.25);
        assert_eq!(progress_fraction(300, 200), 1.0);
        let p = MoveProgress::new(1000);
        assert_eq!(p.fraction(), 0.0);
        p.add(250);
        assert_eq!(p.fraction(), 0.25);
        p.reset_done();
        assert_eq!(p.fraction(), 0.0);
    }

    #[test]
    fn error_codes_for_io_errors() {
        let full = std::io::Error::from_raw_os_error(28);
        assert_eq!(move_error(&full).0, ErrorCode::DiskFull);
        let denied = std::io::Error::from_raw_os_error(13);
        assert_eq!(move_error(&denied).0, ErrorCode::Permission);
        let kind = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        assert_eq!(move_error(&kind).0, ErrorCode::Permission);
        let other = std::io::Error::other("boom");
        assert_eq!(move_error(&other).0, ErrorCode::Internal);
    }

    #[test]
    fn chunked_copy_matches_the_source_across_chunk_boundaries() {
        let dir = temp_dir("copy");
        let src = dir.join("src.bin");
        // a bit more than two chunks, with a recognisable pattern
        let data: Vec<u8> = (0..(COPY_CHUNK * 2 + 123)).map(|i| (i % 251) as u8).collect();
        write(&src, &data);
        let dst = dir.join("out/dst.bin");
        std::fs::create_dir_all(dst.parent().unwrap()).unwrap();
        let p = MoveProgress::new(data.len() as u64);
        copy_file_chunked(&src, &dst, &p).unwrap();
        assert_eq!(std::fs::read(&dst).unwrap(), data);
        assert_eq!(p.fraction(), 1.0);
        assert!(src.exists());
        // a copy that cannot start leaves no partial target
        let missing = dir.join("none.bin");
        let bad = dir.join("out/bad.bin");
        assert!(copy_file_chunked(&missing, &bad, &p).is_err());
        assert!(!bad.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn move_uses_rename_when_it_works() {
        let dir = temp_dir("rename");
        let from = dir.join("a/f.bin");
        write(&from, b"hello");
        let to = dir.join("b/c/f.bin");
        let p = MoveProgress::new(5);
        move_file(&from, &to, &p).unwrap();
        assert!(!from.exists());
        assert_eq!(std::fs::read(&to).unwrap(), b"hello");
        assert_eq!(p.fraction(), 1.0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn move_falls_back_to_copy_when_rename_is_refused() {
        let dir = temp_dir("exdev");
        let from = dir.join("f.bin");
        let data = vec![7u8; COPY_CHUNK + 10];
        write(&from, &data);
        let to = dir.join("other/f.bin");
        let p = MoveProgress::new(data.len() as u64);
        // 18 is EXDEV
        move_file_with(&from, &to, &p, |_, _| Err(std::io::Error::from_raw_os_error(18))).unwrap();
        assert!(!from.exists(), "the source is removed after the copy");
        assert_eq!(std::fs::read(&to).unwrap(), data);
        assert_eq!(p.fraction(), 1.0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn execute_skips_missing_files_and_rollback_restores_the_rest() {
        let dir = temp_dir("exec");
        let old = dir.join("old/T");
        let new = dir.join("new/T");
        write(&old.join("a.bin"), b"aaaa");
        write(&old.join("sub/b.bin"), b"bb");
        let rels = vec![
            PathBuf::from("a.bin"),
            PathBuf::from("sub/b.bin"),
            PathBuf::from("never-downloaded.bin"),
        ];
        let plan = plan_moves(&old, &new, &rels);
        let p = MoveProgress::new(6);
        let done = execute_moves(&plan, &p).unwrap();
        assert_eq!(done.len(), 2);
        assert!(new.join("sub/b.bin").exists() && !old.join("a.bin").exists());
        assert_eq!(p.fraction(), 1.0);

        assert_eq!(rollback(&done), 0);
        assert_eq!(std::fs::read(old.join("a.bin")).unwrap(), b"aaaa");
        assert_eq!(std::fs::read(old.join("sub/b.bin")).unwrap(), b"bb");
        assert!(!new.join("a.bin").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn execute_reports_what_was_done_before_a_failure() {
        let dir = temp_dir("fail");
        let old = dir.join("old");
        let new = dir.join("new");
        write(&old.join("a.bin"), b"aa");
        write(&old.join("b.bin"), b"bb");
        // the second target's parent is a regular file, so creating it fails
        write(&new.join("blocked"), b"x");
        let plan = vec![
            FileMove {
                rel: "a.bin".into(),
                from: old.join("a.bin"),
                to: new.join("a.bin"),
            },
            FileMove {
                rel: "b.bin".into(),
                from: old.join("b.bin"),
                to: new.join("blocked/b.bin"),
            },
        ];
        let p = MoveProgress::new(4);
        let fail = execute_moves(&plan, &p).unwrap_err();
        assert_eq!(fail.done.len(), 1);
        assert!(old.join("b.bin").exists(), "the failing file stays where it was");
        assert_eq!(rollback(&fail.done), 0);
        assert!(old.join("a.bin").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_source_folders_are_removed_but_folders_with_other_files_stay() {
        let dir = temp_dir("clean");
        let base = dir.join("T");
        std::fs::create_dir_all(base.join("a/b")).unwrap();
        std::fs::create_dir_all(base.join("keep")).unwrap();
        write(&base.join("keep/other.txt"), b"x");
        let rels = vec![PathBuf::from("a/b/f.bin"), PathBuf::from("keep/f.bin"), PathBuf::from("g.bin")];
        let dirs = dirs_deepest_first(&base, &rels);
        assert_eq!(dirs, vec![base.join("a/b"), base.join("a"), base.join("keep")]);
        remove_empty_dirs(&base, &rels, true);
        assert!(!base.join("a").exists());
        assert!(base.join("keep/other.txt").exists());
        assert!(base.exists(), "the base is not empty, so it stays");

        std::fs::remove_file(base.join("keep/other.txt")).unwrap();
        remove_empty_dirs(&base, &rels, true);
        assert!(!base.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn probe_creates_the_folder_and_leaves_nothing_behind() {
        let dir = temp_dir("probe");
        let target = dir.join("x/y");
        probe_writable(&target).unwrap();
        assert!(target.is_dir());
        assert_eq!(std::fs::read_dir(&target).unwrap().count(), 0);
        // a path under a regular file cannot be created
        write(&dir.join("file"), b"x");
        assert!(probe_writable(&dir.join("file/sub")).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
