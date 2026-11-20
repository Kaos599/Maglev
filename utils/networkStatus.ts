import { networkAdvancedCopy } from '../constants/copy.ts';

/** What the downloader says about the block list file it was given. */
export interface BlocklistStatus {
  state: 'off' | 'on' | 'unreadable';
  rules: number;
}

export interface NetworkStatus {
  /** True when saved network changes wait for a downloader restart. Null when the downloader did not say. */
  restartPending: boolean | null;
  /** Null when the downloader did not say. */
  blocklist: BlocklistStatus | null;
}

export const UNKNOWN_NETWORK_STATUS: NetworkStatus = { restartPending: null, blocklist: null };

/**
 * Reads `restartPending` and `blocklist` from a getEffectiveConfig result. Both fields are optional so an
 * older downloader still works, and either casing is accepted (the bridge may snake_case the keys).
 */
export function readNetworkStatus(res: unknown): NetworkStatus {
  if (!res || typeof res !== 'object') return UNKNOWN_NETWORK_STATUS;
  const r = res as Record<string, unknown>;
  const pending = r.restartPending ?? r.restart_pending;
  const raw = r.blocklist as { state?: unknown; rules?: unknown } | null | undefined;
  const state = raw?.state;
  const blocklist: BlocklistStatus | null =
    state === 'off' || state === 'on' || state === 'unreadable'
      ? { state, rules: typeof raw?.rules === 'number' && raw.rules >= 0 ? raw.rules : 0 }
      : null;
  return { restartPending: typeof pending === 'boolean' ? pending : null, blocklist };
}

/** Subtitle of the "Block listed IPs" row. `danger` paints it in the danger colour. */
export function blocklistSubtitle(fileName: string, blocklist: BlocklistStatus | null): { text: string; danger: boolean } {
  const base = fileName || networkAdvancedCopy.noFile;
  if (blocklist?.state === 'unreadable') return { text: networkAdvancedCopy.unreadable, danger: true };
  if (blocklist?.state === 'on') return { text: `${base} · ${networkAdvancedCopy.rules(blocklist.rules)}`, danger: false };
  return { text: base, danger: false };
}
