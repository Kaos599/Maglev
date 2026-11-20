import React, { createContext, useContext, useEffect, useState, useCallback, useRef, useMemo, useSyncExternalStore } from 'react';
import { AccessibilityInfo, AppState, BackHandler, Platform } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import {
  aggregateSnapshots,
  detailToTorrentDetail,
  maglevEngine,
  settingsStore,
  type AddTorrentOptions,
  type AggregatedTelemetry,
  type DownloadOptions,
  type StreamProbe,
  type DownloadSnapshot,
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
  type UrlProbe,
} from 'maglev-engine';
import { etaSecs, smoothRate } from '../utils/rates';
import { fromCached, readTransferCache, saveTransferCache } from '../utils/transferCache';
import {
  EMPTY_PENDING,
  applyPending,
  beginPending,
  confirmGroup,
  failGroup as dropGroup,
  nextExpiry,
  settlePending,
  type PendingKind,
  type PendingMap,
} from '../utils/optimistic';
import { shareRows } from '../components/transfers/snapshots';
import { router } from 'expo-router';
import { notices } from '../constants/copy';
import { OPEN_TORRENT_LABEL, resumableIds, resumeFailureNotice } from '../components/transfers/resumeRules';
import { isAddableLink } from '../utils/addableLink';
import { noteRemoved, recordSnapshot } from '../utils/stats';
import { getCatchCopiedLinks } from '../utils/prefs/clipboard';
import { smoothDownloadsSpeed } from '../utils/downloadCopy';
import { UNDO_BASE_MS, undoWindowMs } from '../utils/undoWindow';

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
  /** What the pending tap was. 'resume' keeps the engine's state: show "Resuming…", not a guessed state. */
  pendingAction?: PendingKind;
};

export type TransferAggregate = Omit<AggregatedTelemetry, 'torrents'> & { torrents: TransferTelemetry[] };

