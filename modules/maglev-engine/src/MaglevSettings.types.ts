export type ThemeMode = 'TACTICAL_DARK' | 'PURE_OLED';
export type TelemetryDensity = 'COMPACT' | 'VERBOSE';
/** UI font style. Never sent to the engine. */
export type FontStyle = 'clean' | 'retro' | 'mono';
export type AppearanceMode = 'oled' | 'dim' | 'light' | 'system';
export type AccentName = 'lime' | 'cyan' | 'pink' | 'orange' | 'violet' | 'blue' | 'amber' | 'mint';
export type StorageMode = 'POSIX' | 'SAF';
export type EncryptionMode = 'REQUIRED' | 'PREFERRED' | 'DISABLED';
export type ProxyType = 'SOCKS5' | 'HTTP';
export type ProxyScope = 'ALL' | 'TRACKERS_ONLY' | 'PEERS_ONLY';
export type SpeedPreset = 'UNLIMITED' | '1MB' | '2MB' | '5MB' | '10MB' | 'CUSTOM';
export type BatteryCutoffThreshold = 0 | 15 | 20 | 30; // 0 = disabled
export type SeedingRatioLimit = 0 | 1.0 | 1.5 | 2.0 | 3.0; // 0 = unlimited
export type SeedingDurationLimit = 0 | 3600 | 21600 | 86400; // 0 = unlimited, 1h, 6h, 24h
export type AutoRetryMode = 'off' | 'after';
export type AutoRetryDelayMin = 1 | 5 | 15 | 60;
/** "Stop waiting for peers after", minutes. 0 = never (NATIVE_CONTRACT 20.1). */
export type PeerTimeoutMins = 0 | 10 | 30 | 60 | 360;
export const PEER_TIMEOUT_OPTIONS: readonly PeerTimeoutMins[] = [10, 30, 60, 360, 0];
export const DEFAULT_PEER_TIMEOUT_MINS: PeerTimeoutMins = 10;
export const AUTO_RETRY_DELAYS: readonly AutoRetryDelayMin[] = [1, 5, 15, 60];
export type PortForwardingStatus = 'MAPPED' | 'MAPPING' | 'DISABLED' | 'FAILED';

export interface ProxyConfig {
  enabled: boolean;
  type: ProxyType;
  host: string;
  port: number;
  username?: string;
  password?: string;
  scope: ProxyScope;
  remoteDns: boolean; // RFC 1928 address type 0x03 domain name resolution
}

export interface NetworkSettings {
  wifiOnly: boolean;
  /** NATIVE_CONTRACT 21: pause while the active network is not a VPN. */
  vpnOnly: boolean;
  /** NATIVE_CONTRACT 25.2: keep seeding on mobile data. Default false: seeding waits for Wi-Fi. */
  seedOnMobileData: boolean;
  ssidWhitelistEnabled: boolean;
  allowedSsids: string[];
  currentSsid?: string;
  networkType: 'WIFI' | 'CELLULAR' | 'NONE';
  upnpEnabled: boolean;
  portForwardingStatus: PortForwardingStatus;
  listeningPort: number;
  mappedPort?: number;
  encryption: EncryptionMode;
  dhtEnabled: boolean;
  pexEnabled: boolean;
  lsdEnabled: boolean;
  proxy: ProxyConfig;
  ipFilterEnabled: boolean;
  ipFilterRulesCount: number;
  ipFilterPath?: string;
}

export interface BandwidthSettings {
  downloadLimitBytesPerSec: number; // 0 = unlimited
  uploadLimitBytesPerSec: number;   // 0 = unlimited
  downloadPreset: SpeedPreset;
  uploadPreset: SpeedPreset;
  maxActiveDownloads: number;
  maxActiveUploads: number;
  maxConnectionsPerTorrent: number; // default 40
  globalPeerCeiling: number;
  seedingRatioLimit: SeedingRatioLimit;
  seedingDurationLimitSeconds: SeedingDurationLimit;
  /** Give up on a torrent that finds no peers after this long (0 = never). Sent to Rust as `peer_timeout_secs`. */
  peerTimeoutMins: PeerTimeoutMins;
  /** Retry a failed link download by itself after `autoRetryDelayMin`. Read in Kotlin (WorkManager), never sent to Rust. */
  autoRetry: AutoRetryMode;
  autoRetryDelayMin: AutoRetryDelayMin;
  /** False: give up after 3 automatic tries per download. True: keep trying every delay. */
  autoRetryAlways: boolean;
}

export interface PowerSettings {
  downloadOnlyWhileCharging: boolean;
  batteryCutoffThreshold: BatteryCutoffThreshold;
  autoExitOnComplete: boolean;
  /** SM-34: continue downloads after the phone restarts or Maglev updates. Read headless in Kotlin. */
  resumeAfterRestart: boolean;
  isCharging: boolean;
  batteryPercentage: number;
}

export interface StorageSettings {
  storageMode: StorageMode;
  defaultPath: string;
  customSafUri?: string;
  customSafPath?: string;
  autoMoveCompleted: boolean;
  autoMoveDestinationPath: string;
  preAllocateDisk: boolean;
  /** Quick share (contracts-0.19/quick-share.md): add a shared magnet, .torrent or file link at once, with no card. Read in Kotlin. */
  addWithoutAsking: boolean;
  /** Write a `.nomedia` in the download folder and skip the media scan, so Photos and video apps do not list Maglev's files. Read in Kotlin. */
  hideFromGallery: boolean;
}

