import { useEffect, useState } from 'react';
import { maglevEngine, type FreeSpace } from 'maglev-engine';
import { useEngineTelemetry } from '../context/EngineContext';
import { admit, pendingNeedOf, type AdmissionOutcome } from './admission';
import { noSpaceBody } from './admissionCopy';

/**
 * Free space and the SM-35 admission check for a web-link download (Add download and the browser's
 * found-files sheet share it). Free space is read each time `active` turns on; it is kept while
 * `active` is off, so a preview that is starting still shows its last answer.
 */
export function useDownloadAdmission(size: number | null | undefined, active: boolean): {
  free: FreeSpace | null;
  outcome: AdmissionOutcome | null;
  doesntFit: boolean;
  /** Body for the "Not enough space" banner: the figures and the reason. Undefined unless `doesntFit`. */
  noSpace: string | undefined;
} {
  const { telemetry, downloads } = useEngineTelemetry();
  const [free, setFree] = useState<FreeSpace | null>(null);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    maglevEngine
      .getFreeSpace()
      .then((res) => {
        if (alive) setFree(res.ok ? res : null);
      })
      .catch(() => {
        if (alive) setFree(null);
      });
    return () => {
      alive = false;
    };
  }, [active]);
  const freeBytes = free ? Math.min(free.freeBytes, free.targetFreeBytes ?? free.freeBytes) : null;
  const pendingNeed = pendingNeedOf(telemetry.torrents, downloads);
  const outcome =
    freeBytes !== null && size
      ? admit({
          freeBytes,
          pendingNeed,
          stagingFactor: free?.mode === 'staging' ? 2 : 1,
          selectionBytes: size,
        })
      : null;
  const doesntFit = outcome?.result === 'DoesntFit';
  return { free, outcome, doesntFit, noSpace: doesntFit && outcome ? noSpaceBody(outcome, pendingNeed) : undefined };
}
