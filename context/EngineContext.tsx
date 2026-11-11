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
  type Metadata,
  type NativePermissionStatus,
  type StorageStatus,
  type TorrentCompletedEvent,
  type TorrentDetailData,
  type TorrentTelemetry,
} from 'maglev-engine';

export type FilterCategory = 'ALL' | 'DOWN' | 'UP' | 'PAUSED';

interface EngineContextType {
  telemetry: AggregatedTelemetry;
  activeFilter: FilterCategory;
  setActiveFilter: (filter: FilterCategory) => void;
  filteredTorrents: TorrentTelemetry[];
  clipboardMagnet: string | null;
  checkClipboard: () => Promise<void>;
  clearClipboardMagnet: () => void;
  pauseTorrent: (id: string) => Promise<boolean>;
  resumeTorrent: (id: string) => Promise<boolean>;
  pauseAll: () => Promise<void>;
  resumeAll: () => Promise<void>;
  deleteTorrent: (id: string, deleteFiles: boolean) => Promise<boolean>;
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
  /** Not supported by the engine contract; always resolves false. */
  addTracker: (id: string, trackerUrl: string) => Promise<boolean>;
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

const defaultTelemetry: AggregatedTelemetry = {
  totalDownloadSpeedBytes: 0,
  totalUploadSpeedBytes: 0,
  activeDownloads: 0,
  activeUploads: 0,
  torrents: [],
};

const EngineContext = createContext<EngineContextType | null>(null);

function engineError(code: string, message: string, id?: string): Error {
  return Object.assign(new Error(message), { code, id });
}

export const EngineProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [telemetry, setTelemetry] = useState<AggregatedTelemetry>(defaultTelemetry);
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
      if (content && content.trim().startsWith('magnet:?xt=')) {
        setClipboardMagnet(content.trim());
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
        if (list.ok) setTelemetry(aggregateSnapshots(list.torrents));
        setStorageStatus(storage);
      }
      void refreshPermissions();
    },
    [refreshPermissions]
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
      setTelemetry(aggregateSnapshots(event.torrents));
      watched.current.forEach((_count, id) => {
        if (event.torrents.some((s) => s.id === id)) void refreshDetail(id);
      });
    });
    const offCompleted = maglevEngine.onTorrentCompleted((e) => setLastCompleted(e));
    const offAction = maglevEngine.onNotificationAction(async (e) => {
      if (e.action === 'shutdown') {
        BackHandler.exitApp();
        return;
      }
      const res = await maglevEngine.listTorrents(); // pause_all / resume_all were applied natively
      if (res.ok) setTelemetry(aggregateSnapshots(res.torrents));
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
  }, [refreshDetail, afterStart]);

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

  const pauseTorrent = useCallback(async (id: string) => (await maglevEngine.pause(id)).ok, []);
  const resumeTorrent = useCallback(async (id: string) => (await maglevEngine.resume(id)).ok, []);
  const pauseAll = useCallback(async () => {
    await maglevEngine.pauseAll();
  }, []);
  const resumeAll = useCallback(async () => {
    await maglevEngine.resumeAll();
  }, []);
  const deleteTorrent = useCallback(async (id: string, deleteFiles: boolean) => {
    detailCache.current.delete(id);
    watched.current.delete(id);
    return (await maglevEngine.delete(id, deleteFiles)).ok;
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

  const addTracker = useCallback(async (_id: string, _trackerUrl: string) => false, []);

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
        startTorrent,
        addTorrent,
        resolveMetadata,
        setFilePriority,
        addTracker,
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
