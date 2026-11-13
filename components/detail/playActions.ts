import { maglevEngine, type DetailFile } from 'maglev-engine';
import { playCopy, notices } from '../../constants/copy';
import { fileName } from './torrentLabels';
import { pickPlayFile, playPlan } from './play';

export interface PlayResult {
  ok: boolean;
  /** Plain-English reason when `ok` is false. */
  message?: string;
  /** The torrent was paused by the user and Play resumed it. */
  resumed?: boolean;
}

/**
 * Runs Play for one file (docs/contracts-0.19/play-and-storage.md section 1): open a finished file, or resume a
 * user-paused torrent and stream. No new engine call: the stream reader fetches the start of the file first.
 */
export async function playFile(
  id: string,
  file: Pick<DetailFile, 'index' | 'path' | 'length' | 'progressBytes'>,
  torrent: { state: string; pausedBy?: string | null },
  resume: () => Promise<boolean>,
): Promise<PlayResult> {
  try {
    const plan = playPlan(file, torrent);
    if (plan.kind === 'open') {
      const res = await maglevEngine.openFile(id, file.index);
      return res.ok ? { ok: true } : { ok: false, message: res.message || notices.inline.openFileFailed };
    }
    if (plan.kind === 'blocked') return { ok: false, message: plan.reason === 'storageFull' ? playCopy.storageFull : playCopy.needsResume };
    if (plan.resumeFirst && !(await resume())) return { ok: false, message: notices.inline.resumeFailed };
    const url = await maglevEngine.streamUrl(id, file.index);
    if (!url.ok) return { ok: false, message: url.message || notices.inline.streamFailed };
    const res = await maglevEngine.openStream(url.url, url.mime, fileName(file.path));
    if (!res.ok) return { ok: false, message: res.message || notices.inline.noPlayer };
    return { ok: true, resumed: plan.resumeFirst };
  } catch {
    return { ok: false, message: playCopy.failed };
  }
}

/** The card has no file list: fetch it, pick the file, then play. */
export async function playTorrentById(
  id: string,
  torrent: { state: string; pausedBy?: string | null },
  resume: () => Promise<boolean>,
): Promise<PlayResult> {
  try {
    const detail = await maglevEngine.getDetail(id);
    if (!detail.ok) return { ok: false, message: playCopy.failed };
    const file = pickPlayFile(detail.files);
    if (!file) return { ok: false, message: playCopy.noFile };
    return playFile(id, file, torrent, resume);
  } catch {
    return { ok: false, message: playCopy.failed };
  }
}
