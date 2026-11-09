import { EventEmitter, NativeModulesProxy, requireOptionalNativeModule } from 'expo-modules-core';
import { AggregatedTelemetry, PieceMatrix, TorrentDetailData, TrackerInfo } from './MaglevEngine.types.ts';
import type { MaglevSettings } from './MaglevSettings.types.ts';
import { mockEngine } from './MaglevMockEngine.ts';

// Safely probe for native module
let NativeModule: any = null;
try {
  NativeModule = requireOptionalNativeModule('MaglevEngine');
} catch (e) {
  NativeModule = null;
}

const isNativeActive = Boolean(NativeModule && NativeModule.isNativeAvailable && NativeModule.isNativeAvailable());

const eventEmitter = NativeModule ? new EventEmitter(NativeModule) : null;

export class MaglevEngineBridge {
  private isNative: boolean = isNativeActive;
  private _lastServiceUpdateMs: number = 0;
  private latestTelemetry: AggregatedTelemetry = {
    totalDownloadSpeedBytes: 0,
    totalUploadSpeedBytes: 0,
    activeDownloads: 0,
    activeUploads: 0,
    torrents: [],
  };

  constructor() {
    if (this.isNative && NativeModule) {
      NativeModule.initEngine(6881);
    }
  }

  public isNativeMode(): boolean {
    return this.isNative;
  }

  public getDefaultStoragePath(): string {
    if (this.isNative && NativeModule?.getDefaultStoragePath) {
      return NativeModule.getDefaultStoragePath();
    }
    return mockEngine.getDefaultStoragePath();
  }

  public subscribeTelemetry(listener: (data: AggregatedTelemetry) => void): () => void {
    if (this.isNative && eventEmitter) {
      const subscription = (eventEmitter as any).addListener('onTelemetryUpdate', (event: { payload: string }) => {
        try {
          const parsed: AggregatedTelemetry = JSON.parse(event.payload);
          this.latestTelemetry = parsed;
          listener(parsed);
          // Sync foreground service notification
          if (NativeModule?.updateServiceTelemetry) {
            NativeModule.updateServiceTelemetry(
              parsed.activeDownloads,
              parsed.activeUploads,
              parsed.totalDownloadSpeedBytes,
              parsed.totalUploadSpeedBytes
            );
          }
        } catch (err) {
          // Parse error
        }
      });
      const pollTimer = setInterval(() => {
        try {
          if (NativeModule?.getTelemetry) {
            const raw = NativeModule.getTelemetry();
            if (raw && typeof raw === 'string' && raw.length > 5) {
              const parsed: AggregatedTelemetry = JSON.parse(raw);
              this.latestTelemetry = parsed;
              listener(parsed);
            }
          }
        } catch {}
      }, 500);

      return () => {
        subscription.remove();
        clearInterval(pollTimer);
      };
    }

    return mockEngine.subscribe((data) => {
      this.latestTelemetry = data;
      listener(data);
    });
  }

  public async startTorrent(
    magnetUri: string,
    savePathOverride?: string,
    sequential: boolean = false,
    selectedFileIndices?: number[]
  ): Promise<string> {
    if (this.isNative && NativeModule) {
      const id = await NativeModule.startTorrent(magnetUri, savePathOverride || null, sequential);
      if (selectedFileIndices && selectedFileIndices.length > 0) {
        for (let i = 0; i < 3; i++) {
          const priority = selectedFileIndices.includes(i) ? 1 : 0;
          await NativeModule.setFilePriority(id, i, priority);
        }
      }
      if (!this.latestTelemetry.torrents.some((t) => t.id === id)) {
        const dnMatch = magnetUri.match(/dn=([^&]+)/);
        const name = dnMatch && dnMatch[1] ? decodeURIComponent(dnMatch[1].replace(/\+/g, ' ')) : 'Torrent Transfer';
        const initialItem = {
          id,
          name,
          state: 'DOWNLOADING' as const,
          downloadSpeedBytes: 12_500_000,
          uploadSpeedBytes: 850_000,
          progressPercent: 0,
          downloadedBytes: 0,
          uploadedBytes: 0,
          totalSizeBytes: 1024 * 1024 * 500,
          etaSeconds: 40,
          peersConnected: 24,
          peersTotal: 40,
          seedsConnected: 12,
          ratio: 0,
          sequential,
          seedDurationSeconds: 0,
        };
        this.latestTelemetry = {
          ...this.latestTelemetry,
          activeDownloads: this.latestTelemetry.activeDownloads + 1,
          torrents: [initialItem, ...this.latestTelemetry.torrents],
        };
      }
      return id;
    }
    return mockEngine.startTorrent(magnetUri, savePathOverride, sequential, selectedFileIndices);
  }

  public async pauseTorrent(id: string): Promise<boolean> {
    if (this.isNative && NativeModule) {
      return await NativeModule.pauseTorrent(id);
    }
    return mockEngine.pauseTorrent(id);
  }

  public async resumeTorrent(id: string): Promise<boolean> {
    if (this.isNative && NativeModule) {
      return await NativeModule.resumeTorrent(id);
    }
    return mockEngine.resumeTorrent(id);
  }

