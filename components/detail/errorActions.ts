// Error → action mapping for the torrent detail error banner (STATE_MACHINES_AND_SCREENS SM-36).
// Pure TS: no React import. Unknown codes fall back to the INTERNAL row.

export type ErrorAction = 'freeSpace' | 'move' | 'pickFolder' | 'filesMissing' | 'retry' | 'recheck' | 'none';

export interface ErrorActions {
  message: string;
  primary: ErrorAction;
  secondary?: ErrorAction;
}

const DISK_FULL: ErrorActions = { message: 'Storage full.', primary: 'freeSpace', secondary: 'move' };
const PERMISSION: ErrorActions = { message: "Maglev can't write to this folder.", primary: 'pickFolder' };
const FILES_MISSING: ErrorActions = { message: 'Some files are missing.', primary: 'filesMissing' };
const STORAGE_UNAVAILABLE: ErrorActions = { message: "The SD card isn't there.", primary: 'none', secondary: 'move' };
const NETWORK: ErrorActions = { message: "Can't reach anyone right now.", primary: 'retry' };
const INTERNAL: ErrorActions = { message: 'Something went wrong.', primary: 'retry', secondary: 'recheck' };

/**
 * Maps an engine error code (plus the torrent's pausedBy reason) to a banner message and buttons.
 * `storage_unavailable` is a pause reason, so it wins over the error code. Any code containing
 * TRACKER maps to the NETWORK row. Unknown codes map to INTERNAL.
 */
export function actionsFor(code: string, ctx: { pausedBy?: string | null }): ErrorActions {
  if (ctx.pausedBy === 'storage_unavailable') return { ...STORAGE_UNAVAILABLE };
  if (code === 'DISK_FULL') return { ...DISK_FULL };
  if (code === 'PERMISSION') return { ...PERMISSION };
  if (code === 'FILES_MISSING') return { ...FILES_MISSING };
  if (code === 'NETWORK' || code.includes('TRACKER')) return { ...NETWORK };
  return { ...INTERNAL };
}
