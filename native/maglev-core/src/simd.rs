//! SIMD and fast bit-popcount piece downsampling.
//!
//! Downsamples arbitrary length BitTorrent piece bitfields into a fixed 256-byte
//! array (`[u8; 256]`) corresponding to the 16x16 mobile HUD visualizer matrix.
//! Uses `u64::count_ones()` for high throughput zero-allocation sampling.

pub const MATRIX_SIZE: usize = 256;

pub const BLOCK_UNAVAILABLE: u8 = 0; // #161D26
pub const BLOCK_IN_FLIGHT: u8 = 1;   // #CCFF00
pub const BLOCK_VERIFIED: u8 = 2;    // #00E5FF
pub const BLOCK_CORRUPT: u8 = 3;     // #FF3366

/// Downsamples a piece bitfield into the fixed 256-byte output buffer.
///
/// # Arguments
/// * `bitfield`: Raw BitTorrent bitfield slice (MSB first, standard BEP 3 format).
/// * `total_pieces`: Total number of pieces in the torrent.
/// * `in_flight_mask`: Optional slice indicating pieces currently requested from peers.
/// * `output`: Fixed 256-byte target buffer.
#[inline]
pub fn downsample_bitfield(
    bitfield: &[u8],
    total_pieces: usize,
    in_flight_mask: Option<&[u8]>,
    output: &mut [u8; MATRIX_SIZE],
) {
    if total_pieces == 0 {
        output.fill(BLOCK_UNAVAILABLE);
        return;
    }

    if total_pieces <= MATRIX_SIZE {
        // Direct 1:1 mapping when piece count is <= 256
        for block_idx in 0..MATRIX_SIZE {
            if block_idx < total_pieces {
                let byte_idx = block_idx / 8;
                let bit_offset = 7 - (block_idx % 8);

                let is_verified = if byte_idx < bitfield.len() {
                    (bitfield[byte_idx] & (1 << bit_offset)) != 0
                } else {
                    false
                };

                if is_verified {
                    output[block_idx] = BLOCK_VERIFIED;
                } else {
                    let is_in_flight = in_flight_mask.map_or(false, |mask| {
                        if byte_idx < mask.len() {
                            (mask[byte_idx] & (1 << bit_offset)) != 0
                        } else {
                            false
                        }
                    });

                    output[block_idx] = if is_in_flight {
                        BLOCK_IN_FLIGHT
                    } else {
                        BLOCK_UNAVAILABLE
                    };
                }
            } else {
                output[block_idx] = BLOCK_UNAVAILABLE;
            }
        }
        return;
    }

    // When piece count > 256, downsample bins using fast popcount.
    // Each of the 256 blocks covers pieces in range [start_piece, end_piece).
    let pieces_per_block = total_pieces as f64 / MATRIX_SIZE as f64;

    for block_idx in 0..MATRIX_SIZE {
        let start_piece = (block_idx as f64 * pieces_per_block).floor() as usize;
        let mut end_piece = ((block_idx + 1) as f64 * pieces_per_block).floor() as usize;
        if end_piece > total_pieces {
            end_piece = total_pieces;
        }
        if start_piece >= end_piece {
            output[block_idx] = BLOCK_UNAVAILABLE;
            continue;
        }

        let bin_size = end_piece - start_piece;
        let verified_count = count_set_bits_range(bitfield, start_piece, end_piece);

        if verified_count == bin_size {
            output[block_idx] = BLOCK_VERIFIED;
        } else if verified_count > 0 {
            // Partially verified bin displays as in-flight / progressing
            output[block_idx] = BLOCK_IN_FLIGHT;
        } else {
            // Check in-flight mask
            let in_flight_count = in_flight_mask
                .map(|m| count_set_bits_range(m, start_piece, end_piece))
                .unwrap_or(0);

            output[block_idx] = if in_flight_count > 0 {
                BLOCK_IN_FLIGHT
            } else {
                BLOCK_UNAVAILABLE
            };
        }
    }
}

/// Fast bit counting in a specified piece index range [start, end)
#[inline]
fn count_set_bits_range(data: &[u8], start_bit: usize, end_bit: usize) -> usize {
    if start_bit >= end_bit || data.is_empty() {
        return 0;
    }

    let mut count = 0;
    let mut current_bit = start_bit;

    // Head unaligned bits up to byte boundary
    while current_bit < end_bit && (current_bit % 8) != 0 {
        let byte_idx = current_bit / 8;
        let bit_offset = 7 - (current_bit % 8);
        if byte_idx < data.len() && (data[byte_idx] & (1 << bit_offset)) != 0 {
            count += 1;
        }
        current_bit += 1;
    }

    // Process aligned 64-bit words via u64::count_ones()
    let mut byte_idx = current_bit / 8;
    let end_byte = end_bit / 8;

    while byte_idx + 8 <= end_byte && byte_idx + 8 <= data.len() {
        let chunk: [u8; 8] = [
            data[byte_idx],
            data[byte_idx + 1],
            data[byte_idx + 2],
            data[byte_idx + 3],
            data[byte_idx + 4],
            data[byte_idx + 5],
            data[byte_idx + 6],
            data[byte_idx + 7],
        ];
        let word = u64::from_be_bytes(chunk);
        count += word.count_ones() as usize;
        byte_idx += 8;
        current_bit = byte_idx * 8;
    }

    // Process remaining aligned bytes
    while byte_idx < end_byte && byte_idx < data.len() {
        count += data[byte_idx].count_ones() as usize;
        byte_idx += 1;
        current_bit = byte_idx * 8;
    }

    // Tail unaligned bits
    while current_bit < end_bit {
        let b_idx = current_bit / 8;
        let bit_offset = 7 - (current_bit % 8);
        if b_idx < data.len() && (data[b_idx] & (1 << bit_offset)) != 0 {
            count += 1;
        }
        current_bit += 1;
    }

    count
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_zero_pieces() {
        let mut out = [255u8; MATRIX_SIZE];
        downsample_bitfield(&[], 0, None, &mut out);
        assert_eq!(out, [BLOCK_UNAVAILABLE; MATRIX_SIZE]);
    }

    #[test]
    fn test_small_all_verified() {
        let bitfield = [0b11110000];
        let mut out = [0u8; MATRIX_SIZE];
        downsample_bitfield(&bitfield, 4, None, &mut out);
        for i in 0..4 {
            assert_eq!(out[i], BLOCK_VERIFIED);
        }
        for i in 4..MATRIX_SIZE {
            assert_eq!(out[i], BLOCK_UNAVAILABLE);
        }
    }

    #[test]
    fn test_large_swarm_downsample() {
        // 2048 pieces (8 pieces per block)
        let total_pieces = 2048;
        let bitfield = vec![0xFF; total_pieces / 8];
        let mut out = [0u8; MATRIX_SIZE];
        downsample_bitfield(&bitfield, total_pieces, None, &mut out);
        for val in out.iter() {
            assert_eq!(*val, BLOCK_VERIFIED);
        }
    }
}
