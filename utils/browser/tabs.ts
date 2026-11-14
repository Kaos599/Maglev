/**
 * Browser tabs: pure state (docs/NATIVE_CONTRACT.md section 24.10, machines T1 and T2). No React, no native imports.
 *
 * `tabs` is kept in creation order (that order is the saved `position`); the switcher shows it newest first.
 * Every function returns a new state and never changes the one it was given.
 */

/** At most this many tabs have a native view: the active one and the two most recently active. */
export const MAX_LIVE = 3;
/** Opening a tab beyond this many shows a notice and opens nothing. */
export const MAX_TABS = 50;

/** `closing` only appears on the tabs inside an undo payload. */
export type TabState = 'live' | 'asleep' | 'closing';

export type Tab = {
  id: string;
  /** '' for a blank tab. */
  url: string;
  title: string;
  /** The tab that opened this one, or null. Back closes the tab and returns to its opener (see `backTarget`). */
  opener: string | null;
  /** ms since epoch of the last time the tab was active. Decides which live tab sleeps first. */
  lastActive: number;
  state: TabState;
};

export type TabsState = { tabs: Tab[]; activeId: string };

/** What a saved tab looks like in the `tabs` table (24.10 Persistence). */
export type TabRow = { id: string; url: string; title: string; position: number; opener: string | null; lastActive: number };

/** Injected so tests are deterministic. */
export type TabsEnv = { now: number; newId?: () => string };

