export type ThemeMode = 'TACTICAL_DARK' | 'PURE_OLED';
export type TelemetryDensity = 'COMPACT' | 'VERBOSE';
/** UI font style. Never sent to the engine. */
export type FontStyle = 'clean' | 'retro' | 'mono';
export type AppearanceMode = 'oled' | 'dim' | 'light' | 'system';
export type AccentName = 'lime' | 'cyan' | 'pink' | 'orange';
export type StorageMode = 'POSIX' | 'SAF';
export type EncryptionMode = 'REQUIRED' | 'PREFERRED' | 'DISABLED';
export type ProxyType = 'SOCKS5' | 'HTTP';
export type ProxyScope = 'ALL' | 'TRACKERS_ONLY' | 'PEERS_ONLY';
export type SpeedPreset = 'UNLIMITED' | '1MB' | '2MB' | '5MB' | '10MB' | 'CUSTOM';
export type BatteryCutoffThreshold = 0 | 15 | 20 | 30; // 0 = disabled
export type SeedingRatioLimit = 0 | 1.0 | 1.5 | 2.0 | 3.0; // 0 = unlimited
export type SeedingDurationLimit = 0 | 3600 | 21600 | 86400; // 0 = unlimited, 1h, 6h, 24h
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
}

export interface AppearanceSettings {
  /** @deprecated use mode */
  theme: ThemeMode;
  mode: AppearanceMode;
  accent: AccentName;
  telemetryDensity: TelemetryDensity;
  fontStyle: FontStyle;
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
  },
  storage: {
    storageMode: 'POSIX',
    defaultPath: '/storage/emulated/0/Download/Maglev',
    autoMoveCompleted: false,
    autoMoveDestinationPath: '/storage/emulated/0/Download/MaglevCompleted',
    preAllocateDisk: true,
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
};