/** A short message shown at the bottom of Transfers. Optional single action. */
export interface EngineNotice {
  id: number;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

/** How long an optimistic pause, resume or remove holds the row before telemetry is trusted again. */
const OVERRIDE_TIMEOUT_MS = 5000;
/** How long "Removed X · Undo" stays before the engine delete runs. */
export const UNDO_WINDOW_MS = UNDO_BASE_MS;
const CACHE_SAVE_EVERY_MS = 5000;
const ERROR_NOTICE_MS = 4000;

interface EngineContextType {
  telemetry: TransferAggregate;
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
  /** Removes torrents and link downloads together, keeping files, behind one Undo notice. */
  removeTransfers: (torrentIds: string[], downloadIds: string[]) => void;
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
  /** True while the phone is on mobile data (any link that is not unmetered Wi-Fi or Ethernet). Refreshed when the app comes back. */
  onMeteredNetwork: boolean;
  /** False only when the phone itself reports no connection (NATIVE_CONTRACT 44.15 D8). Unknown counts as online. */
  networkOnline: boolean;
  /** True once the torrent and link lists came from the engine this session, not from the saved cache (44.15 F2). */
  listsLive: boolean;
  openLiveUpdateSettings: () => Promise<void>;
  /** 256 cells, contract values: 0 missing, 1 have, 2 partial. */
  getPieceBitfield: (id: string) => Promise<Uint8Array>;
  /** Cached detail. An uncached id triggers a one-off fetch; use `watchDetail` for live updates. */
  getTorrentDetail: (id: string) => TorrentDetailData | null;
  /** Starts refreshing detail for `id` on every telemetry tick. Call the returned function on unmount. */
  watchDetail: (id: string) => () => void;
  startHttpStream: (id: string, fileIndex: number) => Promise<string>;
  isNative: boolean;
  /**
   * True when a list was saved on an earlier run (it may be empty). Read once at launch.
   * With it, an onboarded user sees Transfers at once and the engine starts after that first frame.
   */
  hasCachedList: boolean;
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
  /** The "Start engine" button: restarts the native engine. Resolves true when it runs. */
  restartEngine: () => Promise<boolean>;
  lastCompleted: TorrentCompletedEvent | null;
  /** Downloads from http(s) links (NATIVE_CONTRACT 17), oldest first. */
  downloads: DownloadSnapshot[];
  /** Never throws: returns the Result envelope. Nothing is stored. */
  probeUrl: (url: string, options?: DownloadOptions) => Promise<EngineResult<UrlProbe>>;
  /** Qualities, audio tracks and size estimates of an HLS or DASH link (NATIVE_CONTRACT 24.8). Nothing is stored. */
  probeStream: (url: string, options?: DownloadOptions) => Promise<EngineResult<StreamProbe>>;
  startDownload: (url: string, options?: DownloadOptions) => Promise<EngineResult<{ id: string }>>;
  pauseDownload: (id: string) => Promise<boolean>;
  resumeDownload: (id: string) => Promise<boolean>;
  /** After a changed file this restarts from zero. */
  retryDownload: (id: string) => Promise<boolean>;
  /** Limit for one link download in bytes per second, 0 = no limit. */
  setDownloadLimits: (id: string, downLimitBps: number) => Promise<boolean>;
  removeDownload: (id: string, deleteFiles: boolean) => Promise<boolean>;
  refreshDownloadUrl: (id: string, url: string) => Promise<EngineResult>;
}

type ActionKeys =
  | 'checkClipboard' | 'clearClipboardMagnet' | 'pauseTorrent' | 'resumeTorrent' | 'pauseAll' | 'resumeAll'
  | 'deleteTorrent' | 'removeTorrents' | 'removeTransfers' | 'undoRemove' | 'dismissNotice' | 'showNotice'
  | 'startTorrent' | 'addTorrent' | 'resolveMetadata' | 'setFilePriority' | 'setFilePriorities' | 'reannounce'
  | 'getFreeSpace' | 'openLiveUpdateSettings' | 'getPieceBitfield' | 'getTorrentDetail' | 'watchDetail'
  | 'startHttpStream' | 'refreshPermissions' | 'retryEngine' | 'restartEngine' | 'probeUrl' | 'probeStream'
  | 'startDownload' | 'pauseDownload' | 'resumeDownload' | 'retryDownload' | 'setDownloadLimits'
  | 'removeDownload' | 'refreshDownloadUrl';

/** Every function the engine offers. Identities never change, so reading this never re-renders on a tick. */
export type EngineActions = Pick<EngineContextType, ActionKeys>;
/** Engine start state only. Changes at start, restart and failure, never on a telemetry tick. */
export type EngineStatusValue = Pick<EngineContextType, 'engineStatus' | 'hasCachedList'>;
/** Rows, link downloads and whether they came from the engine. Changes on a telemetry tick. */
export type EngineTelemetryValue = Pick<EngineContextType, 'telemetry' | 'downloads' | 'listsLive'>;
/** Slow-moving state: network, storage, permissions, clipboard. */
export type EngineStateValue = Pick<
  EngineContextType,
  | 'clipboardMagnet' | 'onMeteredNetwork' | 'networkOnline' | 'isNative' | 'defaultStoragePath'
  | 'storageStatus' | 'permissionStatus' | 'restartRequired' | 'configWarning'
>;
type EngineNoticeValue = Pick<EngineContextType, 'notice'>;
type EngineCompletedValue = Pick<EngineContextType, 'lastCompleted'>;

/**
 * Detail refresh counter outside React state: bumping it re-renders only components that read
 * `useDetailVersion()`, not the whole provider tree.
 */
const detailStore = (() => {
  let version = 0;
  const listeners = new Set<() => void>();
  return {
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    getSnapshot: () => version,
    bump() {
      version++;
      listeners.forEach((fn) => fn());
    },
  };
})();

/** Re-renders the caller each time cached detail was refreshed. Detail screens use it; nothing else should. */
export function useDetailVersion(): number {
  return useSyncExternalStore(detailStore.subscribe, detailStore.getSnapshot, detailStore.getSnapshot);
}

const EMPTY_AGGREGATE: TransferAggregate = {
  totalDownloadSpeedBytes: 0,
  totalUploadSpeedBytes: 0,
  activeDownloads: 0,
  activeUploads: 0,
  torrents: [],
};

/** The saved list as an aggregate with unknown speeds, or null when none was ever saved. Read once, before the engine answers. */
function cachedAggregate(): TransferAggregate | null {
  const cached = readTransferCache();
  if (cached === null) return null;
  if (cached.length === 0) return EMPTY_AGGREGATE;
  const torrents = cached.map((c) => ({ ...fromCached(c), rawDownBps: 0, rawUpBps: 0, lastKnown: true }));
  return { ...EMPTY_AGGREGATE, torrents };
}

/**
 * Runs `fn` once the frame being rendered now has been handed to the screen: the next animation
 * frame, then a macrotask so the work lands after that frame's commit, not inside it.
 * (InteractionManager is removed in React Native 0.88: node_modules/react-native/index.js.)
 */
function afterFirstFrame(fn: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const raf = requestAnimationFrame(() => {
    timer = setTimeout(fn, 0);
  });
  return () => {
    cancelAnimationFrame(raf);
    if (timer) clearTimeout(timer);
  };
}

interface Smoothed {
  down: number;
  up: number;
  at: number;
}

/** Only an explicit background counts as away: an unknown state at launch must still paint. */
const isAway = () => AppState.currentState === 'background';

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

const EngineActionsContext = createContext<EngineActions | null>(null);
const EngineStatusContext = createContext<EngineStatusValue | null>(null);
const EngineTelemetryContext = createContext<EngineTelemetryValue | null>(null);
const EngineStateContext = createContext<EngineStateValue | null>(null);
const EngineNoticeContext = createContext<EngineNoticeValue | null>(null);
const EngineCompletedContext = createContext<EngineCompletedValue | null>(null);

export { isAddableLink };

function engineError(code: string, message: string, id?: string, engineStopped?: boolean): Error {
  return Object.assign(new Error(message), { code, id, engineStopped });
}

export const EngineProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // The saved list is read once, on the first render, so the first frame can show it.
  const boot = useRef<{ cached: TransferAggregate | null } | null>(null);
  if (boot.current === null) {
    boot.current = { cached: cachedAggregate() };
    // The start below can wait a frame (cached boot) and child screens mount before it runs: a shared link
    // that calls the engine in that gap waits for the start instead of failing with "Engine not started".
    maglevEngine.expectStart();
  }
  const hasCachedList = boot.current.cached !== null;
  // Engine truth (or the saved list until the engine answers), before pending taps and removals.
  const [liveTelemetry, setLiveTelemetry] = useState<TransferAggregate>(() => boot.current?.cached ?? EMPTY_AGGREGATE);
  // Optimistic pause / resume / remove (utils/optimistic.ts). The ref is the synchronous copy.
  const [pending, setPendingState] = useState<PendingMap>(EMPTY_PENDING);
  const pendingRef = useRef<PendingMap>(EMPTY_PENDING);
  const [removing, setRemoving] = useState<readonly string[]>([]);
  const [notice, setNotice] = useState<EngineNotice | null>(null);
  const [clipboardMagnet, setClipboardMagnet] = useState<string | null>(null);
  const [engineStatus, setEngineStatus] = useState<EngineStatus>(maglevEngine.engineStatus);
  const [restartRequired, setRestartRequired] = useState(maglevEngine.restartRequired);
  const [configWarning, setConfigWarning] = useState<string | null>(maglevEngine.configWarning);
  const [isNative, setIsNative] = useState(maglevEngine.isNativeMode());
  const [storageStatus, setStorageStatus] = useState<StorageStatus | null>(null);
  const [permissionStatus, setPermissionStatus] = useState<NativePermissionStatus | null>(null);
  const [lastCompleted, setLastCompleted] = useState<TorrentCompletedEvent | null>(null);
  const [allDownloads, setDownloads] = useState<DownloadSnapshot[]>([]);
  // Link downloads hidden while their undo window runs (or after a confirmed removal).
  const [removingDl, setRemovingDl] = useState<readonly string[]>([]);
  const downloads = useMemo(() => (removingDl.length === 0 ? allDownloads : allDownloads.filter((d) => !removingDl.includes(d.id))), [allDownloads, removingDl]);

