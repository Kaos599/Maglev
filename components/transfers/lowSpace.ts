/**
 * Low-storage banner on Transfers. Same rule as adding a torrent and the assistant (utils/admission.ts):
 * the budget is free space minus what unfinished downloads still need minus the 200 MB reserve.
 * Pure: no React, no react-native.
 */
import { ADMISSION_RESERVE_BYTES, pendingNeedOf } from '../../utils/admission.ts';
import { formatBytes } from '../../constants/format.ts';

export interface FreeSpaceLike {
  freeBytes: number;
  /** Staging mode: free bytes on the SAF target. The smaller of the two is what writes can use. */
  targetFreeBytes?: number | null;
}

export interface LowSpaceWarning {
  title: string;
  body: string;
  freeBytes: number;
  pendingNeed: number;
}

/** Free bytes writes can use, or null when the engine did not say. */
export function usableFreeOf(fs: FreeSpaceLike | null | undefined): number | null {
  if (!fs || typeof fs.freeBytes !== 'number' || !Number.isFinite(fs.freeBytes) || fs.freeBytes < 0) return null;
  const target = fs.targetFreeBytes;
  return typeof target === 'number' && Number.isFinite(target) && target >= 0 ? Math.min(fs.freeBytes, target) : fs.freeBytes;
}

/**
 * The warning, or null. Null when free space is unknown, when no unfinished download needs space,
 * or when the space left after them is at least the reserve.
 */
export function lowSpaceWarning(
  freeBytes: number | null | undefined,
  torrents: readonly { finished?: boolean; includedBytes?: number; downloadedBytes: number }[],
): LowSpaceWarning | null {
  if (freeBytes == null || !Number.isFinite(freeBytes) || freeBytes < 0) return null;
  const pendingNeed = pendingNeedOf(torrents);
  if (pendingNeed <= 0) return null;
  if (freeBytes - pendingNeed >= ADMISSION_RESERVE_BYTES) return null;
  const body =
    pendingNeed > freeBytes
      ? `Unfinished downloads need ${formatBytes(pendingNeed - freeBytes)} more than the ${formatBytes(freeBytes)} free.`
      : `Unfinished downloads need ${formatBytes(pendingNeed)} of the ${formatBytes(freeBytes)} free. That leaves less than ${formatBytes(ADMISSION_RESERVE_BYTES)} for your phone.`;
  return { title: 'Not enough space for your downloads', body, freeBytes, pendingNeed };
}
