import { AggregatedTelemetry, PieceMatrix, TorrentDetailData, TorrentFileInfo, TorrentTelemetry, TrackerInfo } from './MaglevEngine.types';

type Listener = (telemetry: AggregatedTelemetry) => void;

class MaglevMockEngine {
  private torrents: Map<string, TorrentDetailData> = new Map();
  private pieceMatrices: Map<string, Uint8Array> = new Map();
  private listeners: Set<Listener> = new Set();
  private timer: any = null;
  private defaultStoragePath = '/storage/emulated/0/Android/data/com.maglev/files/Download';

  constructor() {
    this.seedInitialMockData();
    this.startTelemetryLoop();
  }

  public getDefaultStoragePath(): string {
    return this.defaultStoragePath;
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    // Immediately emit current state
    listener(this.getAggregatedTelemetry());
    return () => {
      this.listeners.delete(listener);
    };
  }

  public getAggregatedTelemetry(): AggregatedTelemetry {
    let totalDown = 0;
    let totalUp = 0;
    let activeDown = 0;
    let activeUp = 0;
    const items: TorrentTelemetry[] = [];

    this.torrents.forEach((t) => {
      if (t.state === 'DOWNLOADING') {
        totalDown += t.downloadSpeedBytes;
        activeDown++;
      } else if (t.state === 'SEEDING') {
        totalUp += t.uploadSpeedBytes;
        activeUp++;
      }
      items.push({
        id: t.id,
        name: t.name,
        state: t.state,
        downloadSpeedBytes: t.downloadSpeedBytes,
        uploadSpeedBytes: t.uploadSpeedBytes,
        progressPercent: t.progressPercent,
        downloadedBytes: t.downloadedBytes,
        uploadedBytes: t.uploadedBytes,
        totalSizeBytes: t.totalSizeBytes,
        etaSeconds: t.etaSeconds,
        peersConnected: t.peersConnected,
        peersTotal: t.peersTotal,
        seedsConnected: t.seedsConnected,
        ratio: t.ratio,
        sequential: t.sequential,
      });
    });

    return {
      totalDownloadSpeedBytes: totalDown,
      totalUploadSpeedBytes: totalUp,
      activeDownloads: activeDown,
      activeUploads: activeUp,
      torrents: items,
    };
  }

  public startTorrent(
    magnetUri: string,
    savePathOverride?: string,
    sequential: boolean = false
  ): string {
    const id = this.extractHashOrGenerate(magnetUri);
    const name = this.extractName(magnetUri) || 'Ubuntu-24.04-desktop-amd64.iso';
    const totalSize = 4_294_967_296; // 4.0 GB

    const files: TorrentFileInfo[] = [
      {
        index: 0,
        name: `${name}`,
        path: `${name}`,
        length: totalSize,
        progress: 0,
        priority: 1,
      },
    ];

    const trackers: TrackerInfo[] = [
      {
        url: 'udp://tracker.opentrackr.org:1337/announce',
        status: 'Working',
        seeds: 42,
        peers: 86,
      },
      {
        url: 'udp://open.stealth.si:80/announce',
        status: 'Working',
        seeds: 19,
        peers: 31,
      },
    ];

    const newTorrent: TorrentDetailData = {
      id,
      name,
      state: 'DOWNLOADING',
      downloadSpeedBytes: 14_800_000, // 14.8 MB/s
      uploadSpeedBytes: 1_200_000,
      progressPercent: 0,
      downloadedBytes: 0,
      uploadedBytes: 0,
      totalSizeBytes: totalSize,
      etaSeconds: Math.floor(totalSize / 14_800_000),
      peersConnected: 28,
      peersTotal: 40,
      seedsConnected: 12,
      ratio: 0.0,
      sequential,
      savePath: savePathOverride || this.defaultStoragePath,
      piecesTotal: 256,
      piecesVerified: 0,
      files,
      trackers,
    };

    const matrix = new Uint8Array(256);
    this.pieceMatrices.set(id, matrix);
    this.torrents.set(id, newTorrent);
    this.broadcast();
    return id;
  }

  public pauseTorrent(id: string): boolean {
    const t = this.torrents.get(id);
    if (!t) return false;
    t.state = 'PAUSED';
    t.downloadSpeedBytes = 0;
    t.uploadSpeedBytes = 0;
    this.broadcast();
    return true;
  }

