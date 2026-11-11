import React, { createContext, useContext, useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { AppState, BackHandler } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import {
  aggregateSnapshots,
  detailToTorrentDetail,
  maglevEngine,
  settingsStore,
  type AddTorrentOptions,
  type AggregatedTelemetry,
  type EngineResult,
  type EngineStatus,
  type FilePriorityEntry,
  type FreeSpace,
  type Metadata,
  type NativePermissionStatus,
  type StorageStatus,
  type TorrentCompletedEvent,
  type TorrentDetailData,
  type TorrentTelemetry,
} from 'maglev-engine';
import { etaSecs, smoothRate } from '../utils/rates';
import { fromCached, loadTransferCache, saveTransferCache } from '../utils/transferCache';

/** Bundle-load time, the zero point for the cold-start log (UI spec S10.3). */
const JS_LOADED_AT = Date.now();

/** A torrent row as every screen sees it: smoothed speeds, optimistic state, cached marker. */
export type TransferTelemetry = TorrentTelemetry & {
  /** Unsmoothed engine speeds, for screens that want the raw numbers (Peers tab). */
  rawDownBps: number;
  rawUpBps: number;
  /** True while the row comes from the saved list and the engine has not answered yet. */
  lastKnown?: boolean;
  /** True while a pause or resume tap waits for the engine to confirm. */
  pending?: boolean;
};

export type TransferAggregate = Omit<AggregatedTelemetry, 'torrents'> & { torrents: TransferTelemetry[] };

/** A short message shown at the bottom of Transfers. Optional single action. */
export interface EngineNotice {
  id: number;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

/** How long an optimistic pause or resume waits for the engine before it reverts. */
export const OVERRIDE_TIMEOUT_MS = 5000;
/** How long "Removed X · Undo" stays before the engine delete runs. */
export const UNDO_WINDOW_MS = 5000;
const CACHE_SAVE_EVERY_MS = 5000;
const ERROR_NOTICE_MS = 4000;

type OverrideKind = 'pause' | 'resume';
interface Override {
  kind: OverrideKind;
  since: number;
  group: number;
}

export type FilterCategory = 'ALL' | 'DOWN' | 'UP' | 'PAUSED';

interface EngineContextType {
  telemetry: TransferAggregate;
  activeFilter: FilterCategory;
  setActiveFilter: (filter: FilterCategory) => void;
  filteredTorrents: TransferTelemetry[];
  clipboardMagnet: string | null;
  checkClipboard: () => Promise<void>;
  clearClipboardMagnet: () => void;
  pauseTorrent: (id: string) => Promise<boolean>;
  resumeTorrent: (id: string) => Promise<boolean>;
  pauseAll: () => Promise<void>;
  resumeAll: () => Promise<void>;
  deleteTorrent: (id: string, deleteFiles: boolean) => Promise<boolean>;
  /**
   * Remove from the list and keep the files. The rows vanish at once; the engine delete runs after
   * `UNDO_WINDOW_MS` unless `undoRemove` is called, or at once when the app goes to the background.
   */
  removeTorrents: (ids: string[]) => void;
  undoRemove: () => void;
  notice: EngineNotice | null;
  dismissNotice: () => void;
  /** Show a short message at the bottom of Transfers (stays across screen changes). */
  showNotice: (next: Omit<EngineNotice, 'id'>, autoDismissMs?: number | null) => void;
  /** Resolves with the torrent id. Throws an Error carrying `.code` (INVALID_SOURCE, DUPLICATE, ...) and `.id` on failure. */
  startTorrent: (
    magnetUri: string,
    savePath?: string,
    sequential?: boolean,
    selectedFileIndices?: number[]
  ) => Promise<string>;
  /** Raw contract call: never throws, returns the Result envelope. */
  addTorrent: (source: string, options?: AddTorrentOptions) => Promise<EngineResult<{ id: string; infoHash: string }>>;
  resolveMetadata: (source: string, timeoutMs?: number) => Promise<EngineResult<Metadata>>;
  setFilePriority: (id: string, fileIndex: number, priority: 0 | 1 | 2) => Promise<boolean>;
  setFilePriorities: (id: string, priorities: FilePriorityEntry[]) => Promise<EngineResult>;
  /** Result carries `retryAfterSecs` when rate limited. */
  reannounce: (id: string) => Promise<EngineResult<{ retryAfterSecs?: number }>>;
  getFreeSpace: () => Promise<EngineResult<FreeSpace>>;
  openLiveUpdateSettings: () => Promise<void>;
  /** 256 cells, contract values: 0 missing, 1 have, 2 partial. */
  getPieceBitfield: (id: string) => Promise<Uint8Array>;
  /** Cached detail. An uncached id triggers a one-off fetch; use `watchDetail` for live updates. */
  getTorrentDetail: (id: string) => TorrentDetailData | null;
  /** Starts refreshing detail for `id` on every telemetry tick. Call the returned function on unmount. */
  watchDetail: (id: string) => () => void;
  startHttpStream: (id: string, fileIndex: number) => Promise<string>;
  isNative: boolean;
  defaultStoragePath: string;
  engineStatus: EngineStatus;
  storageStatus: StorageStatus | null;
  permissionStatus: NativePermissionStatus | null;
  refreshPermissions: () => Promise<NativePermissionStatus>;
  restartRequired: boolean;
  /** Non-null when the engine fell back to a saved or default config because the supplied one was invalid. */
  configWarning: string | null;
  /** Re-attempts engine start after a failure. */
  retryEngine: () => Promise<void>;
  lastCompleted: TorrentCompletedEvent | null;
}

const EMPTY_AGGREGATE: TransferAggregate = {
  totalDownloadSpeedBytes: 0,
  totalUploadSpeedBytes: 0,
  activeDownloads: 0,
  activeUploads: 0,
  torrents: [],
};

/** The saved list as an aggregate with unknown speeds. Read once, before the engine answers. */
function cachedAggregate(): TransferAggregate {
  const cached = loadTransferCache();
  if (cached.length === 0) return EMPTY_AGGREGATE;
  const torrents = cached.map((c) => ({ ...fromCached(c), rawDownBps: 0, rawUpBps: 0, lastKnown: true }));
  return { ...EMPTY_AGGREGATE, torrents };
}

interface Smoothed {
  down: number;
  up: number;
  at: number;
}

const SMOOTHED_STATES = new Set(['DOWNLOADING', 'SEEDING']);

/** Turns engine telemetry into rows with steady speeds and a time left computed from them. */
function smoothAggregate(agg: AggregatedTelemetry, memo: Map<string, Smoothed>, now: number): TransferAggregate {
  let down = 0;
  let up = 0;
  const live = new Set<string>();
  const torrents = agg.torrents.map((t): TransferTelemetry => {
    live.add(t.id);
    const prev = memo.get(t.id);
    let sd = t.downloadSpeedBytes;
    let su = t.uploadSpeedBytes;
    if (SMOOTHED_STATES.has(t.state)) {
      const dt = prev ? now - prev.at : 0;
      sd = smoothRate(prev ? prev.down : null, t.downloadSpeedBytes, dt);
      su = smoothRate(prev ? prev.up : null, t.uploadSpeedBytes, dt);
      memo.set(t.id, { down: sd, up: su, at: now });
    } else {
      memo.delete(t.id);
    }
    down += sd;
    up += su;
    const remaining = t.totalSizeBytes > 0 ? t.totalSizeBytes - t.downloadedBytes : -1;
    const eta = t.state === 'DOWNLOADING' ? (remaining < 0 ? -1 : etaSecs(remaining, sd)) : t.etaSeconds;
    return { ...t, downloadSpeedBytes: sd, uploadSpeedBytes: su, etaSeconds: eta, rawDownBps: t.downloadSpeedBytes, rawUpBps: t.uploadSpeedBytes };
  });
  for (const id of [...memo.keys()]) if (!live.has(id)) memo.delete(id);
  return { ...agg, totalDownloadSpeedBytes: down, totalUploadSpeedBytes: up, torrents };
}

function overrideSatisfied(t: TransferTelemetry, o: Override): boolean {
  return o.kind === 'pause' ? t.state === 'PAUSED' : t.state !== 'PAUSED' && t.state !== 'ERROR';
}

function applyOverride(t: TransferTelemetry, o: Override): TransferTelemetry {
  if (o.kind === 'pause') {
    return {
      ...t,
      state: 'PAUSED',
      pausedBy: 'user',
      downloadSpeedBytes: 0,
      uploadSpeedBytes: 0,
      etaSeconds: -1,
      pending: true,
    };
  }
  const done = t.finished === true || t.progressPercent >= 100;
  return { ...t, state: done ? 'SEEDING' : 'DOWNLOADING', pausedBy: null, error: null, pending: true };
}

const EngineContext = createContext<EngineContextType | null>(null);

/** A magnet link or an http(s) link to a .torrent file. Same test for the chip and the Paste link button. */
export function isAddableLink(text: string): boolean {
  if (text.startsWith('magnet:?xt=')) return true;
  return /^https?:\/\/\S+\.torrent(?:[?#]\S*)?$/i.test(text);
}

function engineError(code: string, message: string, id?: string): Error {
  return Object.assign(new Error(message), { code, id });
}

export const EngineProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // Engine truth (or the saved list until the engine answers), before overrides and pending removals.
  const [liveTelemetry, setLiveTelemetry] = useState<TransferAggregate>(cachedAggregate);
  const [overrides, setOverrides] = useState<Record<string, Override>>({});
  const [removing, setRemoving] = useState<readonly string[]>([]);
  const [notice, setNotice] = useState<EngineNotice | null>(null);
  const [activeFilter, setActiveFilter] = useState<FilterCategory>('ALL');
  const [clipboardMagnet, setClipboardMagnet] = useState<string | null>(null);
  const [engineStatus, setEngineStatus] = useState<EngineStatus>(maglevEngine.engineStatus);
  const [restartRequired, setRestartRequired] = useState(maglevEngine.restartRequired);
  const [configWarning, setConfigWarning] = useState<string | null>(maglevEngine.configWarning);
  const [isNative, setIsNative] = useState(maglevEngine.isNativeMode());
  const [storageStatus, setStorageStatus] = useState<StorageStatus | null>(null);
  const [permissionStatus, setPermissionStatus] = useState<NativePermissionStatus | null>(null);
  const [lastCompleted, setLastCompleted] = useState<TorrentCompletedEvent | null>(null);
  const [, setDetailVersion] = useState(0);

  const detailCache = useRef<Map<string, TorrentDetailData>>(new Map());
  const watched = useRef<Map<string, number>>(new Map());
  const inFlight = useRef<Set<string>>(new Set());
  const smoothing = useRef<Map<string, Smoothed>>(new Map());
  const gotLive = useRef(false);
  const bootLogged = useRef(false);
  const noticeSeq = useRef(0);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const groupSeq = useRef(0);
  const groupTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const overridesRef = useRef(overrides);
  overridesRef.current = overrides;
  const liveRef = useRef(liveTelemetry);
  liveRef.current = liveTelemetry;
  const pendingRemoval = useRef<{ ids: string[]; names: string[]; timer: ReturnType<typeof setTimeout>; noticeId: number } | null>(null);
  const lastSave = useRef(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showNotice = useCallback((next: Omit<EngineNotice, 'id'>, autoDismissMs: number | null = ERROR_NOTICE_MS) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = null;
    const id = ++noticeSeq.current;
    setNotice({ ...next, id });
    if (autoDismissMs != null) {
      noticeTimer.current = setTimeout(() => setNotice((n) => (n && n.id === id ? null : n)), autoDismissMs);
    }
  }, []);

  const dismissNotice = useCallback(() => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = null;
    setNotice(null);
  }, []);

  /** Saves the engine's list for the next cold start, at most once every 5 s. Background forces a write. */
  const saveCacheNow = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    if (!gotLive.current) return;
    lastSave.current = Date.now();
    saveTransferCache(liveRef.current.torrents);
  }, []);

  const scheduleCacheSave = useCallback(() => {
    if (saveTimer.current) return;
    const wait = Math.max(0, CACHE_SAVE_EVERY_MS - (Date.now() - lastSave.current));
    saveTimer.current = setTimeout(saveCacheNow, wait);
  }, [saveCacheNow]);

  /** The single place where engine telemetry enters the app: smoothing happens here. */
  const ingest = useCallback(
    (snapshots: Parameters<typeof aggregateSnapshots>[0]) => {
      gotLive.current = true;
      const next = smoothAggregate(aggregateSnapshots(snapshots), smoothing.current, Date.now());
      liveRef.current = next;
      setLiveTelemetry(next);
      scheduleCacheSave();
    },
    [scheduleCacheSave]
  );

  const refreshDetail = useCallback(async (id: string) => {
    if (inFlight.current.has(id)) return;
    inFlight.current.add(id);
    try {
      const res = await maglevEngine.getDetail(id);
      if (res.ok) {
        detailCache.current.set(id, detailToTorrentDetail(res));
        setDetailVersion((v) => v + 1);
      } else if (res.code === 'NOT_FOUND') {
        detailCache.current.delete(id);
      }
    } finally {
      inFlight.current.delete(id);
    }
  }, []);

  const refreshPermissions = useCallback(async () => {
    const status = await maglevEngine.getPermissionStatus();
    setPermissionStatus(status);
    return status;
  }, []);

  const checkClipboard = useCallback(async () => {
    try {
      const content = await Clipboard.getStringAsync();
      const clip = content?.trim() ?? '';
      if (isAddableLink(clip)) {
        setClipboardMagnet(clip);
      } else {
        setClipboardMagnet(null);
      }
    } catch {
      setClipboardMagnet(null);
    }
  }, []);

  const afterStart = useCallback(
    async (status: EngineStatus) => {
      if (status.kind === 'ready') {
        const [list, storage] = await Promise.all([maglevEngine.listTorrents(), maglevEngine.getStorageStatus()]);
        if (list.ok) ingest(list.torrents);
        setStorageStatus(storage);
      }
      void refreshPermissions();
    },
    [refreshPermissions, ingest]
  );

  const retryEngine = useCallback(async () => {
    const status = await maglevEngine.retry(settingsStore.getSettings());
    setEngineStatus(maglevEngine.engineStatus);
    setConfigWarning(maglevEngine.configWarning);
    await afterStart(status);
  }, [afterStart]);

  // Engine start, status mirroring and event subscriptions. Events only: no polling.
  useEffect(() => {
    let cancelled = false;
    const syncState = () => {
      setEngineStatus(maglevEngine.engineStatus);
      setRestartRequired(maglevEngine.restartRequired);
      setConfigWarning(maglevEngine.configWarning);
      setIsNative(maglevEngine.isNativeMode());
    };
    const offState = maglevEngine.subscribeState(syncState);

    const offTelemetry = maglevEngine.onTelemetry((event) => {
      ingest(event.torrents);
      watched.current.forEach((_count, id) => {
        if (event.torrents.some((s) => s.id === id)) void refreshDetail(id);
      });
    });
    const offCompleted = maglevEngine.onTorrentCompleted((e) => setLastCompleted(e));
    const offAction = maglevEngine.onNotificationAction(async (e) => {
      // Sent once on app open after Android killed Maglev (NATIVE_CONTRACT 19). Not in the TS union yet.
      const ev = e as { action: string; message?: string };
      if (ev.action === 'stopped_by_android') {
        if (ev.message) showNotice({ message: ev.message }, 6000);
        return;
      }
      if (e.action === 'shutdown') {
        BackHandler.exitApp();
        return;
      }
      const res = await maglevEngine.listTorrents(); // pause_all / resume_all were applied natively
      if (res.ok) ingest(res.torrents);
    });
    const offStorage = maglevEngine.onStorageStatus((s) => setStorageStatus(s));

    (async () => {
      const status = await maglevEngine.start(settingsStore.getSettings());
      if (cancelled) return;
      syncState();
      await afterStart(status);
    })();

    return () => {
      cancelled = true;
      offState();
      offTelemetry();
      offCompleted();
      offAction();
      offStorage();
    };
  }, [refreshDetail, afterStart, ingest, showNotice]);

  // Clipboard and permissions are re-read whenever the app returns to the foreground.
  useEffect(() => {
    void checkClipboard();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        void checkClipboard();
        void refreshPermissions();
      }
    });
    return () => sub.remove();
  }, [checkClipboard, refreshPermissions]);

  const clearClipboardMagnet = useCallback(() => {
    setClipboardMagnet(null);
  }, []);

  // Engine rows with optimistic pause/resume applied and pending removals hidden.
  const telemetry = useMemo<TransferAggregate>(() => {
    const hasOverrides = Object.keys(overrides).length > 0;
    if (!hasOverrides && removing.length === 0) return liveTelemetry;
    const hidden = new Set(removing);
    const torrents: TransferTelemetry[] = [];
    let down = 0;
    let up = 0;
    let activeDownloads = 0;
    let activeUploads = 0;
    for (const t of liveTelemetry.torrents) {
      if (hidden.has(t.id)) continue;
      const o = overrides[t.id];
      const row = o && !overrideSatisfied(t, o) ? applyOverride(t, o) : t;
      down += row.downloadSpeedBytes;
      up += row.uploadSpeedBytes;
      if (row.state === 'DOWNLOADING') activeDownloads++;
      else if (row.state === 'SEEDING') activeUploads++;
      torrents.push(row);
    }
    return { totalDownloadSpeedBytes: down, totalUploadSpeedBytes: up, activeDownloads, activeUploads, torrents };
  }, [liveTelemetry, overrides, removing]);

  // Overrides end as soon as the engine reports the expected state (or the torrent is gone).
  useEffect(() => {
    const current = overridesRef.current;
    const ids = Object.keys(current);
    if (ids.length === 0) return;
    const byId = new Map(liveTelemetry.torrents.map((t) => [t.id, t]));
    const done = ids.filter((id) => {
      const t = byId.get(id);
      return !t || overrideSatisfied(t, current[id]);
    });
    if (done.length === 0) return;
    setOverrides((prev) => {
      const next = { ...prev };
      for (const id of done) delete next[id];
      return next;
    });
  }, [liveTelemetry]);

  // First row on screen, from the saved list or from the engine. Read in adb logcat to measure cold start.
  useEffect(() => {
    if (bootLogged.current || telemetry.torrents.length === 0) return;
    bootLogged.current = true;
    // Hermes performance.now() counts from device boot, so measure from bundle load instead.
    console.log('[Maglev] boot', Date.now() - JS_LOADED_AT);
  }, [telemetry.torrents.length]);

  const filteredTorrents = useMemo(() => {
    switch (activeFilter) {
      case 'DOWN':
        return telemetry.torrents.filter(
          (t) => t.state === 'DOWNLOADING' || t.state === 'QUEUED' || t.state === 'INITIALIZING' || t.state === 'CHECKING'
        );
      case 'UP':
        return telemetry.torrents.filter((t) => t.state === 'SEEDING' || t.state === 'COMPLETED');
      case 'PAUSED':
        return telemetry.torrents.filter((t) => t.state === 'PAUSED');
      case 'ALL':
      default:
        return telemetry.torrents;
    }
  }, [telemetry.torrents, activeFilter]);

  const nameOf = useCallback((id: string) => liveRef.current.torrents.find((t) => t.id === id)?.name ?? 'torrent', []);

  const failGroup = useCallback(
    (group: number, kind: OverrideKind, label: string) => {
      const stuck = Object.entries(overridesRef.current)
        .filter(([, o]) => o.group === group)
        .map(([id]) => id);
      if (stuck.length === 0) return;
      setOverrides((prev) => {
        const next = { ...prev };
        for (const id of stuck) delete next[id];
        return next;
      });
      showNotice({ message: `Couldn't ${kind} ${label}. Try again.` });
    },
    [showNotice]
  );

  /** Marks torrents as pausing or resuming right now. Reverts after 5 s if the engine never confirms. */
  const startOverrides = useCallback(
    (ids: string[], kind: OverrideKind, label: string): number => {
      const group = ++groupSeq.current;
      const since = Date.now();
      setOverrides((prev) => {
        const next = { ...prev };
        for (const id of ids) next[id] = { kind, since, group };
        return next;
      });
      const timer = setTimeout(() => {
        groupTimers.current.delete(group);
        failGroup(group, kind, label);
      }, OVERRIDE_TIMEOUT_MS);
      groupTimers.current.set(group, timer);
      return group;
    },
    [failGroup]
  );

  const pauseTorrent = useCallback(
    async (id: string) => {
      if (overridesRef.current[id]) return false; // a tap is already in flight
      const label = nameOf(id);
      const group = startOverrides([id], 'pause', label);
      const ok = (await maglevEngine.pause(id)).ok;
      if (!ok) failGroup(group, 'pause', label);
      return ok;
    },
    [nameOf, startOverrides, failGroup]
  );
  const resumeTorrent = useCallback(
    async (id: string) => {
      if (overridesRef.current[id]) return false;
      const label = nameOf(id);
      const group = startOverrides([id], 'resume', label);
      const ok = (await maglevEngine.resume(id)).ok;
      if (!ok) failGroup(group, 'resume', label);
      return ok;
    },
    [nameOf, startOverrides, failGroup]
  );
  const pauseAll = useCallback(async () => {
    const ids = liveRef.current.torrents
      .filter((t) => (t.state === 'DOWNLOADING' || t.state === 'SEEDING' || t.state === 'QUEUED') && !overridesRef.current[t.id])
      .map((t) => t.id);
    const group = startOverrides(ids, 'pause', 'all');
    const res = await maglevEngine.pauseAll();
    if (!res.ok) failGroup(group, 'pause', 'all');
  }, [startOverrides, failGroup]);
  const resumeAll = useCallback(async () => {
    const ids = liveRef.current.torrents
      .filter((t) => t.state === 'PAUSED' && (!t.pausedBy || t.pausedBy === 'user') && !overridesRef.current[t.id])
      .map((t) => t.id);
    const group = startOverrides(ids, 'resume', 'all');
    const res = await maglevEngine.resumeAll();
    if (!res.ok) failGroup(group, 'resume', 'all');
  }, [startOverrides, failGroup]);
  const deleteTorrent = useCallback(async (id: string, deleteFiles: boolean) => {
    detailCache.current.delete(id);
    watched.current.delete(id);
    return (await maglevEngine.delete(id, deleteFiles)).ok;
  }, []);

  /** Runs the engine delete for removals whose undo window ended. Failed rows come back with a notice. */
  const runRemoval = useCallback(
    async (ids: string[], names: string[]) => {
      const results = await Promise.all(
        ids.map(async (id) => {
          detailCache.current.delete(id);
          watched.current.delete(id);
          return (await maglevEngine.delete(id, false)).ok;
        })
      );
      const gone = ids.filter((_, i) => results[i]);
      if (gone.length > 0) {
        for (const id of gone) smoothing.current.delete(id);
        const goneSet = new Set(gone);
        setLiveTelemetry((prev) => {
          const next = { ...prev, torrents: prev.torrents.filter((t) => !goneSet.has(t.id)) };
          liveRef.current = next;
          return next;
        });
      }
      setRemoving((prev) => prev.filter((id) => !ids.includes(id)));
      const failedAt = results.findIndex((ok) => !ok);
      if (failedAt >= 0) {
        const failed = results.filter((ok) => !ok).length;
        showNotice({ message: failed === 1 ? `Couldn't remove ${names[failedAt]}. Try again.` : `Couldn't remove ${failed} torrents. Try again.` });
      }
    },
    [showNotice]
  );

  const flushRemoval = useCallback(() => {
    const p = pendingRemoval.current;
    if (!p) return;
    clearTimeout(p.timer);
    pendingRemoval.current = null;
    setNotice((n) => (n && n.id === p.noticeId ? null : n));
    void runRemoval(p.ids, p.names);
  }, [runRemoval]);

  const undoRemove = useCallback(() => {
    const p = pendingRemoval.current;
    if (!p) return;
    clearTimeout(p.timer);
    pendingRemoval.current = null;
    setRemoving((prev) => prev.filter((id) => !p.ids.includes(id)));
    setNotice((n) => (n && n.id === p.noticeId ? null : n));
  }, []);

  const removeTorrents = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      flushRemoval(); // a second removal ends the first one's undo window
      const names = ids.map(nameOf);
      setRemoving((prev) => [...prev, ...ids]);
      const timer = setTimeout(flushRemoval, UNDO_WINDOW_MS);
      const noticeId = noticeSeq.current + 1;
      pendingRemoval.current = { ids, names, timer, noticeId };
      showNotice(
        {
          message: ids.length === 1 ? `Removed ${names[0]}` : `Removed ${ids.length} torrents`,
          actionLabel: 'Undo',
          onAction: undoRemove,
        },
        null
      );
    },
    [flushRemoval, nameOf, showNotice, undoRemove]
  );

  // Leaving the app ends any undo window at once and saves the list for the next cold start.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background' || next === 'inactive') {
        flushRemoval();
        saveCacheNow();
      }
    });
    return () => sub.remove();
  }, [flushRemoval, saveCacheNow]);

  useEffect(() => {
    const timers = groupTimers.current;
    return () => {
      timers.forEach(clearTimeout);
      timers.clear();
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  const defaultStoragePath = storageStatus?.path || settingsStore.getSettings().storage.defaultPath;

  const addTorrent = useCallback(
    (source: string, options: AddTorrentOptions = {}) => maglevEngine.addTorrent(source, options),
    []
  );

  const resolveMetadata = useCallback(
    (source: string, timeoutMs: number = 30_000) => maglevEngine.resolveMetadata(source, timeoutMs),
    []
  );

  const startTorrent = useCallback(
    async (magnetUri: string, savePath?: string, sequential: boolean = false, selectedFileIndices?: number[]) => {
      const res = await maglevEngine.addTorrent(magnetUri, {
        // The engine owns the default folder (storage policy); only pass an explicit override.
        outputFolder: savePath && savePath !== defaultStoragePath ? savePath : null,
        sequential,
        onlyFiles: selectedFileIndices && selectedFileIndices.length > 0 ? selectedFileIndices : null,
      });
      if (res.ok === false) throw engineError(res.code, res.message, res.id);
      return res.id;
    },
    [defaultStoragePath]
  );

  const setFilePriority = useCallback(
    async (id: string, fileIndex: number, priority: 0 | 1 | 2) => {
      let detail = detailCache.current.get(id);
      if (!detail) {
        await refreshDetail(id);
        detail = detailCache.current.get(id);
      }
      if (!detail) return false;
      const included = detail.files
        .filter((f) => (f.index === fileIndex ? priority > 0 : f.priority > 0))
        .map((f) => f.index);
      return (await maglevEngine.setIncludedFiles(id, included)).ok;
    },
    [refreshDetail]
  );

  const setFilePriorities = useCallback(
    (id: string, priorities: FilePriorityEntry[]) => maglevEngine.setFilePriorities(id, priorities),
    []
  );
  const reannounce = useCallback((id: string) => maglevEngine.reannounce(id), []);
  const getFreeSpace = useCallback(() => maglevEngine.getFreeSpace(), []);
  const openLiveUpdateSettings = useCallback(() => maglevEngine.openLiveUpdateSettings(), []);

  const getPieceBitfield = useCallback(async (id: string) => {
    const cells = await maglevEngine.getPieceBitfield(id);
    const out = new Uint8Array(256);
    for (let i = 0; i < 256 && i < cells.length; i++) out[i] = cells[i];
    return out;
  }, []);

  const getTorrentDetail = useCallback(
    (id: string) => {
      if (!id) return null;
      const cached = detailCache.current.get(id);
      if (!cached) void refreshDetail(id);
      return cached ?? null;
    },
    [refreshDetail]
  );

  const watchDetail = useCallback(
    (id: string) => {
      watched.current.set(id, (watched.current.get(id) ?? 0) + 1);
      void refreshDetail(id);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const n = (watched.current.get(id) ?? 1) - 1;
        if (n <= 0) {
          watched.current.delete(id);
          detailCache.current.delete(id);
        } else {
          watched.current.set(id, n);
        }
      };
    },
    [refreshDetail]
  );

  const startHttpStream = useCallback(async (id: string, fileIndex: number) => {
    const res = await maglevEngine.streamUrl(id, fileIndex);
    if (res.ok === false) throw engineError(res.code, res.message);
    return res.url;
  }, []);

  return (
    <EngineContext.Provider
      value={{
        telemetry,
        activeFilter,
        setActiveFilter,
        filteredTorrents,
        clipboardMagnet,
        checkClipboard,
        clearClipboardMagnet,
        pauseTorrent,
        resumeTorrent,
        pauseAll,
        resumeAll,
        deleteTorrent,
        removeTorrents,
        undoRemove,
        notice,
        dismissNotice,
        showNotice,
        startTorrent,
        addTorrent,
        resolveMetadata,
        setFilePriority,
        setFilePriorities,
        reannounce,
        getFreeSpace,
        openLiveUpdateSettings,
        getPieceBitfield,
        getTorrentDetail,
        watchDetail,
        startHttpStream,
        isNative,
        defaultStoragePath,
        engineStatus,
        storageStatus,
        permissionStatus,
        refreshPermissions,
        restartRequired,
        configWarning,
        retryEngine,
        lastCompleted,
      }}
    >
      {children}
    </EngineContext.Provider>
  );
};

export function useMaglevEngine(): EngineContextType {
  const ctx = useContext(EngineContext);
  if (!ctx) {
    throw new Error('useMaglevEngine must be used within an EngineProvider');
  }
  return ctx;
}