  const detailCache = useRef<Map<string, TorrentDetailData>>(new Map());
  const watched = useRef<Map<string, number>>(new Map());
  const inFlight = useRef<Set<string>>(new Set());
  const smoothing = useRef<Map<string, Smoothed>>(new Map());
  const gotLive = useRef(false);
  const [listsLive, setListsLive] = useState(false);
  const bootLogged = useRef(false);
  const noticeSeq = useRef(0);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const groupSeq = useRef(0);
  const liveRef = useRef(liveTelemetry);
  // Rows that arrived in the background live only in the refs until the app is active again.
  const heldWhileAway = useRef(false);
  if (!heldWhileAway.current) liveRef.current = liveTelemetry;
  const downloadsRef = useRef<DownloadSnapshot[]>([]);
  // Smoothed total of running link downloads, added to the torrents' total in the header.
  const linkSmoothing = useRef(new Map<string, Smoothed>());
  const linkDownRef = useRef(0);
  const [linkDown, setLinkDown] = useState(0);
  const pendingRemoval = useRef<{ ids: string[]; downloadIds: string[]; names: string[]; timer: ReturnType<typeof setTimeout>; noticeId: number } | null>(null);
  // Android's accessibility timeout for the Undo window, read ahead (it is async) and refreshed when the app returns.
  const undoMs = useRef(UNDO_WINDOW_MS);
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const read = () =>
      void AccessibilityInfo.getRecommendedTimeoutMillis(UNDO_WINDOW_MS)
        .then((ms) => { undoMs.current = undoWindowMs(ms, UNDO_WINDOW_MS); })
        .catch(() => { undoMs.current = UNDO_WINDOW_MS; });
    read();
    const sub = AppState.addEventListener('change', (next) => { if (next === 'active') read(); });
    return () => sub.remove();
  }, []);
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

  /** Every change to the pending map goes through here, so the ref and React state never disagree. */
  const updatePending = useCallback((fn: (m: PendingMap) => PendingMap) => {
    const next = fn(pendingRef.current);
    if (next === pendingRef.current) return;
    pendingRef.current = next;
    setPendingState(next);
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

  /**
   * The single place where engine telemetry enters the app: smoothing happens here.
   * The engine sends fresh objects every second. Unchanged rows keep their previous object and an
   * unchanged list skips `setState`, so an idle list renders nothing (before: one full render per
   * tick). In the background the rows are kept for the cache but React is not told until the app
   * is active again.
   */
  const ingest = useCallback(
    (snapshots: Parameters<typeof aggregateSnapshots>[0]) => {
      gotLive.current = true;
      setListsLive(true);
      const prev = liveRef.current;
      const now = Date.now();
      const smoothed = smoothAggregate(aggregateSnapshots(snapshots), smoothing.current, now);
      // Only engine data settles a pending tap: a local change (a deleted row dropped) must not,
      // and a stale tick that still shows the old state changes nothing (utils/optimistic.ts).
      updatePending((m) => settlePending(m, smoothed.torrents, now, OVERRIDE_TIMEOUT_MS));
      const torrents = shareRows(prev.torrents, smoothed.torrents) as TransferTelemetry[];
      const same =
        torrents === prev.torrents &&
        smoothed.totalDownloadSpeedBytes === prev.totalDownloadSpeedBytes &&
        smoothed.totalUploadSpeedBytes === prev.totalUploadSpeedBytes &&
        smoothed.activeDownloads === prev.activeDownloads &&
        smoothed.activeUploads === prev.activeUploads;
      if (same) return;
      const next = { ...smoothed, torrents };
      liveRef.current = next;
      if (!isAway()) setLiveTelemetry(next);
      else heldWhileAway.current = true;
      scheduleCacheSave();
    },
    [scheduleCacheSave, updatePending]
  );

  /** Link downloads: same rule as torrents. */
  const ingestDownloads = useCallback((list: DownloadSnapshot[]) => {
    const shared = shareRows(downloadsRef.current, list) as DownloadSnapshot[];
    if (shared === downloadsRef.current) return;
    downloadsRef.current = shared;
    linkDownRef.current = smoothDownloadsSpeed(shared, linkSmoothing.current, Date.now());
    if (!isAway()) {
      setDownloads(shared);
      setLinkDown(linkDownRef.current);
    } else heldWhileAway.current = true;
  }, []);

  // Back in the foreground: hand React whatever arrived while away.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background' || !heldWhileAway.current) return;
      heldWhileAway.current = false;
      setLiveTelemetry(liveRef.current);
      setDownloads(downloadsRef.current);
      setLinkDown(linkDownRef.current);
    });
    return () => sub.remove();
  }, []);

  const refreshDetail = useCallback(async (id: string) => {
    if (inFlight.current.has(id)) return;
    inFlight.current.add(id);
    try {
      const res = await maglevEngine.getDetail(id);
      if (res.ok) {
        detailCache.current.set(id, detailToTorrentDetail(res));
        detailStore.bump();
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
    // Off: never read it. Android 13+ shows a notice on every read.
    if (!getCatchCopiedLinks()) {
      setClipboardMagnet(null);
      return;
    }
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
        if (list.ok) {
          ingest(list.torrents);
          if (list.downloads) ingestDownloads(list.downloads);
          void recordSnapshot(list.torrents, list.downloads);
        }
        setStorageStatus(storage);
      }
      void refreshPermissions();
    },
    [refreshPermissions, ingest, ingestDownloads]
  );

  const retryEngine = useCallback(async () => {
    await maglevEngine.restart(settingsStore.getSettings());
    setEngineStatus(maglevEngine.engineStatus);
    setConfigWarning(maglevEngine.configWarning);
    await afterStart(maglevEngine.engineStatus);
  }, [afterStart]);

  const restartEngine = useCallback(async () => {
    const res = await maglevEngine.restart(settingsStore.getSettings());
    setEngineStatus(maglevEngine.engineStatus);
    setConfigWarning(maglevEngine.configWarning);
    if (res.ok) await afterStart(maglevEngine.engineStatus);
    return res.ok;
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
      if (event.downloads) ingestDownloads(event.downloads);
      void recordSnapshot(event.torrents, event.downloads);
      // Detail screens are not on screen in the background; they refresh on the next tick back.
      if (isAway()) return;
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
      if (res.ok) {
        ingest(res.torrents);
        if (res.downloads) ingestDownloads(res.downloads);
      }
    });
    const offStorage = maglevEngine.onStorageStatus((s) => setStorageStatus(s));

    const start = async () => {
      const status = await maglevEngine.start(settingsStore.getSettings());
      if (cancelled) return;
      syncState();
      await afterStart(status);
    };
    // With a saved list the shell (tabs + last-known rows) paints first and the engine starts
    // right after that frame, so its init and first list do not compete with the first paint.
    // Without one (first launch, onboarding) the screen waits on the engine anyway: start now.
    const cancelStart = hasCachedList && settingsStore.getSettings().onboarded ? afterFirstFrame(() => void start()) : null;
    if (!cancelStart) void start();

    return () => {
      cancelled = true;
      cancelStart?.();
      offState();
      offTelemetry();
      offCompleted();
      offAction();
      offStorage();
    };
  }, [refreshDetail, afterStart, ingest, ingestDownloads, showNotice, hasCachedList]);

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

  // Engine rows with pending taps applied (utils/optimistic.ts) and undo-window removals hidden.
  const torrentTelemetry = useMemo<TransferAggregate>(() => {
    const torrents = applyPending(liveTelemetry.torrents, pending, removing.length > 0 ? new Set(removing) : undefined);
    if (torrents === liveTelemetry.torrents) return liveTelemetry;
    let down = 0;
    let up = 0;
    let activeDownloads = 0;
    let activeUploads = 0;
    for (const row of torrents) {
      down += row.downloadSpeedBytes;
      up += row.uploadSpeedBytes;
      if (row.state === 'DOWNLOADING') activeDownloads++;
      else if (row.state === 'SEEDING') activeUploads++;
    }
    return { totalDownloadSpeedBytes: down, totalUploadSpeedBytes: up, activeDownloads, activeUploads, torrents };
  }, [liveTelemetry, pending, removing]);

  // The header total counts running link downloads too, not only torrents.
  const telemetry = useMemo<TransferAggregate>(
    () => (linkDown > 0 ? { ...torrentTelemetry, totalDownloadSpeedBytes: torrentTelemetry.totalDownloadSpeedBytes + linkDown } : torrentTelemetry),
    [torrentTelemetry, linkDown],
  );

  // A pending tap ends when engine telemetry agrees (settled in `ingest`), or when it is older than
  // OVERRIDE_TIMEOUT_MS: then telemetry is trusted again, silently. A failed engine call says so
  // itself (endTap); a slow confirmation is not an error.
  useEffect(() => {
    const at = nextExpiry(pending, OVERRIDE_TIMEOUT_MS);
    if (at === null) return;
    const t = setTimeout(
      () => updatePending((m) => settlePending(m, liveRef.current.torrents, Date.now(), OVERRIDE_TIMEOUT_MS)),
      Math.max(0, at - Date.now())
    );
    return () => clearTimeout(t);
  }, [pending, updatePending]);

  // First row on screen, from the saved list or from the engine. Read in adb logcat to measure cold start.
  useEffect(() => {
    if (bootLogged.current || telemetry.torrents.length === 0) return;
    bootLogged.current = true;
    // Hermes performance.now() counts from device boot, so measure from bundle load instead.
    console.log('[Maglev] boot', Date.now() - JS_LOADED_AT);
    // Device perf marker: read against the logcat timestamp of ActivityTaskManager's START line.
    console.log('[maglev-perf] list-ready');
  }, [telemetry.torrents.length]);

  const engineReadyLogged = useRef(false);
  useEffect(() => {
    if (engineReadyLogged.current || engineStatus.kind !== 'ready') return;
    engineReadyLogged.current = true;
    console.log('[maglev-perf] engine-ready');
  }, [engineStatus.kind]);

  const nameOf = useCallback((id: string) => liveRef.current.torrents.find((t) => t.id === id)?.name ?? 'torrent', []);

  /** Shows the rows as `kind` now. Returns the group to confirm or fail when the engine answers. */
  const beginTap = useCallback(
    (ids: string[], kind: PendingKind): number => {
      const group = ++groupSeq.current;
      updatePending((m) => beginPending(m, ids, kind, group, Date.now()));
      return group;
    },
    [updatePending]
  );

  /** Engine answered. Ok keeps the hold until telemetry agrees; failure rolls the rows back to the engine snapshot. */
  const endTap = useCallback(
    (group: number, ok: boolean, failure?: string) => {
      updatePending((m) => (ok ? confirmGroup(m, group) : dropGroup(m, group)));
      if (!ok && failure) showNotice({ message: failure });
    },
    [updatePending, showNotice]
  );

  const pauseTorrent = useCallback(
    async (id: string) => {
      if (pendingRef.current[id]) return false; // a tap is already in flight
      const label = nameOf(id);
      const group = beginTap([id], 'pause');
      const ok = (await maglevEngine.pause(id)).ok;
      endTap(group, ok, notices.engine.pauseFailed(label));
      return ok;
    },
    [nameOf, beginTap, endTap]
  );
  const resumeTorrent = useCallback(
    async (id: string) => {
      if (pendingRef.current[id]) return false;
      const label = nameOf(id);
      const group = beginTap([id], 'resume');
      const res = await maglevEngine.resume(id);
      endTap(group, res.ok);
      if (!res.ok) {
        // NATIVE_CONTRACT 47.4: a file-health hold says why, and Open goes to the Recheck banner.
        const held = liveRef.current.torrents.find((t) => t.id === id);
        const failure = resumeFailureNotice(res, held, label);
        showNotice(
          failure.openTorrent
            ? { message: failure.message, actionLabel: OPEN_TORRENT_LABEL, onAction: () => router.push({ pathname: '/torrent/[id]', params: { id } }) }
            : { message: failure.message },
        );
      }
      return res.ok;
    },
    [nameOf, beginTap, endTap, showNotice]
  );
  const pauseAll = useCallback(async () => {
    const ids = liveRef.current.torrents
      .filter((t) => (t.state === 'DOWNLOADING' || t.state === 'SEEDING' || t.state === 'QUEUED') && !pendingRef.current[t.id])
      .map((t) => t.id);
    const group = beginTap(ids, 'pause');
    const res = await maglevEngine.pauseAll();
    endTap(group, res.ok, notices.engine.pauseAllFailed);
  }, [beginTap, endTap]);
  const resumeAll = useCallback(async () => {
    // NATIVE_CONTRACT 47.4: torrents held by a file health tag are skipped (the engine skips them too).
    const ids = resumableIds(liveRef.current.torrents, (id) => !!pendingRef.current[id]);
    const group = beginTap(ids, 'resume');
    const res = await maglevEngine.resumeAll();
    endTap(group, res.ok, notices.engine.resumeAllFailed);
  }, [beginTap, endTap]);

  /** Drops rows the engine deleted from the engine list itself (React state too, unless away). */
  const dropFromLive = useCallback((gone: readonly string[]) => {
    if (gone.length === 0) return;
    for (const id of gone) smoothing.current.delete(id);
    const goneSet = new Set(gone);
    // From the ref, not React state: rows held in the background are newer than the state.
    const prev = liveRef.current;
    const next = { ...prev, torrents: prev.torrents.filter((t) => !goneSet.has(t.id)) };
    liveRef.current = next;
    if (!isAway()) setLiveTelemetry(next);
    else heldWhileAway.current = true;
  }, []);

  /**
   * Remove now (no undo window), with or without files. The row is hidden at once. The caller
   * reports a failure (bulk summary on Transfers, the sheet's error on Detail); the row comes back.
   */
  const deleteTorrent = useCallback(
    async (id: string, deleteFiles: boolean) => {
      const group = beginTap([id], 'remove');
      const ok = (await maglevEngine.delete(id, deleteFiles)).ok;
      if (ok) {
        detailCache.current.delete(id);
        watched.current.delete(id);
        dropFromLive([id]);
      }
      // Ok keeps the row hidden until a tick without it arrives, so a tick sent before the delete cannot bring it back.
      endTap(group, ok);
      return ok;
    },
    [beginTap, endTap, dropFromLive]
  );

  /** Runs the engine delete for removals whose undo window ended. Failed rows come back with a notice. */
  const runRemoval = useCallback(
    async (ids: string[], names: string[], downloadIds: string[] = []) => {
      const results = await Promise.all([
        ...ids.map(async (id) => {
          detailCache.current.delete(id);
          watched.current.delete(id);
          return (await maglevEngine.delete(id, false)).ok;
        }),
        ...downloadIds.map(async (id) => (await maglevEngine.removeDownload(id, false)).ok),
      ]);
      // Link rows that were removed stay hidden (ids are never reused); failed ones come back.
      const failedDl = downloadIds.filter((_, i) => !results[ids.length + i]);
      if (failedDl.length > 0) setRemovingDl((prev) => prev.filter((id) => !failedDl.includes(id)));
      const gone = ids.filter((_, i) => results[i]);
      noteRemoved([...gone, ...downloadIds.filter((id) => !failedDl.includes(id))]);
      dropFromLive(gone);
      // Deleted rows stay hidden as confirmed removals, so a tick sent before the delete cannot bring them back.
      if (gone.length > 0) endTap(beginTap(gone, 'remove'), true);
      setRemoving((prev) => prev.filter((id) => !ids.includes(id)));
      const failedAt = results.slice(0, ids.length).findIndex((ok) => !ok);
      if (failedAt >= 0) {
        const failed = results.slice(0, ids.length).filter((ok) => !ok).length;
        showNotice({ message: failed === 1 ? notices.engine.removeFailed(names[failedAt]) : notices.engine.removeFailedMany(failed) });
      } else if (failedDl.length > 0) {
        showNotice({ message: failedDl.length === 1 ? notices.engine.removeFailed(names[ids.length]) : notices.engine.removeFailedMany(failedDl.length) });
      }
    },
    [showNotice, dropFromLive, beginTap, endTap]
  );

  const flushRemoval = useCallback(() => {
    const p = pendingRemoval.current;
    if (!p) return;
    clearTimeout(p.timer);
    pendingRemoval.current = null;
    setNotice((n) => (n && n.id === p.noticeId ? null : n));
    void runRemoval(p.ids, p.names, p.downloadIds);
  }, [runRemoval]);

  const undoRemove = useCallback(() => {
    const p = pendingRemoval.current;
    if (!p) return;
    clearTimeout(p.timer);
    pendingRemoval.current = null;
    setRemoving((prev) => prev.filter((id) => !p.ids.includes(id)));
    setRemovingDl((prev) => prev.filter((id) => !p.downloadIds.includes(id)));
    setNotice((n) => (n && n.id === p.noticeId ? null : n));
  }, []);

  const removeTransfers = useCallback(
    (ids: string[], downloadIds: string[]) => {
      if (ids.length === 0 && downloadIds.length === 0) return;
      flushRemoval(); // a second removal ends the first one's undo window
      // Names come before the rows are hidden. Torrent names first, then link names, matching runRemoval's order.
      const names = [...ids.map(nameOf), ...downloadIds.map((id) => downloadsRef.current.find((d) => d.id === id)?.name ?? 'download')];
      if (ids.length > 0) setRemoving((prev) => [...prev, ...ids]);
      if (downloadIds.length > 0) setRemovingDl((prev) => [...prev, ...downloadIds]);
      const timer = setTimeout(flushRemoval, undoMs.current);
      const noticeId = noticeSeq.current + 1;
      pendingRemoval.current = { ids, downloadIds, names, timer, noticeId };
      showNotice(
        {
          message: names.length === 1 ? notices.engine.removed(names[0]) : notices.engine.removedMany(names.length),
          actionLabel: 'Undo',
          onAction: undoRemove,
        },
        null
      );
    },
    [flushRemoval, nameOf, showNotice, undoRemove]
  );
  const removeTorrents = useCallback((ids: string[]) => removeTransfers(ids, []), [removeTransfers]);

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
    return () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  const defaultStoragePath = storageStatus?.path || settingsStore.getSettings().storage.defaultPath;
  // Read through a ref so startTorrent keeps one identity when the storage path changes.
  const defaultStoragePathRef = useRef(defaultStoragePath);
  defaultStoragePathRef.current = defaultStoragePath;

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
        outputFolder: savePath && savePath !== defaultStoragePathRef.current ? savePath : null,
        sequential,
        onlyFiles: selectedFileIndices && selectedFileIndices.length > 0 ? selectedFileIndices : null,
      });
      if (res.ok === false) throw engineError(res.code, res.message, res.id, (res as { engineStopped?: boolean }).engineStopped);
      return res.id;
    },
    []
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

  // Mobile data: asked once at start and again each time the app becomes active. Unknown counts as not metered.
  const [onMeteredNetwork, setOnMeteredNetwork] = useState(false);
  const [networkOnline, setNetworkOnline] = useState(true);
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void maglevEngine
        .getNetworkState()
        .then((res) => {
          if (alive && res.ok) {
            setOnMeteredNetwork(res.metered && res.connected);
            setNetworkOnline(res.connected !== false);
          }
        })
        .catch(() => {});
    };
    refresh();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') refresh();
    });
    // Offline only: look again every 10 s so waiting work (subtitles) notices the way back.
    const poll = networkOnline ? null : setInterval(refresh, 10_000);
    return () => {
      alive = false;
      sub.remove();
      if (poll) clearInterval(poll);
    };
  }, [networkOnline]);
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

  // ---- URL downloads (NATIVE_CONTRACT 17). The engine pushes its list on the next telemetry event. ----
  const probeUrl = useCallback((url: string, options: DownloadOptions = {}) => maglevEngine.probeUrl(url, options, 15_000), []);
  const probeStream = useCallback((url: string, options: DownloadOptions = {}) => maglevEngine.probeStream(url, options, 15_000), []);
  const startDownload = useCallback((url: string, options: DownloadOptions = {}) => maglevEngine.addDownload(url, options), []);
  const downloadCall = useCallback(
    async (label: string, call: () => Promise<EngineResult>) => {
      const res = await call();
      if (!res.ok) showNotice({ message: res.message || notices.engine.downloadActionFailed(label) });
      return res.ok;
    },
    [showNotice]
  );
  const pauseDownload = useCallback((id: string) => downloadCall('pause', () => maglevEngine.pauseDownload(id)), [downloadCall]);
  const resumeDownload = useCallback((id: string) => downloadCall('resume', () => maglevEngine.resumeDownload(id)), [downloadCall]);
  const retryDownload = useCallback((id: string) => downloadCall('retry', () => maglevEngine.retryDownload(id)), [downloadCall]);
  const setDownloadLimits = useCallback(
    (id: string, downLimitBps: number) => downloadCall('set the speed limit', () => maglevEngine.setDownloadLimits(id, { downLimitBps })),
    [downloadCall]
  );
  const removeDownload = useCallback(
    async (id: string, deleteFiles: boolean) => {
      // Keeping the files goes through the Undo window; deleting them is confirmed by the caller and happens now.
      if (!deleteFiles) {
        removeTransfers([], [id]);
        return true;
      }
      const ok = await downloadCall('remove', () => maglevEngine.removeDownload(id, true));
      if (ok) {
        noteRemoved([id]);
        setRemovingDl((prev) => [...prev, id]);
      }
      return ok;
    },
    [downloadCall, removeTransfers]
  );
  const refreshDownloadUrl = useCallback((id: string, url: string) => maglevEngine.refreshDownloadUrl(id, url, {}), []);

  const startHttpStream = useCallback(async (id: string, fileIndex: number) => {
    const res = await maglevEngine.streamUrl(id, fileIndex);
    if (res.ok === false) throw engineError(res.code, res.message);
    return res.url;
  }, []);

  // Actions: every dependency is a stable callback, so this object is created once.
  const actions = useMemo<EngineActions>(
    () => ({
      checkClipboard,
      clearClipboardMagnet,
      pauseTorrent,
      resumeTorrent,
      pauseAll,
      resumeAll,
      deleteTorrent,
      removeTorrents,
      removeTransfers,
      undoRemove,
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
      refreshPermissions,
      retryEngine,
      restartEngine,
      probeUrl,
      probeStream,
      startDownload,
      pauseDownload,
      resumeDownload,
      retryDownload,
      setDownloadLimits,
      removeDownload,
      refreshDownloadUrl,
    }),
    [
      checkClipboard, clearClipboardMagnet, pauseTorrent, resumeTorrent, pauseAll, resumeAll, deleteTorrent,
      removeTorrents, removeTransfers, undoRemove, dismissNotice, showNotice, startTorrent, addTorrent,
      resolveMetadata, setFilePriority, setFilePriorities, reannounce, getFreeSpace, openLiveUpdateSettings,
      getPieceBitfield, getTorrentDetail, watchDetail, startHttpStream, refreshPermissions, retryEngine,
      restartEngine, probeUrl, probeStream, startDownload, pauseDownload, resumeDownload, retryDownload,
      setDownloadLimits, removeDownload, refreshDownloadUrl,
    ]
  );
  const status = useMemo<EngineStatusValue>(() => ({ engineStatus, hasCachedList }), [engineStatus, hasCachedList]);
  const telemetryValue = useMemo<EngineTelemetryValue>(() => ({ telemetry, downloads, listsLive }), [telemetry, downloads, listsLive]);
  const noticeValue = useMemo<EngineNoticeValue>(() => ({ notice }), [notice]);
  const completedValue = useMemo<EngineCompletedValue>(() => ({ lastCompleted }), [lastCompleted]);
  const stateValue = useMemo<EngineStateValue>(
    () => ({
      clipboardMagnet, onMeteredNetwork, networkOnline, isNative, defaultStoragePath, storageStatus,
      permissionStatus, restartRequired, configWarning,
    }),
    [clipboardMagnet, onMeteredNetwork, networkOnline, isNative, defaultStoragePath, storageStatus, permissionStatus, restartRequired, configWarning]
  );

  return (
    <EngineActionsContext.Provider value={actions}>
      <EngineStatusContext.Provider value={status}>
        <EngineStateContext.Provider value={stateValue}>
          <EngineNoticeContext.Provider value={noticeValue}>
            <EngineCompletedContext.Provider value={completedValue}>
              <EngineTelemetryContext.Provider value={telemetryValue}>{children}</EngineTelemetryContext.Provider>
            </EngineCompletedContext.Provider>
          </EngineNoticeContext.Provider>
        </EngineStateContext.Provider>
      </EngineStatusContext.Provider>
    </EngineActionsContext.Provider>
  );
};

