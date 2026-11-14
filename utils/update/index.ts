/**
 * In-app updates, wiring (docs/NATIVE_CONTRACT.md section 27). The pure parts live in check.ts, machine.ts and
 * rules.ts. This file owns the one store the About screen reads, and the triggers: the app becoming active,
 * telemetry (safe-to-install), and the native download and install events.
 */
import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import Constants from 'expo-constants';
import { maglevEngine, settingsStore } from 'maglev-engine';
import type { ManagedBy } from 'maglev-engine';
import { checkForUpdate, type UpdateInfo } from './check.ts';
import { autoCheckDue, initialState, reduce, type UpdateEvent, type UpdateState } from './machine.ts';
import { autoDownloadAllowed, isUploading, networkAllows, safeToInstall, type UpdateNet } from './rules.ts';
import { getUpdatePrefs, updateUpdatePrefs } from '../prefs/update.ts';
import { isNewer } from './check.ts';

let state: UpdateState = initialState;
const listeners = new Set<() => void>();
let managedBy: ManagedBy | null = null;
let installedVersionCode: number | null = null;
let installer: string | null = null;
let started = false;
let lastUploadAt: number | null = null;
let telemetry: { torrents: { state: string; upBps?: number }[]; downloads: { state: string }[] } = { torrents: [], downloads: [] };
let wifiTimer: ReturnType<typeof setInterval> | null = null;
let playerOpen = false;

/** The in-app player screen is open: an automatic install waits (docs/NATIVE_CONTRACT.md section 30). */
export function setPlayerOpen(open: boolean): void {
  playerOpen = open;
}

/** A manual check while another app owns updates can still say a newer version exists (27.1). */
export type ManagedCheck = { status: 'idle' | 'checking' | 'upToDate' | 'failed' } | { status: 'newer'; info: UpdateInfo };
let managedCheck: ManagedCheck = { status: 'idle' };

