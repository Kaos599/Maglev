/**
 * Local crash log. The last 20 crashes are kept in the same kv-store as the other prefs and are
 * never sent anywhere; the user can copy a redacted report and share it by hand.
 */
import { kvGet, kvSet } from './prefs/kv.ts';

export const CRASH_LOG_KEY = 'maglev.crashLog.v1';
export const MAX_CRASHES = 20;
export const MAX_STACK_CHARS = 4096;

export type CrashSource = 'global' | 'boundary';

export interface CrashEntry {
  time: string;
  appVersion: string;
  route: string;
  name: string;
  message: string;
  stack: string;
  isFatal: boolean;
  source: CrashSource;
}

export interface CrashEnv {
  appVersion: string;
  androidVersion: string;
  deviceModel: string;
}

/** Strips anything that could identify the user: keys, magnet links, URLs and storage paths. */
export function redact(text: string): string {
  return String(text ?? '')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '<key>')
    .replace(/magnet:\?\S*/gi, '<link>')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, (m) => (/^content:\/\//i.test(m) ? '<path>' : /^file:\/\//i.test(m) ? '<path>' : '<link>'))
    .replace(/\/(?:storage|sdcard|data\/(?:user|data)|mnt\/(?:sdcard|media_rw))\b[^\s)'",;]*/g, '<path>');
}

let currentRoute = '';
export function setCurrentRoute(route: string): void {
  currentRoute = route;
}

let envProvider: () => CrashEnv = readEnv;

function readEnv(): CrashEnv {
  let appVersion = 'unknown';
  let androidVersion = 'unknown';
  let deviceModel = 'unknown';
  try {
    const Constants = require('expo-constants');
    appVersion = (Constants?.default ?? Constants)?.expoConfig?.version ?? appVersion;
  } catch {
    // keep the default
  }
  try {
    const { Platform } = require('react-native');
    androidVersion = `${Platform.OS} ${String(Platform.Version)}`;
    const model = Platform.constants?.Model;
    const brand = Platform.constants?.Brand;
    if (model) deviceModel = [brand, model].filter(Boolean).join(' ');
  } catch {
    // keep the defaults
  }
  return { appVersion, androidVersion, deviceModel };
}

/** Test hook. */
export function setEnvProvider(fn: (() => CrashEnv) | null): void {
  envProvider = fn ?? readEnv;
}

export function getCrashLog(): CrashEntry[] {
  try {
    const raw = kvGet(CRASH_LOG_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function clearCrashLog(): void {
  try {
    kvSet(CRASH_LOG_KEY, '[]');
  } catch {
    // nothing to clear
  }
}

/** Records one crash. Never throws: a failure to log must not hide the original crash. */
export function recordCrash(
  error: unknown,
  opts: { isFatal?: boolean; source?: CrashSource; route?: string } = {},
): CrashEntry | null {
  try {
    const e = error as { name?: unknown; message?: unknown; stack?: unknown } | null | undefined;
    const entry: CrashEntry = {
      time: new Date().toISOString(),
      appVersion: envProvider().appVersion,
      route: redact(opts.route ?? currentRoute),
      name: redact(String(e?.name ?? 'Error')),
      message: redact(String(e?.message ?? (typeof error === 'string' ? error : 'Unknown error'))),
      stack: redact(String(e?.stack ?? '')).slice(0, MAX_STACK_CHARS),
      isFatal: opts.isFatal === true,
      source: opts.source ?? 'global',
    };
    const next = [...getCrashLog(), entry].slice(-MAX_CRASHES);
    kvSet(CRASH_LOG_KEY, JSON.stringify(next));
    return entry;
  } catch {
    return null;
  }
}

/** Plain-text report the user can paste into an issue. Already redacted when recorded; redacted again to be safe. */
export function formatReport(entries: CrashEntry[], env: CrashEnv = envProvider()): string {
  const head = [
    'Maglev crash report',
    `App version: ${env.appVersion}`,
    `Android: ${env.androidVersion}`,
    `Device: ${env.deviceModel}`,
    `Crashes: ${entries.length}`,
  ];
  const body = entries.map((c, i) =>
    [
      '',
      `#${i + 1} ${c.time}${c.isFatal ? ' (fatal)' : ''}`,
      `Version: ${c.appVersion}  Screen: ${c.route || 'unknown'}  Caught by: ${c.source}`,
      `${c.name}: ${c.message}`,
      c.stack,
    ].join('\n'),
  );
  return redact([...head, ...body].join('\n'));
}

export function buildCrashReport(entries: CrashEntry[] = getCrashLog()): string {
  return formatReport(entries);
}

/** Copies the report to the clipboard. Resolves false when the clipboard is unavailable. */
export async function copyCrashReport(entries: CrashEntry[] = getCrashLog()): Promise<boolean> {
  try {
    const Clipboard = require('expo-clipboard');
    await Clipboard.setStringAsync(buildCrashReport(entries));
    return true;
  } catch {
    return false;
  }
}

interface ErrorUtilsLike {
  getGlobalHandler?: () => ((error: unknown, isFatal?: boolean) => void) | undefined;
  setGlobalHandler: (fn: (error: unknown, isFatal?: boolean) => void) => void;
}

/**
 * Records every uncaught JS error, then hands it to the handler that was there before (React
 * Native's red box in dev, the native crash in release), so a fatal error still ends the app.
 * Unhandled promise rejections need no hook of their own: React Native enables rejection
 * tracking and reports them through ErrorUtils, so they arrive here as non-fatal errors.
 */
export function installGlobalHandler(utils: ErrorUtilsLike | undefined = (globalThis as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils): boolean {
  if (!utils || typeof utils.setGlobalHandler !== 'function') return false;
  const previous = utils.getGlobalHandler?.();
  utils.setGlobalHandler((error, isFatal) => {
    recordCrash(error, { isFatal: isFatal === true, source: 'global' });
    if (previous) previous(error, isFatal);
  });
  return true;
}
