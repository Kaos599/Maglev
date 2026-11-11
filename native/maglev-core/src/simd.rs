//! Piece bitfield downsampling for the 16x16 piece grid.
//!
//! Output values (contract `nativeGetPieceBitfield`): 0 = missing, 1 = have, 2 = partial.
//! Input is the BEP 3 bitfield (most significant bit first), which is what librqbit's `BitBox<u8, Msb0>`
//! exposes through `as_raw_slice()`.

pub const MATRIX_SIZE: usize = 256;

pub const CELL_MISSING: u8 = 0;
pub const CELL_HAVE: u8 = 1;
pub const CELL_PARTIAL: u8 = 2;

/// Each of the 256 cells covers an equal share of the pieces. With fewer than 256 pieces the pieces
/// are stretched so the grid is always filled.
pub fn downsample_bitfield(bitfield: &[u8], total_pieces: usize, output: &mut [u8; MATRIX_SIZE]) {
    if total_pieces == 0 {
        output.fill(CELL_MISSING);
        return;
    }
    for (cell, out) in output.iter_mut().enumerate() {
        let start = cell * total_pieces / MATRIX_SIZE;
        let end = ((cell + 1) * total_pieces / MATRIX_SIZE)
            .max(start + 1)
            .min(total_pieces);
        let start = start.min(total_pieces - 1);
        let span = end - start;
        let have = count_set_bits_range(bitfield, start, end);
        *out = if have == 0 {
            CELL_MISSING
        } else if have >= span {
            CELL_HAVE
        } else {
            CELL_PARTIAL
        };
    }
}

/// Number of set bits at piece indices `[start, end)`.
fn count_set_bits_range(data: &[u8], start: usize, end: usize) -> usize {
    let mut count = 0usize;
    let mut bit = start;
    while bit < end && bit % 8 != 0 {
        count += bit_at(data, bit) as usize;
        bit += 1;
    }
    let mut byte = bit / 8;
    let end_byte = end / 8;
    while byte + 8 <= end_byte && byte + 8 <= data.len() {
        let mut chunk = [0u8; 8];
        chunk.copy_from_slice(&data[byte..byte + 8]);
        count += u64::from_be_bytes(chunk).count_ones() as usize;
        byte += 8;
    }
    while byte < end_byte && byte < data.len() {
        count += data[byte].count_ones() as usize;
        byte += 1;
    }
    bit = (byte * 8).max(bit);
    while bit < end {
        count += bit_at(data, bit) as usize;
        bit += 1;
    }
    count
}

fn bit_at(data: &[u8], bit: usize) -> bool {
    data.get(bit / 8)
        .is_some_and(|b| b & (1 << (7 - (bit % 8))) != 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_pieces_is_all_missing() {
        let mut out = [9u8; MATRIX_SIZE];
        downsample_bitfield(&[], 0, &mut out);
        assert_eq!(out, [CELL_MISSING; MATRIX_SIZE]);
    }

    #[test]
    fn small_torrents_are_stretched_over_the_grid() {
        // 4 pieces, the first two present: the first half of the grid is "have".
        let mut out = [0u8; MATRIX_SIZE];
        downsample_bitfield(&[0b1100_0000], 4, &mut out);
        assert!(out[..128].iter().all(|&v| v == CELL_HAVE));
        assert!(out[128..].iter().all(|&v| v == CELL_MISSING));
    }

    #[test]
    fn full_and_empty_large_torrents() {
        let pieces = 2048;
        let mut out = [0u8; MATRIX_SIZE];
        downsample_bitfield(&vec![0xFF; pieces / 8], pieces, &mut out);
        assert!(out.iter().all(|&v| v == CELL_HAVE));
        downsample_bitfield(&vec![0x00; pieces / 8], pieces, &mut out);
        assert!(out.iter().all(|&v| v == CELL_MISSING));
    }

    #[test]
    fn partial_cells_are_marked() {
        // 2048 pieces, 8 per cell. Only piece 0 present: cell 0 partial, the rest missing.
        let mut bf = vec![0u8; 256];
        bf[0] = 0b1000_0000;
        let mut out = [0u8; MATRIX_SIZE];
        downsample_bitfield(&bf, 2048, &mut out);
        assert_eq!(out[0], CELL_PARTIAL);
        assert!(out[1..].iter().all(|&v| v == CELL_MISSING));
    }

    #[test]
    fn uneven_piece_counts_and_short_buffers_do_not_panic() {
        for pieces in [1usize, 7, 255, 256, 257, 1000, 4099] {
            let mut out = [0u8; MATRIX_SIZE];
            downsample_bitfield(&vec![0xFF; pieces.div_ceil(8)], pieces, &mut out);
            assert!(out.iter().all(|&v| v == CELL_HAVE), "pieces={pieces}");
            // A buffer shorter than expected is treated as missing bits.
            downsample_bitfield(&[0xFF], pieces, &mut out);
        }
    }

    #[test]
    fn range_counter_matches_naive_count() {
        let data: Vec<u8> = (0..64u32).map(|i| (i * 37 % 251) as u8).collect();
        for (s, e) in [(0, 512), (3, 500), (8, 72), (5, 6), (13, 13), (100, 413)] {
            let naive = (s..e).filter(|&b| bit_at(&data, b)).count();
            assert_eq!(count_set_bits_range(&data, s, e), naive, "{s}..{e}");
        }
    }
}