let counter = 0;
/** Default id: time plus a counter plus a random part. Unique within and across runs. */
export const defaultNewId = (): string => `t${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const idOf = (env: TabsEnv) => (env.newId ?? defaultNewId)();

const blank = (id: string, now: number, opener: string | null = null, state: TabState = 'live'): Tab => ({
  id,
  url: '',
  title: '',
  opener,
  lastActive: now,
  state,
});

/** One blank, live, active tab. */
export function createTabsState(env: TabsEnv): TabsState {
  const id = idOf(env);
  return { tabs: [blank(id, env.now)], activeId: id };
}

export const getTab = (s: TabsState, id: string): Tab | undefined => s.tabs.find((t) => t.id === id);
export const activeTab = (s: TabsState): Tab => getTab(s, s.activeId) ?? s.tabs[0];
export const liveTabs = (s: TabsState): Tab[] => s.tabs.filter((t) => t.state === 'live');
/** Switcher order: newest created first. */
export const switcherOrder = (s: TabsState): Tab[] => [...s.tabs].reverse();
export const isBlank = (t: Tab): boolean => t.url === '';

/** Puts the least recently active live tabs to sleep until at most MAX_LIVE are live. The active tab never sleeps. */
function enforceLive(s: TabsState): TabsState {
  let tabs = s.tabs;
  let live = tabs.filter((t) => t.state === 'live');
  while (live.length > MAX_LIVE) {
    const victim = live.filter((t) => t.id !== s.activeId).sort((a, b) => a.lastActive - b.lastActive)[0];
    if (!victim) break;
    tabs = tabs.map((t) => (t.id === victim.id ? { ...t, state: 'asleep' as const } : t));
    live = tabs.filter((t) => t.state === 'live');
  }
  return tabs === s.tabs ? s : { ...s, tabs };
}

export type OpenResult = { state: TabsState; id: string | null; result: 'ok' | 'cap' };

/**
 * New tab. Foreground (default): live and active. `background: true`: asleep, nothing switches.
 * At MAX_TABS nothing opens and `result` is 'cap' (the screen shows the cap notice).
 */
export function openTab(
  s: TabsState,
  opts: { url?: string; title?: string; opener?: string | null; background?: boolean },
  env: TabsEnv,
): OpenResult {
  if (s.tabs.length >= MAX_TABS) return { state: s, id: null, result: 'cap' };
  const id = idOf(env);
  const tab: Tab = {
    ...blank(id, env.now, opts.opener ?? null, opts.background ? 'asleep' : 'live'),
    url: opts.url ?? '',
    title: opts.title ?? '',
  };
  const tabs = [...s.tabs, tab];
  if (opts.background) return { state: { ...s, tabs }, id, result: 'ok' };
  return { state: enforceLive({ tabs, activeId: id }), id, result: 'ok' };
}

/** Switches to a tab, waking it when asleep. An unknown id changes nothing. */
export function selectTab(s: TabsState, id: string, env: TabsEnv): TabsState {
  if (!getTab(s, id)) return s;
  const tabs = s.tabs.map((t) => (t.id === id ? { ...t, state: 'live' as const, lastActive: env.now } : t));
  return enforceLive({ tabs, activeId: id });
}

/** The page of a tab changed (url or title). Only provided fields change. */
export function updateTab(s: TabsState, id: string, patch: { url?: string; title?: string }): TabsState {
  if (!getTab(s, id)) return s;
  return { ...s, tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...(patch.url !== undefined ? { url: patch.url } : {}), ...(patch.title !== undefined ? { title: patch.title } : {}) } : t)) };
}

/** What Undo needs to put closed tabs back. */
export type UndoClose = {
  /** The closed tabs, state 'closing', with the index each had. */
  closed: { tab: Tab; index: number }[];
  /** The tab that was active before the close. */
  previousActiveId: string;
  /** Set when the close left a fresh blank tab behind; Undo removes it. */
  blankId: string | null;
};

export type CloseResult = { state: TabsState; undo: UndoClose | null };

const closing = (t: Tab): Tab => ({ ...t, state: 'closing' });

/**
 * Closes a tab. When it was active, the opener (if it still exists) or else the most recently active tab becomes active.
 * Closing the last tab leaves one blank tab. `undo` is null for an unknown id.
 */
export function closeTab(s: TabsState, id: string, env: TabsEnv): CloseResult {
  const index = s.tabs.findIndex((t) => t.id === id);
  if (index < 0) return { state: s, undo: null };
  const tab = s.tabs[index];
  const rest = s.tabs.filter((t) => t.id !== id);
  const undo: UndoClose = { closed: [{ tab: closing(tab), index }], previousActiveId: s.activeId, blankId: null };
  if (rest.length === 0) {
    const fresh = createTabsState(env);
    undo.blankId = fresh.activeId;
    return { state: fresh, undo };
  }
  if (id !== s.activeId) return { state: { ...s, tabs: rest }, undo };
  const next = (tab.opener && rest.find((t) => t.id === tab.opener)) || [...rest].sort((a, b) => b.lastActive - a.lastActive)[0];
  return { state: selectTab({ tabs: rest, activeId: next.id }, next.id, env), undo };
}

/** Closes every tab and leaves one blank tab. */
export function closeAll(s: TabsState, env: TabsEnv): CloseResult {
  const fresh = createTabsState(env);
  return {
    state: fresh,
    undo: { closed: s.tabs.map((tab, index) => ({ tab: closing(tab), index })), previousActiveId: s.activeId, blankId: fresh.activeId },
  };
}

/**
 * Undo: puts the closed tabs back where they were. The previous active tab is active again when it came back,
 * and wakes. Closed tabs return asleep, except the one that becomes active. The blank tab a close-all or
 * close-last left behind goes away, but only while it is still blank.
 */
export function undoClose(s: TabsState, undo: UndoClose, env: TabsEnv): TabsState {
  // The blank tab goes only while it is still blank; a tab the user typed into is kept.
  let tabs = undo.blankId ? s.tabs.filter((t) => !(t.id === undo.blankId && isBlank(t))) : [...s.tabs];
  const have = new Set(tabs.map((t) => t.id));
  for (const { tab, index } of [...undo.closed].sort((a, b) => a.index - b.index)) {
    if (have.has(tab.id) || tabs.length >= MAX_TABS) continue;
    tabs.splice(Math.min(index, tabs.length), 0, { ...tab, state: 'asleep' });
  }
  const restoredActive = tabs.some((t) => t.id === undo.previousActiveId) && undo.closed.some((c) => c.tab.id === undo.previousActiveId);
  const activeId = restoredActive ? undo.previousActiveId : tabs.some((t) => t.id === s.activeId) ? s.activeId : tabs[tabs.length - 1].id;
  if (tabs.length === 0) return createTabsState(env);
  return selectTab({ tabs, activeId }, activeId, env);
}

/** The answer to Android back after the page has nothing to go back to. */
export type BackTarget = 'goBack' | { closeAndSwitchTo: string } | 'leave';

/** Back in the page while it can go back; then close the tab and switch to its opener when that opener still exists; else leave. */
export function backTarget(s: TabsState, tabId: string, canGoBack: boolean): BackTarget {
  if (canGoBack) return 'goBack';
  const tab = getTab(s, tabId);
  if (tab?.opener && getTab(s, tab.opener)) return { closeAndSwitchTo: tab.opener };
  return 'leave';
}

/** The rows to save. Addresses that aren't http(s) (a blank tab) save as ''. */
export function toRows(s: TabsState): { rows: TabRow[]; activeId: string } {
  return {
    rows: s.tabs.map((t, position) => ({
      id: t.id,
      url: /^https?:\/\//i.test(t.url) ? t.url : '',
      title: t.title,
      position,
      opener: t.opener,
      lastActive: t.lastActive,
    })),
    activeId: s.activeId,
  };
}

/**
 * Rebuilds the tabs from saved rows: every tab asleep, the saved active one woken. No usable rows means one blank tab.
 * Unknown active id falls back to the most recently active row. Openers that no longer exist become null. Rows beyond MAX_TABS are dropped.
 */
export function restoreTabs(rows: TabRow[], activeId: string | null, env: TabsEnv): TabsState {
  const valid = rows.filter((r) => r && typeof r.id === 'string' && r.id !== '').sort((a, b) => a.position - b.position);
  const seen = new Set<string>();
  const unique = valid.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true))).slice(0, MAX_TABS);
  if (unique.length === 0) return createTabsState(env);
  const tabs: Tab[] = unique.map((r) => ({
    id: r.id,
    url: r.url ?? '',
    title: r.title ?? '',
    opener: r.opener && seen.has(r.opener) && r.opener !== r.id ? r.opener : null,
    lastActive: Number(r.lastActive) || 0,
    state: 'asleep',
  }));
  const active = (activeId && tabs.find((t) => t.id === activeId)) || [...tabs].sort((a, b) => b.lastActive - a.lastActive)[0];
  return selectTab({ tabs, activeId: active.id }, active.id, env);
}
