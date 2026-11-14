/**
 * State machine L1 for the self-updating lists (docs/NATIVE_CONTRACT.md section 31.6). Pure: no React Native
 * imports, so Node tests run it. Two halves report on their own, so one failing never blocks the other:
 *
 *   sources: Idle -> Checking -> Verifying -> Applied(changed n) | Unchanged | Rejected(signature|schema|serial)
 *                                            | Failed(network|http|blocked)
 *   ad list: Idle -> Downloading -> Updated(domains) | NotModified | Failed(network|http|blocked|invalid)
 *                  Idle -> Skipped (automatic check on a metered link)
 */

export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type RejectedWhy = 'signature' | 'schema' | 'serial';
export type FailedWhy = 'network' | 'http' | 'blocked';

export type SourcesState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'verifying' }
  | { kind: 'applied'; changed: number }
  | { kind: 'unchanged' }
  | { kind: 'rejected'; why: RejectedWhy }
  | { kind: 'failed'; why: FailedWhy };

export type AdState =
  | { kind: 'idle' }
  | { kind: 'downloading' }
  | { kind: 'updated'; domains: number }
  | { kind: 'notModified' }
  | { kind: 'skipped' }
  | { kind: 'failed'; why: FailedWhy | 'invalid' };

export interface ListsState {
  sources: SourcesState;
  ad: AdState;
}

export const initialState: ListsState = { sources: { kind: 'idle' }, ad: { kind: 'idle' } };

export type SourcesResult = Extract<SourcesState, { kind: 'applied' | 'unchanged' | 'rejected' | 'failed' }>;
export type AdResult = Extract<AdState, { kind: 'updated' | 'notModified' | 'skipped' | 'failed' }>;

export type ListsEvent =
  /** A check begins: the sources half moves to Checking. Ignored while a half is working. */
  | { type: 'start' }
  /** The file and its signature arrived. */
  | { type: 'fetched' }
  | { type: 'sourcesResult'; result: SourcesResult }
  /** The ad list download begins. Ignored while the sources half is working. */
  | { type: 'adStart' }
  | { type: 'adResult'; result: AdResult };

export const sourcesBusy = (s: ListsState): boolean => s.sources.kind === 'checking' || s.sources.kind === 'verifying';
export const adBusy = (s: ListsState): boolean => s.ad.kind === 'downloading';
export const busy = (s: ListsState): boolean => sourcesBusy(s) || adBusy(s);

export function reduce(state: ListsState, e: ListsEvent): ListsState {
  switch (e.type) {
    case 'start':
      if (busy(state)) return state;
      return { sources: { kind: 'checking' }, ad: { kind: 'idle' } };
    case 'fetched':
      return state.sources.kind === 'checking' ? { ...state, sources: { kind: 'verifying' } } : state;
    case 'sourcesResult':
      return sourcesBusy(state) ? { ...state, sources: e.result } : state;
    case 'adStart':
      // The ad list half also runs on its own (Browser > Update now), so only the other half's work blocks it.
      if (sourcesBusy(state) || adBusy(state)) return state;
      return { ...state, ad: { kind: 'downloading' } };
    case 'adResult':
      if (adBusy(state)) return { ...state, ad: e.result };
      // Skipped needs no download: it is reported straight from Idle.
      return e.result.kind === 'skipped' && !sourcesBusy(state) ? { ...state, ad: e.result } : state;
  }
}

/** The 24 h gate for the automatic check (31.3). A clock that went backwards counts as due. */
export function autoCheckDue(args: { now: number; lastListCheckAt: number | null; autoCheck: boolean }): boolean {
  if (!args.autoCheck) return false;
  return args.lastListCheckAt === null || args.lastListCheckAt > args.now || args.now - args.lastListCheckAt >= CHECK_INTERVAL_MS;
}

/** What a fetched, verified file means for the stored serial (31.1 "Rollback protection"). */
export function serialDecision(fileSerial: number, appliedSerial: number): 'apply' | 'unchanged' | 'rollback' {
  if (fileSerial > appliedSerial) return 'apply';
  return fileSerial === appliedSerial ? 'unchanged' : 'rollback';
}

export interface ListsNet {
  connected: boolean;
  metered: boolean;
  vpn: boolean;
}
export type NetRules = { wifiOnly: boolean; vpnOnly: boolean };

/**
 * Whether the network rules let the check go out at all: offline is 'network', Wi-Fi only on a metered link or VPN
 * only without a VPN is 'blocked' (the same two settings search honours).
 */
export function netVerdict(net: ListsNet | null, rules: NetRules): 'ok' | 'network' | 'blocked' {
  if (!net || !net.connected) return 'network';
  if (rules.wifiOnly && net.metered) return 'blocked';
  if (rules.vpnOnly && !net.vpn) return 'blocked';
  return 'ok';
}

/** The ad list downloads on its own only on an unmetered link; a manual check allows a metered one. */
export function adListAllowed(net: ListsNet | null, rules: NetRules, manual: boolean): boolean {
  if (netVerdict(net, rules) !== 'ok' || net === null) return false;
  return manual || !net.metered;
}
