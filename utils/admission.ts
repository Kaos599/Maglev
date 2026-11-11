/**
 * Admission check for adding a torrent (SM-35). Pure: no React, no react-native.
 * Kotlin port `Admission.kt` must match `scripts/fixtures/admission-vectors.json`.
 */

/** Keep this much free for the system (NATIVE_CONTRACT 10.3). */
export const ADMISSION_RESERVE_BYTES = 200 * 1024 * 1024;
/** Tight is the band of less than this left over the budget. */
export const ADMISSION_TIGHT_BAND_BYTES = 1024 * 1024 * 1024;

export type AdmissionResult = 'Fits' | 'Tight' | 'DoesntFit';

export interface AdmissionInput {
  /** Free bytes on the target (the smaller of the folder and SAF target when staged). */
  freeBytes: number;
  /** Sum over unfinished torrents of (included bytes - downloaded bytes). */
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

/** SM-35 pendingNeed: sum of max(0, includedBytes - progressBytes) over unfinished torrents. */
export function pendingNeedOf(
  torrents: readonly { finished?: boolean; includedBytes?: number; downloadedBytes: number }[],
): number {
  let need = 0;
  for (const t of torrents) {
    if (t.finished) continue;
    need += Math.max(0, (t.includedBytes ?? 0) - t.downloadedBytes);
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
