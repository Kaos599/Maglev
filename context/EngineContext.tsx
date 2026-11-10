import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import * as Clipboard from 'expo-clipboard';
import { AggregatedTelemetry, maglevEngine, TorrentDetailData, TorrentTelemetry } from 'maglev-engine';

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
  moveTorrentUp: (id: string) => boolean;
  moveTorrentDown: (id: string) => boolean;
  startTorrent: (
    magnetUri: string,
    savePath?: string,
    sequential?: boolean,
    selectedFileIndices?: number[]
  ) => Promise<string>;
  setFilePriority: (id: string, fileIndex: number, priority: 0 | 1 | 2) => Promise<boolean>;
  addTracker: (id: string, trackerUrl: string) => Promise<boolean>;
  getPieceBitfield: (id: string) => Promise<Uint8Array>;
  getTorrentDetail: (id: string) => TorrentDetailData | null;
  startHttpStream: (id: string, fileIndex: number) => Promise<string>;
  isNative: boolean;
  defaultStoragePath: string;
}

const defaultTelemetry: AggregatedTelemetry = {
  totalDownloadSpeedBytes: 0,
  totalUploadSpeedBytes: 0,
  activeDownloads: 0,
  activeUploads: 0,
  torrents: [],
};

const EngineContext = createContext<EngineContextType | null>(null);

export const EngineProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [telemetry, setTelemetry] = useState<AggregatedTelemetry>(defaultTelemetry);
  const [activeFilter, setActiveFilter] = useState<FilterCategory>('ALL');
  const [clipboardMagnet, setClipboardMagnet] = useState<string | null>(null);

  // Subscribe to native or mock telemetry at 500ms cadence
  useEffect(() => {
    const unsubscribe = maglevEngine.subscribeTelemetry((data) => {
      setTelemetry(data);
    });
    return () => unsubscribe();
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

  useEffect(() => {
    checkClipboard();
  }, [checkClipboard]);

  const clearClipboardMagnet = useCallback(() => {
    setClipboardMagnet(null);
  }, []);

  const filteredTorrents = React.useMemo(() => {
    switch (activeFilter) {
      case 'DOWN':
        return telemetry.torrents.filter((t) => t.state === 'DOWNLOADING' || t.state === 'QUEUED');
      case 'UP':
        return telemetry.torrents.filter((t) => t.state === 'SEEDING');
      case 'PAUSED':
        return telemetry.torrents.filter((t) => t.state === 'PAUSED');
      case 'ALL':
      default:
        return telemetry.torrents;
    }
  }, [telemetry.torrents, activeFilter]);

  const pauseTorrent = useCallback(async (id: string) => {
    setTelemetry((prev) => ({
      ...prev,
      activeDownloads: Math.max(0, prev.activeDownloads - 1),
      torrents: prev.torrents.map((t) =>
        t.id === id ? { ...t, state: 'PAUSED', downloadSpeedBytes: 0, uploadSpeedBytes: 0 } : t
      ),
    }));
    return await maglevEngine.pauseTorrent(id);
  }, []);

  const resumeTorrent = useCallback(async (id: string) => {
    setTelemetry((prev) => ({
      ...prev,
      activeDownloads: prev.activeDownloads + 1,
      torrents: prev.torrents.map((t) =>
        t.id === id ? { ...t, state: 'DOWNLOADING' } : t
      ),
    }));
    return await maglevEngine.resumeTorrent(id);
  }, []);

  const pauseAll = useCallback(async () => {
    setTelemetry((prev) => ({
      ...prev,
      activeDownloads: 0,
      activeUploads: 0,
      totalDownloadSpeedBytes: 0,
      totalUploadSpeedBytes: 0,
      torrents: prev.torrents.map((t) => ({
        ...t,
        state: 'PAUSED',
        downloadSpeedBytes: 0,
        uploadSpeedBytes: 0,
      })),
    }));
    await maglevEngine.pauseAll();
  }, []);

  const resumeAll = useCallback(async () => {
    setTelemetry((prev) => ({
      ...prev,
      torrents: prev.torrents.map((t) => ({ ...t, state: 'DOWNLOADING' })),
    }));
    await maglevEngine.resumeAll();
  }, []);

  const deleteTorrent = useCallback(async (id: string, deleteFiles: boolean) => {
    setTelemetry((prev) => ({
      ...prev,
      torrents: prev.torrents.filter((t) => t.id !== id),
    }));
    return await maglevEngine.deleteTorrent(id, deleteFiles);
  }, []);

  const moveTorrentUp = useCallback((id: string) => {
    return maglevEngine.moveTorrentUp(id);
  }, []);

  const moveTorrentDown = useCallback((id: string) => {
    return maglevEngine.moveTorrentDown(id);
  }, []);

  const startTorrent = useCallback(
    async (
      magnetUri: string,
      savePath?: string,
      sequential: boolean = false,
      selectedFileIndices?: number[]
    ) => {
      const id = await maglevEngine.startTorrent(magnetUri, savePath, sequential, selectedFileIndices);
      return id;
    },
    []
  );

  const setFilePriority = useCallback(async (id: string, fileIndex: number, priority: 0 | 1 | 2) => {
    return await maglevEngine.setFilePriority(id, fileIndex, priority);
  }, []);

  const addTracker = useCallback(async (id: string, trackerUrl: string) => {
    return await maglevEngine.addTracker(id, trackerUrl);
  }, []);

  const getPieceBitfield = useCallback(async (id: string) => {
    return await maglevEngine.getPieceBitfield(id);
  }, []);

  const getTorrentDetail = useCallback((id: string) => {
    return maglevEngine.getTorrentDetail(id);
  }, []);

  const startHttpStream = useCallback(async (id: string, fileIndex: number) => {
    return await maglevEngine.startHttpStream(id, fileIndex);
  }, []);

  const isNative = maglevEngine.isNativeMode();
  const defaultStoragePath = maglevEngine.getDefaultStoragePath();

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
        moveTorrentUp,
        moveTorrentDown,
        startTorrent,
        setFilePriority,
        addTracker,
        getPieceBitfield,
        getTorrentDetail,
        startHttpStream,
        isNative,
        defaultStoragePath,
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
