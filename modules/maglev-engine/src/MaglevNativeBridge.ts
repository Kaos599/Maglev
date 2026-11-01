import { EventEmitter, NativeModulesProxy, requireOptionalNativeModule } from 'expo-modules-core';
import { AggregatedTelemetry, PieceMatrix, TorrentDetailData, TrackerInfo } from './MaglevEngine.types';
import { mockEngine } from './MaglevMockEngine';

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
      const subscription = eventEmitter.addListener('onTelemetryUpdate', (event: { payload: string }) => {
        try {
          const parsed = JSON.parse(event.payload);
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
      return () => subscription.remove();
    }

    return mockEngine.subscribe(listener);
  }

  public async startTorrent(
    magnetUri: string,
    savePathOverride?: string,
    sequential: boolean = false
  ): Promise<string> {
    if (this.isNative && NativeModule) {
      return await NativeModule.startTorrent(magnetUri, savePathOverride || null, sequential);
    }
    return mockEngine.startTorrent(magnetUri, savePathOverride, sequential);
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
    mockEngine.pauseAll();
  }

  public async resumeAll(): Promise<void> {
    mockEngine.resumeAll();
  }

  public async deleteTorrent(id: string, deleteFiles: boolean = false): Promise<boolean> {
    if (this.isNative && NativeModule) {
      return await NativeModule.deleteTorrent(id, deleteFiles);
    }
    return mockEngine.deleteTorrent(id, deleteFiles);
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
    return mockEngine.getTorrentDetail(id);
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