export interface AppearanceSettings {
  /** @deprecated use mode */
  theme: ThemeMode;
  mode: AppearanceMode;
  accent: AccentName;
  telemetryDensity: TelemetryDensity;
  fontStyle: FontStyle;
  /** Transfers screen: show the total speeds strip with Pause all / Resume all. Off by default. */
  showSpeedTotals: boolean;
  /** Transfers screen: swipe a row right to Pause or Resume, left to Remove from the list. UI only. On by default. */
  swipeActions: boolean;
  /** Transfers screen: a file-type icon on the left of each card. UI only. On by default. */
  showFileIcons: boolean;
}

export type SubtitleHearingPref = 'both' | 'prefer' | 'avoid';

/** Subtitles (docs/NATIVE_CONTRACT.md section 36.2). UI only: never reaches toNativeConfig or Kotlin. */
export interface SubtitleSettings {
  /** Master switch. Off hides every entry point and makes no request. */
  enabled: boolean;
  /** ISO 639-1 codes plus pt-BR, zh-CN, zh-TW, es-419, in order of preference. Empty means "follow the phone's language". */
  languages: string[];
  hearingImpaired: SubtitleHearingPref;
  /** User overrides by provider id; a missing id falls back to the provider's `enabledByDefault`. */
  sourceEnabled: Record<string, boolean>;
  /** True after the user accepted the one-time notice before the first lookup. */
  privacyAck: boolean;
  /** NATIVE_CONTRACT 44.6. Get subtitles for new videos once they start. Default off. */
  autoNewVideos: boolean;
}

export type DownloadFolderMode = 'direct' | 'staging';

export interface DownloadFolder {
  uri: string;
  displayName: string;
  mode: DownloadFolderMode;
}

/** Bump when the persisted shape changes; the store migrates older payloads with defaults. */
export const SETTINGS_SCHEMA_VERSION = 3;

export interface MaglevSettings {
  /** True once the first-run onboarding has been completed. */
  onboarded: boolean;
  /** Folder chosen through the SAF picker, or null to use the engine default. */
  downloadFolder: DownloadFolder | null;
  appearance: AppearanceSettings;
  storage: StorageSettings;
  bandwidth: BandwidthSettings;
  network: NetworkSettings;
  power: PowerSettings;
  /** UI only (section 36.2). */
  subtitles: SubtitleSettings;
}

export const SPEED_PRESET_MAP: Record<SpeedPreset, number> = {
  UNLIMITED: 0,
  '1MB': 1_048_576,
  '2MB': 2_097_152,
  '5MB': 5_242_880,
  '10MB': 10_485_760,
  CUSTOM: 0,
};

export const DEFAULT_SETTINGS: MaglevSettings = {
  onboarded: false,
  downloadFolder: null,
  appearance: {
    theme: 'TACTICAL_DARK',
    mode: 'oled',
    accent: 'lime',
    telemetryDensity: 'COMPACT',
    fontStyle: 'clean',
    showSpeedTotals: false,
    swipeActions: true,
    showFileIcons: true,
  },
  storage: {
    storageMode: 'POSIX',
    defaultPath: '/storage/emulated/0/Download/Maglev',
    autoMoveCompleted: false,
    autoMoveDestinationPath: '/storage/emulated/0/Download/MaglevCompleted',
    preAllocateDisk: true,
    addWithoutAsking: false,
    hideFromGallery: false,
  },
  bandwidth: {
    downloadLimitBytesPerSec: 0,
    uploadLimitBytesPerSec: 0,
    downloadPreset: 'UNLIMITED',
    uploadPreset: 'UNLIMITED',
    maxActiveDownloads: 3,
    maxActiveUploads: 3,
    maxConnectionsPerTorrent: 40,
    globalPeerCeiling: 200,
    seedingRatioLimit: 1.5,
    seedingDurationLimitSeconds: 21600, // 6 hours
    peerTimeoutMins: 10,
    autoRetry: 'after',
    autoRetryDelayMin: 5,
    autoRetryAlways: false,
  },
  network: {
    wifiOnly: false,
    vpnOnly: false,
    seedOnMobileData: false,
    ssidWhitelistEnabled: false,
    allowedSsids: [],
    networkType: 'WIFI',
    currentSsid: 'Home-5G',
    upnpEnabled: true,
    portForwardingStatus: 'MAPPED',
    listeningPort: 6881,
    mappedPort: 6881,
    encryption: 'PREFERRED',
    dhtEnabled: true,
    pexEnabled: true,
    lsdEnabled: true,
    proxy: {
      enabled: false,
      type: 'SOCKS5',
      host: '127.0.0.1',
      port: 1080,
      scope: 'ALL',
      remoteDns: true,
    },
    ipFilterEnabled: false,
    ipFilterRulesCount: 0,
    ipFilterPath: '',
  },
  power: {
    downloadOnlyWhileCharging: false,
    batteryCutoffThreshold: 20,
    autoExitOnComplete: false,
    resumeAfterRestart: true,
    isCharging: true,
    batteryPercentage: 85,
  },
  subtitles: {
    enabled: true,
    languages: [],
    hearingImpaired: 'both',
    sourceEnabled: {},
    privacyAck: false,
    autoNewVideos: false,
  },
};

/** Settings that only Kotlin reads. They ride in the `setGovernance` payload and are saved in SharedPreferences. */
export interface KotlinOnlySettings {
  hideFromGallery: boolean;
  autoRetry: AutoRetryMode;
  autoRetryDelayMin: AutoRetryDelayMin;
  autoRetryAlways: boolean;
}