function emit() {
  listeners.forEach((l) => l());
}
function dispatch(e: UpdateEvent): UpdateState {
  const next = reduce(state, e);
  if (next !== state) {
    state = next;
    emit();
  }
  return state;
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function getUpdateState(): UpdateState {
  return state;
}
export function getManagedCheck(): ManagedCheck {
  return managedCheck;
}
/** True when something other than Maglev installed it, so the first update needs a tap (27.5). */
export function firstUpdateAsks(): boolean {
  return installer !== 'com.maglev';
}
export function getManagedBy(): ManagedBy | null {
  return managedBy;
}
export function useUpdateState(): UpdateState {
  return useSyncExternalStore(subscribe, getUpdateState, getUpdateState);
}
export function useManagedCheck(): ManagedCheck {
  return useSyncExternalStore(subscribe, getManagedCheck, getManagedCheck);
}

const installedVersion = () => Constants.expoConfig?.version ?? '0.0';
const rules = () => {
  const n = settingsStore.getSettings().network;
  return { wifiOnly: n.wifiOnly, vpnOnly: n.vpnOnly };
};

async function readNet(): Promise<UpdateNet | null> {
  try {
    const r = await maglevEngine.getUpdateNetwork();
    return r.ok ? { connected: r.connected, metered: r.metered, vpn: r.vpn } : null;
  } catch {
    return null;
  }
}

/** Posts a notice once per kind and version (`notifiedVersion`), so a restored update doesn't post again. */
function notify(kind: 'available' | 'ready', version: string, file?: { path: string; sha256: string }) {
  const key = `${kind}:${version}`;
  if (getUpdatePrefs().notifiedVersion === key) return;
  updateUpdatePrefs({ notifiedVersion: key });
  void maglevEngine.postUpdateNotice(kind, version, file?.path ?? null, file?.sha256 ?? null).catch(() => {});
}

/** Reads who installed Maglev. Called once at start. */
async function loadSource(): Promise<void> {
  try {
    const src = await maglevEngine.getInstallSource();
    installer = src.installer;
    installedVersionCode = typeof src.versionCode === 'number' ? src.versionCode : null;
    managedBy = src.managedBy;
    if (managedBy) dispatch({ type: 'managed', by: managedBy });
  } catch {
    // Unknown: treated as self-updatable, and the native calls refuse with MANAGED if not.
  }
}

/**
 * Check for an update. `manual` is the About button: it ignores the 24 h gate, the skipped version and the
 * network rules, and always lands on a result the About screen can show.
 */
export async function checkNow(opts: { manual: boolean }): Promise<boolean> {
  if (managedBy) {
    if (!opts.manual || managedCheck.status === 'checking') return false;
    managedCheck = { status: 'checking' };
    emit();
    try {
      const info = await runCheck();
      managedCheck = info ? { status: 'newer', info } : { status: 'upToDate' };
    } catch {
      managedCheck = { status: 'failed' };
    }
    emit();
    return true;
  }
  if (dispatch({ type: 'check' }).kind !== 'checking') return false;
  updateUpdatePrefs({ lastCheckAt: Date.now() });
  try {
    const info = await runCheck();
    dispatch({ type: 'checked', info, skippedVersion: getUpdatePrefs().skippedVersion, manual: opts.manual });
    // Keep what was found, so a restart re-routes it (section 30).
    updateUpdatePrefs({ available: state.kind === 'available' ? state.info : null });
    if (!opts.manual) await routeFound();
  } catch {
    dispatch({ type: 'checkFailed' });
  }
  return true;
}

async function runCheck(): Promise<UpdateInfo | null> {
  if (installedVersionCode === null) await loadSource();
  return checkForUpdate(
    (url, init) => fetch(url, init) as unknown as ReturnType<Parameters<typeof checkForUpdate>[0]>,
    { version: installedVersion(), versionCode: installedVersionCode ?? -1 },
  );
}

/** After an automatic check found a version: route it by mode and network (27.3). */
async function routeFound(): Promise<void> {
  if (state.kind !== 'available') return;
  const prefs = getUpdatePrefs();
  const net = await readNet();
  const unmetered = autoDownloadAllowed(net, rules());
  const next = dispatch({ type: 'route', mode: prefs.updateMode, unmetered });
  if (next.kind === 'waiting') notify('available', next.info.version);
  if (next.kind === 'downloading') void runDownload(next.info);
  if (next.kind === 'waitingForWifi') startWifiWatch();
}

function startWifiWatch() {
  if (wifiTimer) return;
  wifiTimer = setInterval(() => void pollWifi(), 60_000);
}
function stopWifiWatch() {
  if (wifiTimer) clearInterval(wifiTimer);
  wifiTimer = null;
}
async function pollWifi(): Promise<void> {
  if (state.kind !== 'waitingForWifi') return stopWifiWatch();
  if (autoDownloadAllowed(await readNet(), rules())) {
    const next = dispatch({ type: 'wifi' });
    if (next.kind === 'downloading') void runDownload(next.info);
    stopWifiWatch();
  }
}

/** The user tapped Download. */
export async function downloadNow(): Promise<void> {
  const next = dispatch({ type: 'download' });
  if (next.kind !== 'downloading') return;
  // The network rules cover a download the user started too (section 30).
  if (!networkAllows(await readNet(), rules())) {
    dispatch({ type: 'downloadFailed', code: 'BLOCKED' });
    return;
  }
  await runDownload(next.info);
}

async function runDownload(info: UpdateInfo): Promise<void> {
  const res = await maglevEngine.downloadUpdate(info.apkUrl, info.sha256, info.size, rules().vpnOnly).catch(
    () => ({ ok: false as const, code: 'NETWORK', message: '' }),
  );
  if (state.kind !== 'downloading') return;
  if (!res.ok) {
    if (res.code === 'UPDATE_INVALID') updateUpdatePrefs({ pending: null, available: null });
    dispatch({ type: 'downloadFailed', code: res.code });
    return;
  }
  updateUpdatePrefs({ pending: { info, path: res.path } });
  dispatch({ type: 'downloaded', path: res.path });
  await routeReady();
}

/** Ready -> Installing (auto, safe) or ReadyAsk. */
async function routeReady(): Promise<void> {
  if (state.kind !== 'ready' && state.kind !== 'readyAsk') return;
  const mode = getUpdatePrefs().updateMode;
  const safe = safeToInstall({ now: Date.now(), lastUploadAt, playerOpen, ...telemetry });
  const next = dispatch({ type: 'readyRoute', mode, safe });
  if (next.kind === 'installing') {
    await sendInstall(next.path, true, next.info.sha256);
  } else if (next.kind === 'readyAsk') {
    // Also after a restore: notify() skips a version that was already posted.
    notify('ready', next.info.version, { path: next.path, sha256: next.info.sha256 });
  }
}

/** The user tapped Install. */
export async function installNow(): Promise<void> {
  const next = dispatch({ type: 'install' });
  if (next.kind === 'installing') await sendInstall(next.path, false, next.info.sha256);
}

/** The release hash comes from `pending` (the verified download), falling back to the state's own info. */
async function sendInstall(path: string, silent: boolean, stateSha: string): Promise<void> {
  const sha256 = getUpdatePrefs().pending?.info.sha256 ?? stateSha;
  const res = await maglevEngine.installUpdate(path, silent, sha256).catch(
    () => ({ ok: false as const, code: 'INSTALL_FAILED', message: '' }),
  );
  if (state.kind !== 'installing') return;
  if (!res.ok) {
    if (res.code === 'UPDATE_INVALID') updateUpdatePrefs({ pending: null, available: null });
    dispatch({ type: 'installFailed', code: res.code });
    return;
  }
  dispatch({ type: 'installStatus', status: res.status });
}

/** The card's "allow installs" button: opens the system screen. The install retries once on return. */
export async function openInstallPermission(): Promise<void> {
  await maglevEngine.openInstallPermissionSettings().catch(() => {});
}

/** "Skip this version" on the card. */
export function skipThisVersion(): void {
  const info = 'info' in state ? state.info : null;
  if (!info) return;
  if (dispatch({ type: 'skip' }).kind === 'skipped') {
    updateUpdatePrefs({ skippedVersion: info.version, pending: null, available: null });
    void maglevEngine.cleanupUpdates(null).catch(() => {});
    void maglevEngine.clearUpdateNotice('available').catch(() => {});
    void maglevEngine.clearUpdateNotice('ready').catch(() => {});
  }
}

/** "Later": the card closes; nothing changes in the machine. */
export function dismissDownloadFailure(): void {
  dispatch({ type: 'dismissFailure' });
}

async function onActive(): Promise<void> {
  if (state.kind === 'needsPermission' && !state.retried) {
    const next = dispatch({ type: 'permissionReturned' });
    if (next.kind === 'installing') await sendInstall(next.path, false, next.info.sha256);
    return;
  }
  if (state.kind === 'ready' || state.kind === 'readyAsk') await routeReady();
  if (state.kind === 'waitingForWifi') await pollWifi();
  const p = getUpdatePrefs();
  const due = autoCheckDue({ now: Date.now(), lastCheckAt: p.lastCheckAt, autoCheck: p.updateAutoCheck, managedBy });
  if (due && (state.kind === 'idle' || state.kind === 'upToDate' || state.kind === 'checkFailed' || state.kind === 'skipped')) {
    if (networkAllows(await readNet(), rules())) await checkNow({ manual: false });
  }
}

/**
 * A version an earlier check found but nothing downloaded yet: put it back as Available and route it by mode and
 * network again (Waiting, WaitingForWifi or Downloading), instead of waiting 24 h for the next check (section 30).
 */
async function restoreAvailable(): Promise<void> {
  const found = getUpdatePrefs().available;
  if (!found || state.kind !== 'idle') return;
  dispatch({ type: 'check' });
  dispatch({ type: 'checked', info: found, skippedVersion: null, manual: true });
  await routeFound();
}

/** Start once, when the app is up (app/_layout.tsx). Safe to call again. */
export function startUpdates(): () => void {
  if (started) return () => {};
  started = true;
  const subs: (() => void)[] = [];
  void (async () => {
    await loadSource();
    if (!managedBy) {
      const pending = getUpdatePrefs().pending;
      if (pending && isNewer(pending.info.tag, installedVersion())) {
        dispatch({ type: 'restore', info: pending.info, path: pending.path });
      } else if (pending) {
        updateUpdatePrefs({ pending: null });
      }
      const found = getUpdatePrefs().available;
      if (found && !isNewer(found.tag, installedVersion())) updateUpdatePrefs({ available: null });
      const keep = getUpdatePrefs();
      await maglevEngine.cleanupUpdates(keep.pending?.path ?? null, (keep.pending?.info ?? keep.available)?.sha256 ?? null).catch(() => {});
      await restoreAvailable();
      if (AppState.currentState === 'active') await onActive();
    }
  })();
  subs.push(
    maglevEngine.onUpdateProgress((e) => dispatch({ type: 'progress', bytes: e.bytes, total: e.total })),
    maglevEngine.onUpdateResult((e) => {
      if (!e.ok) {
        if (e.code === 'MANAGED') return;
        dispatch({ type: 'installFailed', code: e.code });
      } else if (e.status === 'needs_user') {
        dispatch({ type: 'installStatus', status: 'needs_user' });
      } else {
        dispatch({ type: 'installed' });
      }
    }),
    maglevEngine.onTelemetry((e) => {
      const wasSafe = safeToInstall({ now: Date.now(), lastUploadAt, playerOpen, ...telemetry });
      if (isUploading(e.torrents)) lastUploadAt = Date.now();
      telemetry = { torrents: e.torrents, downloads: e.downloads ?? [] };
      // An automatic install that was waiting for a quiet moment tries again when transfers stop.
      if (!wasSafe && state.kind === 'readyAsk' && getUpdatePrefs().updateMode === 'auto') void routeReady();
    }),
  );
  const app = AppState.addEventListener('change', (next) => {
    if (next === 'active') void onActive();
  });
  subs.push(() => app.remove());
  return () => {
    subs.forEach((s) => s());
    stopWifiWatch();
    started = false;
  };
}