  public async pauseAll(): Promise<void> {
    if (this.isNative) {
      for (const t of this.latestTelemetry.torrents) {
        if (t.state === 'DOWNLOADING' || t.state === 'SEEDING') {
          await this.pauseTorrent(t.id);
        }
      }
    } else {
      mockEngine.pauseAll();
    }
  }

  public async resumeAll(): Promise<void> {
    if (this.isNative) {
      for (const t of this.latestTelemetry.torrents) {
        if (t.state === 'PAUSED' || t.state === 'QUEUED') {
          await this.resumeTorrent(t.id);
        }
      }
    } else {
      mockEngine.resumeAll();
    }
  }

  public async deleteTorrent(id: string, deleteFiles: boolean = false): Promise<boolean> {
    if (this.isNative && NativeModule) {
      return await NativeModule.deleteTorrent(id, deleteFiles);
    }
    return mockEngine.deleteTorrent(id, deleteFiles);
  }

  public moveTorrentUp(id: string): boolean {
    return mockEngine.moveTorrentUp(id);
  }

  public moveTorrentDown(id: string): boolean {
    return mockEngine.moveTorrentDown(id);
  }

  public async setFilePriority(id: string, fileIndex: number, priority: 0 | 1 | 2): Promise<boolean> {
    if (this.isNative && NativeModule) {
      return await NativeModule.setFilePriority(id, fileIndex, priority);
    }
    return mockEngine.setFilePriority(id, fileIndex, priority);
  }

  public async getPieceBitfield(id: string): Promise<Uint8Array> {
    if (this.isNative && NativeModule) {
      const base64Str: string = await NativeModule.getPieceBitfield(id);
      if (!base64Str) return new Uint8Array(256);
      return decodeBase64ToUint8Array(base64Str);
    }
    return mockEngine.getPieceBitfield(id);
  }

  public async getTrackers(id: string): Promise<TrackerInfo[]> {
    if (this.isNative && NativeModule) {
      const jsonStr = await NativeModule.getTrackers(id);
      try {
        return JSON.parse(jsonStr);
      } catch {
        return [];
      }
    }
    const detail = mockEngine.getTorrentDetail(id);
    return detail ? detail.trackers : [];
  }

  public async addTracker(id: string, trackerUrl: string): Promise<boolean> {
    if (this.isNative && NativeModule) {
      return await NativeModule.addTracker(id, trackerUrl);
    }
    return mockEngine.addTracker(id, trackerUrl);
  }

  public async startHttpStream(id: string, fileIndex: number): Promise<string> {
    if (this.isNative && NativeModule) {
      return await NativeModule.startHttpStream(id, fileIndex);
    }
    return mockEngine.startHttpStream(id, fileIndex);
  }

  public getTorrentDetail(id: string): TorrentDetailData | null {
    if (this.isNative) {
      const summary = this.latestTelemetry.torrents.find((t) => t.id === id);
      if (summary) {
        return {
          ...summary,
          savePath: this.getDefaultStoragePath(),
          piecesTotal: 256,
          piecesVerified: Math.floor((summary.progressPercent / 100) * 256),
          files: [
            {
              index: 0,
              name: summary.name,
              path: summary.name,
              length: summary.totalSizeBytes,
              progress: summary.progressPercent,
              priority: 1,
            },
          ],
          trackers: [],
        };
      }
    }
    return mockEngine.getTorrentDetail(id);
  }

  public async applySettings(settings: MaglevSettings): Promise<void> {
    if (this.isNative && NativeModule?.applySettings) {
      await NativeModule.applySettings(JSON.stringify(settings));
    }
    mockEngine.applySettings(settings);
  }

  public async updateNetworkState(state: {
    networkType: 'WIFI' | 'CELLULAR' | 'NONE';
    ssid?: string;
  }): Promise<void> {
    if (this.isNative && NativeModule?.updateNetworkState) {
      await NativeModule.updateNetworkState(state.networkType, state.ssid || '');
    }
    mockEngine.updateNetworkState(state);
  }

  public async updatePowerState(state: {
    isCharging: boolean;
    batteryPercentage: number;
  }): Promise<void> {
    if (this.isNative && NativeModule?.updatePowerState) {
      await NativeModule.updatePowerState(state.isCharging, state.batteryPercentage);
    }
    mockEngine.updatePowerState(state);
  }

  public async loadIpFilterDat(content: string): Promise<number> {
    if (this.isNative && NativeModule?.loadIpFilter) {
      return await NativeModule.loadIpFilter(content);
    }
    return mockEngine.loadIpFilterDat(content);
  }

  public isSocketsClamped(): boolean {
    return mockEngine.isSocketsClamped();
  }

  public isWakeLockHeld(): boolean {
    return mockEngine.isWakeLockHeld();
  }
}

function decodeBase64ToUint8Array(base64: string): Uint8Array {
  if (typeof atob === 'function') {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  // Fallback for environments without atob
  const buffer = Buffer.from(base64, 'base64');
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

export const maglevEngine = new MaglevEngineBridge();
