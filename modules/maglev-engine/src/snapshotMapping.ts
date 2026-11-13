import type {
  AggregatedTelemetry,
  Detail,
  Snapshot,
  TorrentDetailData,
  TorrentTelemetry,
  TrackerInfo,
} from './MaglevEngine.types.ts';

/** Converts snake_case keys to camelCase, recursively. Idempotent on camelCase input. */
export function camelizeKeys<T = any>(value: unknown): T {
  if (Array.isArray(value)) return value.map((v) => camelizeKeys(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())] = camelizeKeys(v);
    }
    return out as T;
  }
  return value as T;
}

/** Converts camelCase keys to snake_case, recursively. Used for NativeConfig round-trips. */
export function snakeizeKeys<T = any>(value: unknown): T {
  if (Array.isArray(value)) return value.map((v) => snakeizeKeys(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)] = snakeizeKeys(v);
    }
    return out as T;
  }
  return value as T;
}

export function snapshotToTelemetry(s: Snapshot): TorrentTelemetry {
  const progressPercent = s.totalBytes > 0 ? Math.min(100, (s.progressBytes / s.totalBytes) * 100) : 0;
  return {
    id: s.id,
    name: s.name,
    state: s.state,
    finished: s.finished,
    downloadSpeedBytes: s.downBps,
    uploadSpeedBytes: s.upBps,
    progressPercent,
    downloadedBytes: s.progressBytes,
    uploadedBytes: s.uploadedBytes,
    totalSizeBytes: s.totalBytes,
    etaSeconds: s.etaSecs < 0 ? 0 : s.etaSecs,
    peersConnected: s.peersLive,
    peersTotal: s.peersSeen,
    seedsConnected: 0,
    ratio: s.ratio,
    seedDurationSeconds: s.seedingSecs,
    pausedBy: s.pausedBy,
    allowedAnyway: s.allowedAnyway ?? false,
    error: s.error,
    outputFolder: s.outputFolder,
    addedAt: s.addedAt,
    downLimitBps: s.downLimitBps ?? 0,
    upLimitBps: s.upLimitBps ?? 0,
    moveProgress: s.state === 'MOVING' ? (s.moveProgress ?? 0) : null,
    health: s.health ?? null,
    includedBytes: s.includedBytes ?? 0,
    webSeeds: s.webSeeds ?? 0,
    resolvingSecs: s.resolvingSecs ?? null,
  };
}

export function aggregateSnapshots(snapshots: Snapshot[]): AggregatedTelemetry {
  let down = 0;
  let up = 0;
  let activeDownloads = 0;
  let activeUploads = 0;
  for (const s of snapshots) {
    down += s.downBps;
    up += s.upBps;
    if (s.state === 'DOWNLOADING') activeDownloads++;
    else if (s.state === 'SEEDING') activeUploads++;
  }
  return {
    totalDownloadSpeedBytes: down,
    totalUploadSpeedBytes: up,
    activeDownloads,
    activeUploads,
    torrents: snapshots.map(snapshotToTelemetry),
  };
}

const TRACKER_STATUS: Record<string, TrackerInfo['status']> = {
  working: 'Working',
  updating: 'Announcing',
  error: 'Error',
  unknown: 'Announcing',
};

export function detailToTorrentDetail(d: Detail, pieceBitfield?: number[]): TorrentDetailData {
  const base = snapshotToTelemetry(d.snapshot);
  let verified = 0;
  if (pieceBitfield && pieceBitfield.length > 0) {
    verified = Math.round((pieceBitfield.filter((c) => c === 1).length / pieceBitfield.length) * d.pieceCount);
  } else if (d.snapshot.totalBytes > 0) {
    verified = Math.floor((d.snapshot.progressBytes / d.snapshot.totalBytes) * d.pieceCount);
  }
  return {
    ...base,
    savePath: d.snapshot.outputFolder,
    piecesTotal: d.pieceCount,
    piecesVerified: verified,
    files: d.files.map((f) => ({
      index: f.index,
      name: f.path.split('/').pop() || f.path,
      path: f.path,
      length: f.length,
      progress: f.length > 0 ? Math.min(100, (f.progressBytes / f.length) * 100) : 0,
      priority: f.priority === 'first' ? 2 : f.included ? 1 : 0,
      streamReadyBytes: f.streamReadyBytes ?? 0,
      tailReady: f.tailReady ?? false,
    })),
    trackers: d.trackers.map((t) => ({
      url: t.url,
      status: TRACKER_STATUS[t.status] ?? 'Announcing',
      seeds: 0,
      peers: 0,
      lastError: t.message ?? undefined,
    })),
  };
}

/** Plain-English text for engine error codes shown to users. Falls back to the engine's own message. */
export function engineErrorMessage(code: string, fallback = 'Something went wrong.'): string {
  switch (code) {
    case 'UNSUPPORTED':
      return "Secure (https) torrent links aren't supported yet. Download the .torrent file and open it instead.";
    case 'INVALID_SOURCE':
      return 'That is not a valid magnet link or .torrent file.';
    case 'DUPLICATE':
      return 'This torrent is already in your list.';
    case 'METADATA_TIMEOUT':
      return 'No peers answered in time. Try again later.';
    case 'DISK_FULL':
      return 'Not enough free storage.';
    case 'PERMISSION':
      return 'Maglev does not have permission to write to that folder.';
    default:
      return fallback;
  }
}
