/**
 * NATIVE_CONTRACT 47.4: what Resume does for a torrent that a file health tag holds. Pure, so
 * scripts/test-resume-held.js can check it.
 *
 * A torrent held by `files_changed` or `files_missing` needs Recheck (on its page), not Resume. Resume is not
 * offered for it, "Resume all" and bulk Resume skip it, and a Resume that reaches the engine anyway explains itself.
 */
import { notices } from '../../constants/copy.ts';
import { isHeldByFiles } from './model.ts';

/** The toast action that goes to the torrent's page, where the Recheck banner is. */
export const OPEN_TORRENT_LABEL = 'Open';

export interface ResumeNotice {
  message: string;
  /** The toast carries an "Open" action that goes to the torrent's page. */
  openTorrent: boolean;
}

/**
 * The toast for a resume that failed. A file-health hold shows the engine's own message ("Files were changed after
 * downloading. Recheck them first.") with Open. Any other failure keeps the generic text.
 */
export function resumeFailureNotice(
  res: { code?: string; message?: string },
  torrent: { pausedBy?: string | null; health?: string | null } | undefined,
  label: string,
): ResumeNotice {
  const refused = res.code === 'UNSUPPORTED' || res.code === 'FILES_MISSING';
  if (refused && torrent && isHeldByFiles(torrent) && res.message) return { message: res.message, openTorrent: true };
  return { message: notices.engine.resumeFailed(label), openTorrent: false };
}

/** The torrents "Resume all" and bulk Resume act on: paused by the user (or by nothing), and not held by a file health tag. */
export function resumableIds<T extends { id: string; state: string; pausedBy?: string | null; health?: string | null }>(
  torrents: readonly T[],
  skip: (id: string) => boolean = () => false,
): string[] {
  return torrents
    .filter((t) => t.state === 'PAUSED' && (!t.pausedBy || t.pausedBy === 'user') && !isHeldByFiles(t) && !skip(t.id))
    .map((t) => t.id);
}
