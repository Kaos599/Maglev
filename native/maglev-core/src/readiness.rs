//! Streaming readiness (contract section 11.4): how much of a file can be played right now.
//!
//! Pure byte math over the piece bitfield, so it is unit tested without a session.
//! librqbit's bitfield is `Msb0`: piece 0 is the top bit of byte 0.

/// True when piece `piece` is set in a raw `Msb0` bitfield. Pieces past the end count as missing.
pub fn have_piece(raw: &[u8], piece: u32) -> bool {
    raw.get((piece / 8) as usize)
        .map(|b| b & (0x80u8 >> (piece % 8)) != 0)
        .unwrap_or(false)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileReadiness {
    /// Contiguous downloaded bytes from the start of the file.
    pub stream_ready_bytes: u64,
    /// The last piece of the file is present (players read the MP4 index at the end).
    pub tail_ready: bool,
}

/// `offset` is the file's byte offset in the torrent, `len` its length, `piece_length` the torrent's
/// piece size. `have` says whether a piece is verified.
///
/// A piece that straddles a file boundary counts for both files. The last piece of the torrent may be
/// shorter than `piece_length`; the result is capped at the file's end, so that does not matter.
/// A zero-length file has nothing to wait for: 0 ready bytes and `tail_ready = true`.
pub fn file_readiness(
    offset: u64,
    len: u64,
    piece_length: u64,
    have: impl Fn(u32) -> bool,
) -> FileReadiness {
    if len == 0 {
        return FileReadiness {
            stream_ready_bytes: 0,
            tail_ready: true,
        };
    }
    if piece_length == 0 {
        return FileReadiness {
            stream_ready_bytes: 0,
            tail_ready: false,
        };
    }
    let end = offset.saturating_add(len);
    let first = offset / piece_length;
    let last = (end - 1) / piece_length;

    let mut ready_end = offset;
    let mut p = first;
    while p <= last && have(p as u32) {
        ready_end = (p + 1).saturating_mul(piece_length).min(end);
        p += 1;
    }
    FileReadiness {
        stream_ready_bytes: ready_end - offset,
        tail_ready: have(last as u32),
    }
}

/// One file, as the byte totals below need it.
#[derive(Debug, Clone, Copy)]
pub struct FileBytes {
    pub len: u64,
    pub padding: bool,
    pub included: bool,
    /// librqbit's per-file have-bytes (exact to the file, unlike its piece-sized torrent totals).
    pub have: u64,
}

/// A torrent's byte totals, built from its files.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TorrentBytes {
    /// Sum of the included, non-padding file lengths.
    pub total: u64,
    /// Downloaded bytes of those files. Never above `total`.
    pub progress: u64,
    /// Downloaded bytes of every file, skipped ones too: what deleting the files frees.
    pub held: u64,
}

