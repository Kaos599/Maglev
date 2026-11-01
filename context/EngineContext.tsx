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
  startTorrent: (magnetUri: string, savePath?: string, sequential?: boolean) => Promise<string>;
  setFilePriority: (id: string, fileIndex: number, priority: 0 | 1 | 2) => Promise<boolean>;
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
        return telemetry.torrents.filter((t) => t.state === 'DOWNLOADING');
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
    return await maglevEngine.pauseTorrent(id);
  }, []);

  const resumeTorrent = useCallback(async (id: string) => {
    return await maglevEngine.resumeTorrent(id);
  }, []);

  const pauseAll = useCallback(async () => {
    await maglevEngine.pauseAll();
  }, []);

  const resumeAll = useCallback(async () => {
    await maglevEngine.resumeAll();
  }, []);

  const deleteTorrent = useCallback(async (id: string, deleteFiles: boolean) => {
    return await maglevEngine.deleteTorrent(id, deleteFiles);
  }, []);

  const startTorrent = useCallback(async (magnetUri: string, savePath?: string, sequential: boolean = false) => {
    return await maglevEngine.startTorrent(magnetUri, savePath, sequential);
  }, []);

  const setFilePriority = useCallback(async (id: string, fileIndex: number, priority: 0 | 1 | 2) => {
    return await maglevEngine.setFilePriority(id, fileIndex, priority);
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
        startTorrent,
        setFilePriority,
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