  public resumeTorrent(id: string): boolean {
    const t = this.torrents.get(id);
    if (!t) return false;
    if (t.progressPercent >= 100) {
      t.state = 'SEEDING';
      t.uploadSpeedBytes = 3_400_000;
    } else {
      t.state = 'DOWNLOADING';
      t.downloadSpeedBytes = 14_800_000;
    }
    this.broadcast();
    return true;
  }

  public pauseAll(): void {
    this.torrents.forEach((t) => {
      t.state = 'PAUSED';
      t.downloadSpeedBytes = 0;
      t.uploadSpeedBytes = 0;
    });
    this.broadcast();
  }

  public resumeAll(): void {
    this.torrents.forEach((t) => {
      if (t.progressPercent >= 100) {
        t.state = 'SEEDING';
        t.uploadSpeedBytes = 2_500_000;
      } else {
        t.state = 'DOWNLOADING';
        t.downloadSpeedBytes = 12_000_000;
      }
    });
    this.broadcast();
  }

  public deleteTorrent(id: string, _deleteFiles: boolean = false): boolean {
    const removed = this.torrents.delete(id);
    this.pieceMatrices.delete(id);
    this.broadcast();
    return removed;
  }

  public setFilePriority(id: string, fileIndex: number, priority: 0 | 1 | 2): boolean {
    const t = this.torrents.get(id);
    if (!t || !t.files[fileIndex]) return false;
    t.files[fileIndex].priority = priority;
    return true;
  }

  public getPieceBitfield(id: string): Uint8Array {
    let matrix = this.pieceMatrices.get(id);
    if (!matrix) {
      matrix = new Uint8Array(256);
      this.pieceMatrices.set(id, matrix);
    }
    return matrix;
  }

  public getTorrentDetail(id: string): TorrentDetailData | null {
    return this.torrents.get(id) || null;
  }

  public addTracker(id: string, trackerUrl: string): boolean {
    const t = this.torrents.get(id);
    if (!t) return false;
    t.trackers.push({
      url: trackerUrl,
      status: 'Announcing',
      seeds: 0,
      peers: 0,
    });
    return true;
  }

  public startHttpStream(id: string, fileIndex: number): string {
    const t = this.torrents.get(id);
    if (t) {
      t.sequential = true;
    }
    const streamUrl = `http://127.0.0.1:8080/stream/${id}/${fileIndex}`;
    if (t) {
      t.streamUrl = streamUrl;
    }
    return streamUrl;
  }

  private startTelemetryLoop(): void {
    if (this.timer) clearInterval(this.timer);
    // Strict SLA: 500ms cadence
    this.timer = setInterval(() => {
      this.stepSimulation();
      this.broadcast();
    }, 500);
  }

  private stepSimulation(): void {
    this.torrents.forEach((t) => {
      if (t.state === 'DOWNLOADING') {
        // Increment downloaded bytes
        const delta = Math.floor(t.downloadSpeedBytes * 0.5);
        t.downloadedBytes = Math.min(t.totalSizeBytes, t.downloadedBytes + delta);
        t.progressPercent = parseFloat(((t.downloadedBytes / t.totalSizeBytes) * 100).toFixed(1));

        if (t.downloadSpeedBytes > 0) {
          t.etaSeconds = Math.max(0, Math.floor((t.totalSizeBytes - t.downloadedBytes) / t.downloadSpeedBytes));
        }

        // Update piece matrix
        const matrix = this.getPieceBitfield(t.id);
        const verifiedCount = Math.floor((t.progressPercent / 100) * 256);
        t.piecesVerified = verifiedCount;
        for (let i = 0; i < 256; i++) {
          if (i < verifiedCount) {
            matrix[i] = 2; // Verified cyan
          } else if (i < verifiedCount + 4 && i < 256) {
            matrix[i] = 1; // In flight lime
          } else {
            matrix[i] = 0; // Unavailable
          }
        }

        // Check completion
        if (t.downloadedBytes >= t.totalSizeBytes) {
          t.state = 'SEEDING';
          t.downloadSpeedBytes = 0;
          t.uploadSpeedBytes = 3_400_000;
          t.etaSeconds = 0;
        }
      } else if (t.state === 'SEEDING') {
        const deltaUp = Math.floor(t.uploadSpeedBytes * 0.5);
        t.uploadedBytes += deltaUp;
        if (t.downloadedBytes > 0) {
          t.ratio = parseFloat((t.uploadedBytes / t.downloadedBytes).toFixed(2));
        }
      }
    });
  }

