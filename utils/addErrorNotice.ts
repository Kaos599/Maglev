import { empty } from '../constants/copy.ts';

/** Button labels (buttons are not sentences, so they live here and not in the copy voice lint). */
export const START_ENGINE_LABEL = 'Start the downloader';
const PICK_FOLDER_LABEL = 'Pick folder again';

export interface AddNotice {
  tone: 'info' | 'danger';
  title: string;
  body?: string;
  actionLabel?: string;
  onAction?: () => void;
  /** How long the notice stays, when longer than the default. */
  durationMs?: number;
}

/** True when an add failed because the native engine is stopped and the automatic restart did not work. */
export function isEngineStopped(e: unknown): boolean {
  const x = e as { code?: string; engineStopped?: boolean } | null;
  return x?.code === 'NOT_INITIALIZED' || x?.engineStopped === true;
}

/** Body for a stopped engine: the real reason, or a plain fallback when the engine gave none. */
export function engineStoppedBody(e: unknown): string {
  const x = e as { code?: string; message?: string } | null;
  const m = x?.message;
  // The bare "isn't running yet" text is what a failed restart replaces; do not show it as a reason.
  if (!m || (x?.code === 'NOT_INITIALIZED' && /isn't running/.test(m))) return empty.engineStopped.noReason;
  return m;
}

/**
 * Maps an engine add failure to plain copy. Contract: Error carries `.code`.
 * `startEngine` (when given) becomes the "Start the downloader" button of the stopped-engine notice.
 */
export function addErrorNotice(
  e: unknown,
  startEngine?: () => void,
): { duplicate: boolean; notice: AddNotice } {
  const code = (e as { code?: string } | null)?.code;
  if (code === 'DUPLICATE') {
    return { duplicate: true, notice: { tone: 'info', title: 'Already in your list' } };
  }
  if (code === 'INVALID_SOURCE') {
    return { duplicate: false, notice: { tone: 'danger', title: 'That link is not a valid torrent' } };
  }
  if (isEngineStopped(e)) {
    return {
      duplicate: false,
      notice: {
        tone: 'danger',
        title: empty.engineStopped.title,
        body: engineStoppedBody(e),
        ...(startEngine ? { actionLabel: START_ENGINE_LABEL, onAction: startEngine, durationMs: 12_000 } : {}),
      },
    };
  }
  const message = e instanceof Error && e.message ? e.message : 'Try again in a moment.';
  return { duplicate: false, notice: { tone: 'danger', title: 'Could not add the torrent', body: message } };
}

export type EngineFailureAction = 'startEngine' | 'pickFolder';

/**
 * What the "engine failed to start" screen offers first. A permission or storage failure goes to the folder
 * picker (NATIVE_CONTRACT: PERMISSION and storage errors map to "Pick folder again"); everything else restarts.
 */
export function engineFailureAction(code?: string): { action: EngineFailureAction; label: string } {
  if (code === 'PERMISSION' || code === 'DISK_FULL' || code === 'STORAGE_UNAVAILABLE') {
    return { action: 'pickFolder', label: PICK_FOLDER_LABEL };
  }
  return { action: 'startEngine', label: START_ENGINE_LABEL };
}
