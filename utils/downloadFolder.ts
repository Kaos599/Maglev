import type { PickFolderResult } from 'maglev-engine';

/** What the folder picker gave back for a single download. */
export type FolderPick =
  | { kind: 'cancelled' }
  /** A folder Maglev can write to directly. `path` goes to the download, `label` is what the screen shows. */
  | { kind: 'ok'; path: string; label: string }
  /** The folder is only reachable through the Android picker (no plain path), so it can't be used for one download. */
  | { kind: 'unsupported'; label: string };

/**
 * Folder for THIS download only. Uses `pickFolder`, which never becomes the default folder
 * (`pickDownloadFolder` does, and is for Settings, Storage and onboarding). The native add calls take a plain
 * path (`folder` for links, `outputFolder` for torrents), so a folder with no direct path is reported as unsupported.
 */
export async function pickFolderForThisDownload(pick: () => Promise<PickFolderResult>): Promise<FolderPick> {
  const res = await pick();
  if ('cancelled' in res) return { kind: 'cancelled' };
  const path = res.path;
  if (typeof path === 'string' && path.length > 0) return { kind: 'ok', path, label: res.displayName || path };
  return { kind: 'unsupported', label: res.displayName };
}