/// librqbit counts whole pieces, so a 1.6 KB file kept out of a torrent with 128 KB pieces read as
/// "128 KB of 1.6 KB". Summing the per-file counts gives the real numbers.
pub fn torrent_bytes(files: impl IntoIterator<Item = FileBytes>) -> TorrentBytes {
    let mut out = TorrentBytes { total: 0, progress: 0, held: 0 };
    for f in files {
        if f.padding {
            continue;
        }
        let have = f.have.min(f.len);
        out.held += have;
        if f.included {
            out.total += f.len;
            out.progress += have;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn have_set(pieces: &[u32]) -> impl Fn(u32) -> bool {
        let s: HashSet<u32> = pieces.iter().copied().collect();
        move |p| s.contains(&p)
    }

    #[test]
    fn bitfield_is_msb_first() {
        let raw = [0b1000_0001u8, 0b0100_0000];
        assert!(have_piece(&raw, 0));
        assert!(!have_piece(&raw, 1));
        assert!(have_piece(&raw, 7));
        assert!(!have_piece(&raw, 8));
        assert!(have_piece(&raw, 9));
        // past the end
        assert!(!have_piece(&raw, 16));
        assert!(!have_piece(&[], 0));
    }

    #[test]
    fn file_inside_one_piece() {
        // piece length 100, file bytes 120..170 lives in piece 1 only
        let r = file_readiness(120, 50, 100, have_set(&[]));
        assert_eq!(r, FileReadiness { stream_ready_bytes: 0, tail_ready: false });
        let r = file_readiness(120, 50, 100, have_set(&[1]));
        assert_eq!(r, FileReadiness { stream_ready_bytes: 50, tail_ready: true });
    }

    #[test]
    fn file_spanning_pieces_counts_the_contiguous_prefix() {
        // file 50..450 with piece length 100 covers pieces 0..=4
        let r = file_readiness(50, 400, 100, have_set(&[0, 1, 2]));
        // pieces 0,1,2 end at byte 300, the file starts at 50
        assert_eq!(r, FileReadiness { stream_ready_bytes: 250, tail_ready: false });
        // a gap stops the prefix; the later piece only counts for the tail
        let r = file_readiness(50, 400, 100, have_set(&[0, 2, 4]));
        assert_eq!(r, FileReadiness { stream_ready_bytes: 50, tail_ready: true });
        // everything present: capped at the file length
        let r = file_readiness(50, 400, 100, have_set(&[0, 1, 2, 3, 4]));
        assert_eq!(r, FileReadiness { stream_ready_bytes: 400, tail_ready: true });
    }

    #[test]
    fn first_piece_missing_means_nothing_is_ready() {
        let r = file_readiness(0, 300, 100, have_set(&[1, 2]));
        assert_eq!(r, FileReadiness { stream_ready_bytes: 0, tail_ready: true });
    }

    #[test]
    fn file_ending_exactly_on_a_piece_boundary() {
        // bytes 0..200 are pieces 0 and 1; piece 2 belongs to the next file
        let r = file_readiness(0, 200, 100, have_set(&[0, 1]));
        assert_eq!(r, FileReadiness { stream_ready_bytes: 200, tail_ready: true });
        let r = file_readiness(0, 200, 100, have_set(&[0, 2]));
        assert_eq!(r, FileReadiness { stream_ready_bytes: 100, tail_ready: false });
    }

    #[test]
    fn short_last_piece_of_the_torrent_is_capped_at_the_file_end() {
        // total 250 bytes, piece length 100: piece 2 has only 50 bytes. File is 200..250.
        let r = file_readiness(200, 50, 100, have_set(&[2]));
        assert_eq!(r, FileReadiness { stream_ready_bytes: 50, tail_ready: true });
    }

    #[test]
    fn zero_length_and_degenerate_inputs() {
        let r = file_readiness(300, 0, 100, have_set(&[]));
        assert_eq!(r, FileReadiness { stream_ready_bytes: 0, tail_ready: true });
        let r = file_readiness(0, 10, 0, have_set(&[0]));
        assert_eq!(r, FileReadiness { stream_ready_bytes: 0, tail_ready: false });
    }

    #[test]
    fn works_with_a_raw_bitfield() {
        // pieces 0..=3 present (0b1111_0000), file 0..400 with piece length 100
        let raw = [0b1111_0000u8];
        let r = file_readiness(0, 400, 100, |p| have_piece(&raw, p));
        assert_eq!(r, FileReadiness { stream_ready_bytes: 400, tail_ready: true });
    }

    #[test]
    fn torrent_bytes_count_files_not_pieces() {
        let f = |len, included, have| FileBytes { len, padding: false, included, have };
        // One 1.6 KB subtitle kept, a 120 MB video skipped after it had downloaded.
        let b = torrent_bytes([f(1_600, true, 1_600), f(120_000_000, false, 120_000_000)]);
        assert_eq!(b, TorrentBytes { total: 1_600, progress: 1_600, held: 120_001_600 });
        // Progress never passes the total, even if a count runs past the file.
        assert_eq!(torrent_bytes([f(1_600, true, 131_072)]).progress, 1_600);
        // Padding files hold nothing.
        let pad = FileBytes { len: 500, padding: true, included: true, have: 500 };
        assert_eq!(torrent_bytes([pad, f(10, true, 5)]), TorrentBytes { total: 10, progress: 5, held: 5 });
    }
}