function useRequired<T>(ctx: React.Context<T | null>, hook: string): T {
  const value = useContext(ctx);
  if (!value) throw new Error(`${hook} must be used within an EngineProvider`);
  return value;
}

/** Functions only. Never re-renders the caller on a telemetry tick. */
export function useEngineActions(): EngineActions {
  return useRequired(EngineActionsContext, 'useEngineActions');
}

/** Engine start state only (engineStatus, hasCachedList). */
export function useEngineStatus(): EngineStatusValue {
  return useRequired(EngineStatusContext, 'useEngineStatus');
}

/** Rows, link downloads and listsLive. Re-renders on every telemetry change. */
export function useEngineTelemetry(): EngineTelemetryValue {
  return useRequired(EngineTelemetryContext, 'useEngineTelemetry');
}

/** Network, storage, permissions, clipboard and the like. */
export function useEngineState(): EngineStateValue {
  return useRequired(EngineStateContext, 'useEngineState');
}

/** The bottom notice only. */
export function useEngineNotice(): EngineNoticeValue {
  return useRequired(EngineNoticeContext, 'useEngineNotice');
}

/** The last finished torrent only. */
export function useEngineLastCompleted(): EngineCompletedValue {
  return useRequired(EngineCompletedContext, 'useEngineLastCompleted');
}

/**
 * Everything, same shape as before the split. Re-renders on every telemetry tick, so screens that
 * need only part of it should use the narrow hooks above. Does not re-render on a detail refresh
 * (read `useDetailVersion()` for that).
 */
export function useMaglevEngine(): EngineContextType {
  const a = useRequired(EngineActionsContext, 'useMaglevEngine');
  const s = useRequired(EngineStatusContext, 'useMaglevEngine');
  const t = useRequired(EngineTelemetryContext, 'useMaglevEngine');
  const st = useRequired(EngineStateContext, 'useMaglevEngine');
  const n = useRequired(EngineNoticeContext, 'useMaglevEngine');
  const c = useRequired(EngineCompletedContext, 'useMaglevEngine');
  return useMemo(() => ({ ...a, ...s, ...t, ...st, ...n, ...c }), [a, s, t, st, n, c]);
}
