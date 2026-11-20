/**
 * The one place that says why a transfer is held (NATIVE_CONTRACT 35.2). Every `pausedBy` value, every
 * active-block tag and "queued" map to a card line, a banner title and body, the setting that fixes it,
 * and whether "Resume anyway" is allowed. Cards, detail screens and the Transfers banner read from here.
 * Pure: no React, no react-native.
 */
import type { ActiveBlock, ActiveBlockTag } from 'maglev-engine';

export interface ReasonSetting {
  label: string;
  route: string;
}

export interface Reason {
  key: string;
  /** The card line. */
  short: string;
  /** Banner and detail heading. */
  title: string;
  /** Banner and detail sentence. */
  body: string;
  /** The setting that changes this rule, or null when nothing in Settings does. */
  setting: ReasonSetting | null;
  /** Whether "Resume anyway" is allowed. False means the setting (or waiting) is the way out. */
  override: boolean;
}

/** What the table needs beyond the key: the active blocks (for numbers and the Wi-Fi cause) and the queue size. */
export interface BlockContext {
  blocks?: readonly ActiveBlock[];
  queueLimit?: number;
  /** The current time, for a schedule's "Resumes at". Defaults to now; tests pass their own. */
  nowMs?: number;
}

/** Everything a card or banner can be held for, in the order a banner shows them (NATIVE_CONTRACT 35.3). */
export const BANNER_ORDER: readonly ActiveBlockTag[] = [
  'storage_full',
  'offline',
  'network_unvalidated',
  'vpn_required',
  'wifi_only',
  'charging_only',
  'battery',
  'schedule',
  'seed_metered',
];

const NETWORK: ReasonSetting = { label: 'Network', route: '/settings/network' };
const POWER: ReasonSetting = { label: 'Power', route: '/settings/power' };

