/**
 * Pop-ups and redirects: pure logic (docs/NATIVE_CONTRACT.md section 24.10, machines T4 and T5).
 * `decideNewWindow` and `registrablePart` are mirrored in Kotlin. No React, no native imports.
 */

export type PopupPolicy = 'ask' | 'block' | 'allow';
export type PopupKind = 'window' | 'redirect' | 'app';

/** Host of an address, or the input itself when it already is a host. Lower case, no port, no "www.". */
export function hostFrom(input: string): string {
  let s = (input ?? '').trim();
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(s);
  if (m) s = m[1];
  const at = s.lastIndexOf('@');
  if (at >= 0) s = s.slice(at + 1);
  s = s.replace(/^\[|\]$/g, '').replace(/:\d*$/, '').toLowerCase().replace(/\.$/, '');
  return s.replace(/^www\./, '');
}

/**
 * The last two labels, or the last three when the second-to-last is 2-3 letters and the last is a 2-letter country code
 * (`co.uk`, `com.au`). A heuristic with no public suffix list. An IP address is returned whole.
 */
/** Generic second-level labels under a country code (`co.uk`, `com.au`). Mirrors RegistrableHost.SECOND_LEVEL in Kotlin. */
export const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'mil', 'nic', 'ne', 'or', 'go', 'gob', 'gv', 'ltd', 'plc', 'sch', 'nhs', 'res', 'me', 'info', 'biz']);

export function registrablePart(host: string): string {
  const h = hostFrom(host);
  if (/^[\d.]+$/.test(h) || h.includes(':')) return h;
  const labels = h.split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const last = labels[labels.length - 1];
  const second = labels[labels.length - 2];
  // Only generic second-level labels count, so `www.ard.de` and `ard.de` stay one site.
  const take = /^[a-z]{2}$/.test(last) && SECOND_LEVEL.has(second) ? 3 : 2;
  return labels.slice(-take).join('.');
}

/** True when both hosts (or addresses) share a registrable part. */
export function sameSite(a: string, b: string): boolean {
  const x = registrablePart(a);
  return x !== '' && x === registrablePart(b);
}

/** Suffix match on a label boundary: `m.example.com` is allowed by `example.com`. A leading "www." on either side is ignored. */
export function hostAllowed(host: string, allowHosts: readonly string[]): boolean {
  const h = hostFrom(host);
  if (!h) return false;
  return allowHosts.some((a) => {
    const n = hostFrom(a);
    return n !== '' && (h === n || h.endsWith('.' + n));
  });
}

export type NewWindowDecision = 'newTab' | 'blocked' | 'ask' | 'openApp';

/**
 * T4. `allowed` is `hostAllowed(pageHost, popupAllowHosts)`. For `window` and `redirect`, 'newTab' means "go ahead"
 * (a new tab for a window, `followRedirect` for a redirect). An untapped `app` is blocked whatever the policy says.
 */
export function decideNewWindow(args: { policy: PopupPolicy; allowed: boolean; gesture: boolean; kind: PopupKind }): NewWindowDecision {
  const { policy, allowed, gesture, kind } = args;
  if (kind === 'app') {
    if (!gesture) return 'blocked';
    if (policy === 'allow' || allowed) return 'openApp';
    return policy === 'block' ? 'blocked' : 'ask';
  }
  if (gesture) return 'newTab';
  if (policy === 'allow' || allowed) return 'newTab';
  return policy === 'block' ? 'blocked' : 'ask';
}

// ---- T5: the pop-up card, per tab ----

export type PopupRequest = { url: string; kind: PopupKind; sourceUrl: string };

/** `first` is the request the card shows (or, for a tab that isn't active, waits). `more` counts later ones. */
export type TabPrompt = { first: PopupRequest; more: number };

export type PopupsState = {
  prompts: Record<string, TabPrompt>;
  /** Pop-ups blocked on the tab's current page, for the "N blocked on this page" row. */
  blocked: Record<string, number>;
};

export const emptyPopups = (): PopupsState => ({ prompts: {}, blocked: {} });

const without = <T>(o: Record<string, T>, k: string): Record<string, T> => {
  const { [k]: _gone, ...rest } = o;
  return rest;
};

/** An onPopupRequest from a tab: it becomes the card's request, or adds to "and N more blocked". An inactive tab keeps 1 plus a count. */
export function request(s: PopupsState, tabId: string, req: PopupRequest): PopupsState {
  const cur = s.prompts[tabId];
  return { ...s, prompts: { ...s.prompts, [tabId]: cur ? { ...cur, more: cur.more + 1 } : { first: req, more: 0 } } };
}

/** The card to show for the active tab, or null. */
export const promptFor = (s: PopupsState, tabId: string | null | undefined): TabPrompt | null => (tabId ? s.prompts[tabId] ?? null : null);

/** The "and N more blocked" count, 0 when there is none. */
export const moreBlocked = (s: PopupsState, tabId: string): number => s.prompts[tabId]?.more ?? 0;

/** Blocked pop-ups on the tab's current page. */
export const blockedOnPage = (s: PopupsState, tabId: string): number => s.blocked[tabId] ?? 0;

/** An onPopupBlocked from a tab. */
export function noteBlocked(s: PopupsState, tabId: string, n = 1): PopupsState {
  return { ...s, blocked: { ...s.blocked, [tabId]: blockedOnPage(s, tabId) + n } };
}

export type Resolution = { state: PopupsState; request: PopupRequest | null };

/** Open: acts on the first request only. The later ones count as blocked. */
export function open(s: PopupsState, tabId: string): Resolution {
  const cur = s.prompts[tabId];
  if (!cur) return { state: s, request: null };
  const next = { ...s, prompts: without(s.prompts, tabId) };
  return { state: cur.more ? noteBlocked(next, tabId, cur.more) : next, request: cur.first };
}

/** Block: the first and the later ones all count as blocked. */
export function block(s: PopupsState, tabId: string): PopupsState {
  const cur = s.prompts[tabId];
  if (!cur) return s;
  return noteBlocked({ ...s, prompts: without(s.prompts, tabId) }, tabId, 1 + cur.more);
}

export type AllowResult = Resolution & { allowHosts: string[]; host: string | null };

/** "Always allow on {host}": the source host joins the allow list (no duplicates), then the first request opens. */
export function allowForSite(s: PopupsState, tabId: string, allowHosts: readonly string[]): AllowResult {
  const cur = s.prompts[tabId];
  if (!cur) return { state: s, request: null, allowHosts: [...allowHosts], host: null };
  const host = hostFrom(cur.first.sourceUrl) || null;
  const list = host && !hostAllowed(host, allowHosts) ? [...allowHosts, host] : [...allowHosts];
  return { ...open(s, tabId), allowHosts: list, host };
}

/**
 * The tab navigated to a new document ('navigated') or closed ('closed'). A waiting card counts as Blocked. Returns how many were
 * dropped. 'navigated' starts a new page, so its blocked count resets; 'closed' forgets the tab.
 */
export function drop(s: PopupsState, tabId: string, reason: 'navigated' | 'closed'): { state: PopupsState; dropped: number } {
  const cur = s.prompts[tabId];
  const dropped = cur ? 1 + cur.more : 0;
  const prompts = without(s.prompts, tabId);
  const blocked = reason === 'closed' ? without(s.blocked, tabId) : { ...s.blocked, [tabId]: 0 };
  return { state: { prompts, blocked }, dropped };
}
