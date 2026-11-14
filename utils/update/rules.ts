/**
 * Pure rules for the updater (docs/NATIVE_CONTRACT.md section 27.2, 27.3 and 27.5): what the network allows and
 * when an install is safe. No React Native imports, so Node tests run it.
 */

export interface UpdateNet {
  connected: boolean;
  /** Not NET_CAPABILITY_NOT_METERED. */
  metered: boolean;
  vpn: boolean;
}

/**
 * The automatic check and every automatic download. Same two settings search honours (Settings > Network):
 * Wi-Fi only blocks a metered link, VPN only blocks a link with no VPN. Offline blocks everything.
 */
export function networkAllows(net: UpdateNet | null, rules: { wifiOnly: boolean; vpnOnly: boolean }): boolean {
  if (!net || !net.connected) return false;
  if (rules.wifiOnly && net.metered) return false;
  if (rules.vpnOnly && !net.vpn) return false;
  return true;
}

/** The modes `download` and `auto` start without asking only on an unmetered link. */
export function autoDownloadAllowed(net: UpdateNet | null, rules: { wifiOnly: boolean; vpnOnly: boolean }): boolean {
  return networkAllows(net, rules) && net !== null && !net.metered;
}

export const UPLOAD_QUIET_MS = 60_000;

export interface SafeFacts {
  now: number;
  /** Epoch ms of the last tick on which a torrent was uploading, or null. */
  lastUploadAt: number | null;
  torrents: ReadonlyArray<{ state: string; upBps?: number }>;
  downloads: ReadonlyArray<{ state: string }>;
  /** The in-app player screen is open (setPlayerOpen). Absent means closed. */
  playerOpen?: boolean;
}

/**
 * An install restarts the app, so `auto` installs silently only when:
 *  - no torrent is downloading (or moving files) or seeding with an upload in the last 60 s;
 *  - no plain or stream download is running.
 *  - the player screen isn't open (section 30).
 */
export function safeToInstall(f: SafeFacts): boolean {
  if (f.playerOpen) return false;
  if (f.torrents.some((t) => t.state === 'DOWNLOADING' || t.state === 'MOVING')) return false;
  if (f.torrents.some((t) => t.state === 'SEEDING' && (t.upBps ?? 0) > 0)) return false;
  if (f.lastUploadAt !== null && f.now - f.lastUploadAt < UPLOAD_QUIET_MS) return false;
  if (f.downloads.some((d) => d.state === 'downloading' || d.state === 'resolving' || d.state === 'verifying')) return false;
  return true;
}

/** Whether this tick shows upload, for the 60 s window. */
export function isUploading(torrents: ReadonlyArray<{ state: string; upBps?: number }>): boolean {
  return torrents.some((t) => (t.state === 'SEEDING' || t.state === 'DOWNLOADING') && (t.upBps ?? 0) > 0);
}
