// Caption under the Add torrent preview (SM-35). Pure: no React.
// The budget is free space minus what the user's other downloads still need minus a 200 MB margin, so the
// caption says so when other downloads are pending; otherwise "Free on device" and "Leaves" would not add up.
import { formatBytes } from '../constants/format.ts';
import { ADMISSION_RESERVE_BYTES, type AdmissionOutcome } from './admission.ts';

const SPARE = `${ADMISSION_RESERVE_BYTES / (1024 * 1024)} MB`;

/** The caption for a Tight or DoesntFit outcome, or null when the selection fits comfortably. */
export function admissionCaption(out: AdmissionOutcome, pendingNeed: number): string | null {
  const others = pendingNeed > 0;
  if (out.result === 'DoesntFit') {
    return others
      ? `Needs ${formatBytes(out.need)}, only ${formatBytes(Math.max(0, out.budget))} free after your other downloads finish`
      : `Needs ${formatBytes(out.need)}, ${formatBytes(Math.max(0, out.budget))} free`;
  }
  if (out.result === 'Tight') {
    return others
      ? `Leaves ${formatBytes(out.leftAfter)} free after your other downloads finish (${formatBytes(pendingNeed)} still to come, ${SPARE} kept spare)`
      : `Leaves ${formatBytes(out.leftAfter)} free (${SPARE} kept spare)`;
  }
  return null;
}
