/**
 * Admission check for adding a torrent (SM-35). Pure: no React, no react-native.
 * Kotlin port `Admission.kt` must match `scripts/fixtures/admission-vectors.json`.
 */

/** Keep this much free for the system (NATIVE_CONTRACT 10.3). */
export const ADMISSION_RESERVE_BYTES = 200 * 1024 * 1024;
/** Tight is the band of less than this left over the budget. */
const ADMISSION_TIGHT_BAND_BYTES = 1024 * 1024 * 1024;

export type AdmissionResult = 'Fits' | 'Tight' | 'DoesntFit';

export interface AdmissionInput {
  /** Free bytes on the target (the smaller of the folder and SAF target when staged). */
  freeBytes: number;
  /** What unfinished torrents and link downloads still have to write (`pendingNeedOf`). */
  pendingNeed: number;
  /** 2 when the folder is SAF-staged, else 1. */
  stagingFactor: number;
  /** Bytes of the selection being added. */
  selectionBytes: number;
}

export interface AdmissionOutcome {
  result: AdmissionResult;
  /** selectionBytes x stagingFactor. */
  need: number;
  /** freeBytes - pendingNeed - 200 MB. */
  budget: number;
  /** budget - need. Negative only when DoesntFit. */
  leftAfter: number;
}

/** A torrent as pending need sees it. */
export interface PendingTorrent {
  finished?: boolean;
  includedBytes?: number;
  downloadedBytes: number;
}

/** A link download (or saved stream) as pending need sees it. `DownloadSnapshot` fits. */
export interface PendingDownload {
  state: string;
  /** Bytes, or null/0 while the server has not said. A stream's size is an estimate. */
  size: number | null;
  downloaded: number;
  error?: { code: string; httpStatus?: number | null } | null;
}

/** Same set as Kotlin `AutoRetry.RETRY_STATUSES` (NATIVE_CONTRACT 10.3): an error worth another try. */
const RETRYABLE_STATUSES = [408, 429, 500, 502, 503, 504];

/**
 * Will this link download still write bytes? queued, resolving, downloading and paused (any `pausedBy`) will.
 * `error` will only when auto-retry would retry it. `finished`, `verifying` (everything is written),
 * `needs_link` (waits for the user) and any other error will not. NATIVE_CONTRACT 10.3.
 */
function downloadStillWrites(d: Pick<PendingDownload, 'state' | 'error'>): boolean {
  switch (d.state) {
    case 'queued':
    case 'resolving':
    case 'downloading':
    case 'paused':
      return true;
    case 'error': {
      const code = d.error?.code;
      if (code === 'NETWORK' || code === 'STALLED') return true;
      return code === 'HTTP_STATUS' && RETRYABLE_STATUSES.includes(d.error?.httpStatus ?? -1);
    }
    default:
      return false;
  }
}

/**
 * SM-35 pendingNeed: sum of max(0, includedBytes - progressBytes) over unfinished torrents, plus
 * max(0, size - downloaded) over link downloads that will still write and have a known size.
 * Both lists are required: leaving the downloads out lets two big links be admitted against the same free space.
 * No staging factor here, for either kind: only the new selection is doubled.
 */
export function pendingNeedOf(torrents: readonly PendingTorrent[], downloads: readonly PendingDownload[]): number {
  let need = 0;
  for (const t of torrents) {
    if (t.finished) continue;
    need += Math.max(0, (t.includedBytes ?? 0) - t.downloadedBytes);
  }
  for (const d of downloads) {
    if (!downloadStillWrites(d) || !d.size || d.size <= 0) continue;
    need += Math.max(0, d.size - d.downloaded);
  }
  return need;
}

export type OneTapDecision = 'add' | 'addWithNotice' | 'openSheet';

/** SM-35 Search one-tap column: Fits adds, Tight adds with a notice, DoesntFit opens the file sheet. */
export function oneTapDecision(result: AdmissionResult): OneTapDecision {
  if (result === 'Fits') return 'add';
  if (result === 'Tight') return 'addWithNotice';
  return 'openSheet';
}

/** Decide whether a selection fits. Fits: need <= budget - 1 GB. Tight: need <= budget. Else DoesntFit. */
export function admit({ freeBytes, pendingNeed, stagingFactor, selectionBytes }: AdmissionInput): AdmissionOutcome {
  const need = selectionBytes * stagingFactor;
  const budget = freeBytes - pendingNeed - ADMISSION_RESERVE_BYTES;
  const leftAfter = budget - need;
  let result: AdmissionResult;
  if (need <= budget - ADMISSION_TIGHT_BAND_BYTES) result = 'Fits';
  else if (need <= budget) result = 'Tight';
  else result = 'DoesntFit';
  return { result, need, budget, leftAfter };
}
