import { DEFAULT_SETTINGS, type MaglevSettings } from './MaglevSettings.types.ts';

type SettingsListener = (settings: MaglevSettings) => void;

/**
 * High-speed in-memory cached Settings Store with MMKV / local persistence
 * and reactive subscriber bridge.
 *
 * Latency SLA: < 10ms for read and write operations.
 */
export class MaglevSettingsStore {
  private static instance: MaglevSettingsStore;
  private settings: MaglevSettings;
  private listeners: Set<SettingsListener> = new Set();
  private isPersisting: boolean = false;
  private storageKey = 'maglev_system_settings_v2';

  private constructor() {
    this.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    this.loadInitialSettings();
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
    };

    // Dispatch immediately to listeners
    this.notifyListeners();

    // Persist asynchronously
    this.persistSettingsAsync();

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
    this.persistSettingsAsync();
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

  private loadInitialSettings(): void {
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(this.storageKey);
        if (raw) {
          const parsed = JSON.parse(raw);
          this.settings = { ...this.settings, ...parsed };
        }
      }
    } catch {
      // Fallback to default in non-storage environments
    }
  }

  private persistSettingsAsync(): void {
    if (this.isPersisting) return;
    this.isPersisting = true;

    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(this.storageKey, JSON.stringify(this.settings));
      }
    } catch {
      // Ignored
    } finally {
      this.isPersisting = false;
    }
  }
}

export const settingsStore = MaglevSettingsStore.getInstance();
