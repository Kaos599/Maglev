import {
  AUTO_RETRY_DELAYS,
  DEFAULT_PEER_TIMEOUT_MINS,
  PEER_TIMEOUT_OPTIONS,
  DEFAULT_SETTINGS,
  SETTINGS_SCHEMA_VERSION,
  type AccentName,
  type DownloadFolder,
  type MaglevSettings,
} from './MaglevSettings.types.ts';

/** Minimal sync key-value surface shared by expo-sqlite/kv-store and the in-memory fallback. */
interface SyncKv {
  getItemSync(key: string): string | null;
  setItemSync(key: string, value: string): void;
}

declare const require: ((id: string) => any) | undefined;

const memoryKv = new Map<string, string>();
const inMemoryKv: SyncKv = {
  getItemSync: (k) => memoryKv.get(k) ?? null,
  setItemSync: (k, v) => {
    memoryKv.set(k, v);
  },
};

/**
 * Loads expo-sqlite's kv-store (synchronous API, so the first render already has settings).
 * Falls back to memory when the native module is unavailable: Node test runners, Expo Go
 * without the module, or web without SQLite support.
 */
function loadKv(): SyncKv {
  try {
    if (typeof require === 'function') {
      const mod = require('expo-sqlite/kv-store');
      const kv = mod?.default ?? mod?.Storage ?? mod;
      if (kv && typeof kv.getItemSync === 'function' && typeof kv.setItemSync === 'function') {
        kv.getItemSync('__probe__'); // throws if the native side is missing
        return kv as SyncKv;
      }
    }
  } catch {
    // fall through to memory
  }
  return inMemoryKv;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Recursively overlays `stored` on `defaults`; any field with a mismatched type keeps its default. */
function mergeWithDefaults<T>(defaults: T, stored: unknown): T {
  if (!isPlainObject(defaults)) {
    if (Array.isArray(defaults)) return (Array.isArray(stored) ? stored : defaults) as T;
    return (typeof stored === typeof defaults ? stored : defaults) as T;
  }
  const out: Record<string, unknown> = {};
  const src = isPlainObject(stored) ? stored : {};
  for (const key of Object.keys(defaults)) {
    out[key] = mergeWithDefaults((defaults as Record<string, unknown>)[key], src[key]);
  }
  return out as T;
}

function sanitizeFolder(v: unknown): DownloadFolder | null {
  if (!isPlainObject(v) || typeof v.uri !== 'string' || !v.uri) return null;
  return {
    uri: v.uri,
    displayName: typeof v.displayName === 'string' ? v.displayName : v.uri,
    mode: v.mode === 'staging' ? 'staging' : 'direct',
  };
}

const LANGUAGE_TAG = /^[a-z]{2}(?:-[A-Za-z0-9]{2,4})?$/;

/** Subtitle settings (section 36.2): tolerant read; anything of the wrong type falls back to its default. */
function sanitizeSubtitles(v: unknown): MaglevSettings['subtitles'] {
  const d = DEFAULT_SETTINGS.subtitles;
  const o = isPlainObject(v) ? v : {};
  const languages: string[] = [];
  if (Array.isArray(o.languages)) {
    for (const l of o.languages) if (typeof l === 'string' && LANGUAGE_TAG.test(l) && !languages.includes(l)) languages.push(l);
  }
  const sourceEnabled: Record<string, boolean> = {};
  if (isPlainObject(o.sourceEnabled)) {
    for (const [id, on] of Object.entries(o.sourceEnabled)) if (typeof on === 'boolean') sourceEnabled[id] = on;
  }
  return {
    enabled: o.enabled !== false,
    languages,
    hearingImpaired: o.hearingImpaired === 'prefer' || o.hearingImpaired === 'avoid' ? o.hearingImpaired : d.hearingImpaired,
    sourceEnabled,
    privacyAck: o.privacyAck === true,
    autoNewVideos: o.autoNewVideos === true,
  };
}

/** Every accent the app knows; anything else saved falls back to lime. */
const ACCENT_NAMES: readonly AccentName[] = ['lime', 'cyan', 'pink', 'orange', 'violet', 'blue', 'amber', 'mint'];

/** Upgrades any persisted payload (any version, or none) to the current schema with defaults for missing fields. */
export function migrateSettings(raw: unknown): MaglevSettings {
  const defaults: MaglevSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  const body = isPlainObject(raw) && isPlainObject(raw.settings) ? raw.settings : raw;
  const merged = mergeWithDefaults(defaults, body);
  if (!ACCENT_NAMES.includes(merged.appearance.accent)) merged.appearance.accent = 'lime';
  if (!['clean', 'retro', 'mono'].includes(merged.appearance.fontStyle)) merged.appearance.fontStyle = 'clean';
  if (merged.appearance.showSpeedTotals !== true) merged.appearance.showSpeedTotals = false;
  if (merged.appearance.swipeActions !== false) merged.appearance.swipeActions = true;
  if (merged.appearance.showFileIcons !== false) merged.appearance.showFileIcons = true;
  if (merged.bandwidth.autoRetry !== 'off' && merged.bandwidth.autoRetry !== 'after') merged.bandwidth.autoRetry = 'after';
  if (!AUTO_RETRY_DELAYS.includes(merged.bandwidth.autoRetryDelayMin)) merged.bandwidth.autoRetryDelayMin = 5;
  if (!PEER_TIMEOUT_OPTIONS.includes(merged.bandwidth.peerTimeoutMins)) merged.bandwidth.peerTimeoutMins = DEFAULT_PEER_TIMEOUT_MINS;
  merged.subtitles = sanitizeSubtitles(isPlainObject(body) ? body.subtitles : null);
  merged.downloadFolder = sanitizeFolder(isPlainObject(body) ? body.downloadFolder : null);
  return merged;
}

type SettingsListener = (settings: MaglevSettings) => void;

/**
 * High-speed in-memory cached Settings Store with expo-sqlite kv-store persistence
 * and reactive subscriber bridge.
 *
 * Latency SLA: < 10ms for read and write operations.
 */
export class MaglevSettingsStore {
  private static instance: MaglevSettingsStore;
  private settings: MaglevSettings;
  private listeners: Set<SettingsListener> = new Set();
  private kv: SyncKv;
  private storageKey = 'maglev_settings';

  private constructor() {
    this.kv = loadKv();
    this.settings = this.load();
  }

  public static getInstance(): MaglevSettingsStore {
    if (!MaglevSettingsStore.instance) {
      MaglevSettingsStore.instance = new MaglevSettingsStore();
    }
    return MaglevSettingsStore.instance;
  }

  /**
   * Synchronous instantaneous read (< 1ms).
   */
  public getSettings(): MaglevSettings {
    return this.settings;
  }

  /**
   * Partial or full settings update with reactive broadcast and persistence (< 10ms).
   */
  public updateSettings(updater: Partial<MaglevSettings> | ((prev: MaglevSettings) => Partial<MaglevSettings>)): MaglevSettings {
    const startTime = performance.now();
    const patch = typeof updater === 'function' ? updater(this.settings) : updater;

    this.settings = {
      onboarded: patch.onboarded ?? this.settings.onboarded,
      downloadFolder: patch.downloadFolder !== undefined ? patch.downloadFolder : this.settings.downloadFolder,
      appearance: { ...this.settings.appearance, ...(patch.appearance || {}) },
      storage: { ...this.settings.storage, ...(patch.storage || {}) },
      bandwidth: { ...this.settings.bandwidth, ...(patch.bandwidth || {}) },
      network: {
        ...this.settings.network,
        ...(patch.network || {}),
        proxy: {
          ...this.settings.network.proxy,
          ...(patch.network?.proxy || {}),
        },
      },
      power: { ...this.settings.power, ...(patch.power || {}) },
      subtitles: { ...this.settings.subtitles, ...(patch.subtitles || {}) },
    };

    // Dispatch immediately to listeners
    this.notifyListeners();

    this.persist();

    const elapsed = performance.now() - startTime;
    if (elapsed > 10) {
      console.warn(`[MaglevSettingsStore] SLA Warning: settings update took ${elapsed.toFixed(2)}ms (> 10ms)`);
    }

    return this.settings;
  }

  /**
   * Reset settings to canonical defaults.
   */
  public resetToDefaults(): MaglevSettings {
    this.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    this.notifyListeners();
    this.persist();
    return this.settings;
  }

  /**
   * Subscribe to reactive settings state changes.
   */
  public subscribe(listener: SettingsListener): () => void {
    this.listeners.add(listener);
    listener(this.settings);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners(): void {
    const snapshot = this.settings;
    this.listeners.forEach((fn) => {
      try {
        fn(snapshot);
      } catch (err) {
        // Suppress listener uncaught exception
      }
    });
  }

  private load(): MaglevSettings {
    try {
      const raw = this.kv.getItemSync(this.storageKey);
      if (raw) return migrateSettings(JSON.parse(raw));
    } catch {
      // corrupt payload: start from defaults
    }
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }

  private persist(): void {
    try {
      this.kv.setItemSync(this.storageKey, JSON.stringify({ version: SETTINGS_SCHEMA_VERSION, settings: this.settings }));
    } catch {
      // storage unavailable: settings stay in memory for this session
    }
  }
}

export const settingsStore = MaglevSettingsStore.getInstance();