  private broadcast(): void {
    const payload = this.getAggregatedTelemetry();
    this.listeners.forEach((listener) => {
      try {
        listener(payload);
      } catch (e) {
        // Ignore listener error
      }
    });
  }

  private extractHashOrGenerate(magnet: string): string {
    const match = magnet.match(/xt=urn:btih:([a-zA-Z0-9]+)/i);
    return match ? match[1].toLowerCase() : `mg_${Date.now().toString(16)}`;
  }

  private extractName(magnet: string): string | null {
    const match = magnet.match(/dn=([^&]+)/);
    return match ? decodeURIComponent(match[1].replace(/\+/g, ' ')) : null;
  }

  private seedInitialMockData(): void {
    // Seed standard initial torrents matching canonical spec for out-of-box testability
    const id1 = '4b2a8c3d7e1f9a0b1c2d3e4f5a6b7c8d9e0f1a2b';
    const name1 = 'ArchLinux-2026.11.01-x86_64.iso';
    const total1 = 1_288_490_188; // 1.2 GB
    const downloaded1 = 953_482_739; // ~74%

    const matrix1 = new Uint8Array(256);
    const verified1 = Math.floor(0.74 * 256);
    for (let i = 0; i < 256; i++) {
      if (i < verified1) matrix1[i] = 2; // Verified
      else if (i < verified1 + 6) matrix1[i] = 1; // In flight
      else matrix1[i] = 0;
    }
    this.pieceMatrices.set(id1, matrix1);

    this.torrents.set(id1, {
      id: id1,
      name: name1,
      state: 'DOWNLOADING',
      downloadSpeedBytes: 14_800_000,
      uploadSpeedBytes: 850_000,
      progressPercent: 74.0,
      downloadedBytes: downloaded1,
      uploadedBytes: 154_000_000,
      totalSizeBytes: total1,
      etaSeconds: 136, // 2m 16s
      peersConnected: 28,
      peersTotal: 40,
      seedsConnected: 6,
      ratio: 0.16,
      sequential: false,
      savePath: this.defaultStoragePath,
      piecesTotal: 256,
      piecesVerified: verified1,
      files: [
        {
          index: 0,
          name: name1,
          path: name1,
          length: total1,
          progress: 74.0,
          priority: 1,
        },
      ],
      trackers: [
        {
          url: 'udp://tracker.archlinux.org:6969/announce',
          status: 'Working',
          seeds: 34,
          peers: 68,
        },
      ],
    });

    const id2 = '9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e';
    const name2 = 'Big_Buck_Bunny_4K_HDR.mkv';
    const total2 = 2_147_483_648; // 2.0 GB

    const matrix2 = new Uint8Array(256);
    matrix2.fill(2); // 100% verified
    this.pieceMatrices.set(id2, matrix2);

    this.torrents.set(id2, {
      id: id2,
      name: name2,
      state: 'SEEDING',
      downloadSpeedBytes: 0,
      uploadSpeedBytes: 3_400_000,
      progressPercent: 100.0,
      downloadedBytes: total2,
      uploadedBytes: 5_798_205_850,
      totalSizeBytes: total2,
      etaSeconds: 0,
      peersConnected: 14,
      peersTotal: 40,
      seedsConnected: 22,
      ratio: 2.7,
      sequential: true,
      savePath: this.defaultStoragePath,
      piecesTotal: 256,
      piecesVerified: 256,
      streamUrl: `http://127.0.0.1:8080/stream/${id2}/0`,
      files: [
        {
          index: 0,
          name: name2,
          path: name2,
          length: total2,
          progress: 100.0,
          priority: 1,
        },
      ],
      trackers: [
        {
          url: 'udp://tracker.opentrackr.org:1337/announce',
          status: 'Working',
          seeds: 56,
          peers: 41,
        },
      ],
    });
  }
}

export const mockEngine = new MaglevMockEngine();
