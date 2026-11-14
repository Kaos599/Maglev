/**
 * Lists that update themselves (docs/NATIVE_CONTRACT.md section 31): wiring. The pure parts live in schema.ts,
 * machine.ts, check.ts and store.ts. This file owns the one store the About screen reads and the triggers: the
 * app becoming active (at most once every 24 h) and the "Check now" buttons.
 */
import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { maglevEngine, settingsStore, updateBlocklist } from 'maglev-engine';
import { PROVIDERS } from '../search/aggregate.ts';
import { getBrowserPrefs, updateBrowserPrefs } from '../prefs/browser.ts';
import { getListPrefs, updateListPrefs } from '../prefs/lists.ts';
import { autoCheckDue, busy, initialState, reduce, type ListsEvent, type ListsNet, type ListsState } from './machine.ts';
import { countChangedSources, nextBlocklistUrls, runListCheck, adResultOf, type AdUpdateOutcome, type ListDeps, type TextFetch } from './check.ts';
import { setAppliedFile } from './store.ts';
import type { SourcesFile } from './schema.ts';

export { getAppliedFile, getListsVersion, subscribeLists, listTrackers } from './store.ts';

let state: ListsState = initialState;
const listeners = new Set<() => void>();
let started = false;

function emit() {
  listeners.forEach((l) => l());
}
function dispatch(e: ListsEvent): ListsState {
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

export function getListsState(): ListsState {
  return state;
}
export function useListsState(): ListsState {
  return useSyncExternalStore(subscribe, getListsState, getListsState);
}

const rules = () => {
  const n = settingsStore.getSettings().network;
  return { wifiOnly: n.wifiOnly, vpnOnly: n.vpnOnly };
};

async function readNet(): Promise<ListsNet | null> {
  try {
    const r = await maglevEngine.getUpdateNetwork();
    return r.ok ? { connected: r.connected, metered: r.metered, vpn: r.vpn } : null;
  } catch {
    return null;
  }
}

/** Stores a verified file, applies it, and moves the default ad list addresses when the user never changed them. */
function applyVerified(file: SourcesFile): number {
  const prefs = getListPrefs();
  const changed = countChangedSources(prefs.sourcesFile, file);
  updateListPrefs({ sourcesFile: file, appliedSerial: file.serial });
  setAppliedFile(file);
  if (file.blocklistUrls) {
    const replacement = nextBlocklistUrls(getBrowserPrefs().blocklistUrls, prefs.blocklistDefault, file.blocklistUrls);
    if (replacement) updateBrowserPrefs({ blocklistUrls: replacement });
    updateListPrefs({ blocklistDefault: file.blocklistUrls });
  }
  return changed;
}

/**
 * The ad block list update, shared by the daily check, "Check now" (`conditional: true`) and Settings > Browser >
 * Update now (`conditional: false`). It reports into the state machine and returns the raw native result.
 */
export async function updateAdList(opts: { conditional: boolean }) {
  dispatch({ type: 'adStart' });
  const res = await updateBlocklist(getBrowserPrefs().blocklistUrls, { conditional: opts.conditional });
  const outcome: AdUpdateOutcome = res.ok
    ? { ok: true, domains: res.domains, changed: res.changed }
    : { ok: false, code: res.code };
  dispatch({ type: 'adResult', result: adResultOf(outcome) });
  return res;
}

const deps = (): ListDeps => ({
  now: () => Date.now(),
  fetch: ((url, init) => fetch(url, init as RequestInit)) as TextFetch,
  verify: (body, sig) => maglevEngine.verifyListSignature(body, sig),
  known: new Set(PROVIDERS.map((p) => p.id)),
  net: readNet,
  rules,
  appliedSerial: () => getListPrefs().appliedSerial,
  apply: applyVerified,
  updateAdList: async (conditional) => {
    // The machine already moved to Downloading; call native directly so the event isn't sent twice.
    const res = await updateBlocklist(getBrowserPrefs().blocklistUrls, { conditional });
    return res.ok ? { ok: true, domains: res.domains, changed: res.changed } : { ok: false, code: res.code };
  },
  dispatch,
  isBusy: () => busy(state),
  markChecked: (at) => updateListPrefs({ lastListCheckAt: at }),
});

/** "Check now": both lists, ignoring the 24 h gate. A metered link is allowed; the network rules still apply. */
export async function checkListsNow(): Promise<boolean> {
  return runListCheck(deps(), { manual: true });
}

async function onActive(): Promise<void> {
  if (busy(state)) return;
  const p = getListPrefs();
  if (!autoCheckDue({ now: Date.now(), lastListCheckAt: p.lastListCheckAt, autoCheck: p.listsAutoCheck })) return;
  // Blocked or offline: not a check yet, so the next time the app opens tries again instead of waiting 24 h.
  const net = await readNet();
  if (!net || !net.connected) return;
  const r = rules();
  if ((r.wifiOnly && net.metered) || (r.vpnOnly && !net.vpn)) return;
  await runListCheck(deps(), { manual: false });
}

/**
 * Called by `startUpdates` (utils/update/index.ts), so it shares that foreground hook but keeps its own gate and
 * prefs. Loads the stored file first, so search sees it before any check. Safe to call again.
 */
export function startListUpdates(): () => void {
  if (started) return () => {};
  started = true;
  setAppliedFile(getListPrefs().sourcesFile);
  if (AppState.currentState === 'active') void onActive();
  const sub = AppState.addEventListener('change', (next) => {
    if (next === 'active') void onActive();
  });
  return () => {
    sub.remove();
    started = false;
  };
}