function clock(epochMs: number): string {
  const d = new Date(epochMs);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function fixed(key: string, short: string, title: string, body: string, setting: ReasonSetting | null, override: boolean): Reason {
  return { key, short, title, body, setting, override };
}

/** The reason for a `pausedBy` value, an active-block tag or "queued". Null for anything else (a null `pausedBy`, an unknown tag). */
export function reasonFor(key: string | null | undefined, ctx: BlockContext = {}): Reason | null {
  if (!key) return null;
  const block = ctx.blocks?.find((b) => b.tag === key);
  switch (key) {
    case 'wifi_only': {
      if (block?.cause === 'ssid') {
        return fixed(key, 'Waiting for an allowed Wi-Fi', 'Waiting for an allowed Wi-Fi', "This Wi-Fi isn't in your allowed networks.", { label: 'Allowed Wi-Fi networks', route: '/settings/network' }, false);
      }
      // NATIVE_CONTRACT 39.3 E2: metered is not always mobile data (hotspot, metered Wi-Fi). The short form stays short.
      return fixed(key, 'Waiting for Wi-Fi', 'Waiting for Wi-Fi', 'Wi-Fi only is on, and this connection is metered.', { label: 'Wi-Fi only', route: '/settings/network' }, true);
    }
    case 'battery': {
      const th = block?.thresholdPct;
      const lv = block?.levelPct;
      const title = th != null ? `Battery below ${th}%` : 'Battery is low';
      const body =
        th != null
          ? `Transfers pause when the battery is under ${th}% and not charging.${lv != null ? ` It's at ${lv}%.` : ''}`
          : 'Transfers pause when the battery is low and not charging.';
      return fixed(key, title, title, body, { label: 'Battery cut-off', route: '/settings/power' }, true);
    }
    case 'charging_only':
      return fixed(key, 'Waiting for the charger', 'Waiting for the charger', 'Charging only is on.', { label: 'Charging only', route: '/settings/power' }, true);
    case 'network_unvalidated':
      // NATIVE_CONTRACT 39.3 E2: also fires when the router has no internet; a sign-in page is only a possibility.
      return fixed(key, 'Waiting for internet', 'Waiting for internet', "This network can't reach the internet. If it has a sign-in page, open it.", null, false);
    case 'vpn_required':
      return fixed(key, 'Waiting for VPN', 'Waiting for VPN', 'VPN only is on, and no VPN is connected.', { label: 'VPN only', route: '/settings/network' }, false);
    case 'offline':
      return fixed(key, 'No internet connection', 'No internet connection', "Transfers continue when you're back online.", null, false);
    case 'schedule': {
      // A time that has already passed is stale: say the generic line instead of a past clock time.
      const at = block?.resumesAtMs != null && block.resumesAtMs > (ctx.nowMs ?? Date.now()) ? block.resumesAtMs : null;
      const body = at != null ? `Resumes at ${clock(at)}.` : "Your schedule doesn't allow transfers now.";
      return fixed(key, 'Paused by your schedule', 'Paused by your schedule', body, { label: 'Schedule', route: '/settings/scheduling' }, true);
    }
    case 'storage_full':
      return fixed(key, 'Storage full', 'Storage almost full', 'Maglev keeps some space free on your phone. Free up space to continue.', { label: 'Storage', route: '/settings/storage' }, false);
    case 'seed_metered':
      return fixed(key, 'Sharing waits for Wi-Fi', 'Sharing waits for Wi-Fi', 'Seeding on mobile data is off.', { label: 'Seeding on mobile data', route: '/settings/network' }, false);
    case 'fgs_timeout':
      return fixed(key, 'Stopped in the background', 'Stopped in the background', 'Android stopped Maglev after running a long time in the background. Tap Resume.', null, false);
    case 'queued': {
      const n = ctx.queueLimit;
      const has = n != null && n > 0;
      return fixed(
        key,
        has ? `Queued · ${n} at a time` : 'Queued',
        'Queued',
        has ? `${n} downloads run at a time. This one starts when one finishes.` : 'Only some downloads run at a time. This one starts when one finishes.',
        { label: 'Active downloads', route: '/settings/speed' },
        false,
      );
    }
    // Not held by a rule: the user's own pause, the seeding limit, and the health tags (NATIVE_CONTRACT 18.2).
    case 'user':
      return fixed(key, 'Paused', 'Paused', 'You paused this.', null, false);
    case 'seed_limit':
      return fixed(key, 'Done', 'Done', 'It reached your seeding limit.', null, false);
    case 'files_missing':
      return fixed(key, 'Files missing', 'Files missing', "Maglev can't find the downloaded files.", null, false);
    case 'files_changed':
      return fixed(key, 'Files changed', 'Files changed', 'The files on your phone changed since Maglev last checked.', null, false);
    case 'storage_unavailable':
      return fixed(key, 'SD card removed', 'Storage not available', "The folder isn't available. Is the SD card in?", { label: 'Storage', route: '/settings/storage' }, false);
    case 'no_peers':
      return fixed(key, 'No one sharing', 'No one sharing', 'No one has shared this for a while.', { label: 'Stop waiting for peers', route: '/settings/speed' }, false);
    default:
      return null;
  }
}

/** A block's own reason (numbers and cause come from the block itself). */
export function reasonForBlock(block: ActiveBlock, queueLimit?: number, nowMs?: number): Reason {
  return reasonFor(block.tag, { blocks: [block], queueLimit, nowMs }) as Reason;
}

function rank(tag: string): number {
  const i = (BANNER_ORDER as readonly string[]).indexOf(tag);
  return i < 0 ? BANNER_ORDER.length : i;
}

/** Blocks sorted by banner order. */
function sortBlocks(blocks: readonly ActiveBlock[]): ActiveBlock[] {
  return [...blocks].sort((a, b) => rank(a.tag) - rank(b.tag));
}

/**
 * The blocks the Transfers banner shows. Rules hold unfinished transfers; `seed_metered` holds only a
 * finished torrent that could be seeding.
 */
export function visibleBlocks(blocks: readonly ActiveBlock[], ctx: { hasUnfinished: boolean; hasSeedEligible: boolean }): ActiveBlock[] {
  return sortBlocks(blocks).filter((b) => (b.tag === 'seed_metered' ? ctx.hasSeedEligible : ctx.hasUnfinished));
}

/**
 * The number on "+N more": entries after the first. A seed-only hold (`seed_metered`) holds no download,
 * so it is left out of the count while a download-holding entry is shown. It still appears in the sheet.
 */
export function moreCount(keys: readonly string[]): number {
  if (keys.length <= 1) return 0;
  const rest = keys.slice(1);
  const holdsDownload = keys.some((k) => k !== 'seed_metered');
  return holdsDownload ? rest.filter((k) => k !== 'seed_metered').length : rest.length;
}

/**
 * Whether a Wi-Fi-only hold may be overridden with "Download now on mobile data". Not while another rule
 * that holds downloads (charger, battery, schedule, storage, VPN...) is also on: the override would not start it.
 */
export function wifiOverrideAllowed(blocks: readonly ActiveBlock[] | undefined): boolean {
  return !(blocks ?? []).some((b) => b.tag !== 'wifi_only' && b.tag !== 'seed_metered');
}

export interface HeldItem {
  finished: boolean;
  paused: boolean;
  queued: boolean;
  downloading: boolean;
  pausedBy?: string | null;
}

const NOT_A_RULE = new Set(['user', 'seed_limit', 'files_missing', 'files_changed', 'storage_unavailable', 'no_peers']);

/**
 * Every reason that holds this item, for the "Why it's paused" block. Lists each active block that
 * applies (not only the tag the item carries), then the queue. A user pause is not explained by blocks.
 */
export function reasonsForItem(item: HeldItem, blocks: readonly ActiveBlock[], queueLimit?: number, nowMs?: number): Reason[] {
  if (item.finished) return [];
  const ctx: BlockContext = { blocks, queueLimit, nowMs };
  const out: Reason[] = [];
  const add = (key: string) => {
    if (out.some((r) => r.key === key)) return;
    const r = reasonFor(key, ctx);
    if (r) out.push(r);
  };
  const own = item.pausedBy ?? null;
  const ruleHeld = item.paused && !!own && !NOT_A_RULE.has(own);
  const offlineRunning = item.downloading && blocks.some((b) => b.tag === 'offline');
  if (ruleHeld || offlineRunning) {
    for (const b of sortBlocks(blocks)) if (b.tag !== 'seed_metered') add(b.tag);
    if (ruleHeld && own !== 'seed_metered') add(own as string);
    out.sort((a, b) => rank(a.key) - rank(b.key));
  }
  if (item.queued) add('queued');
  return out;
}
