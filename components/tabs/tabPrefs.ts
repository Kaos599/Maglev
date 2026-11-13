/**
 * Which tabs show and in what order. Pure helpers (no imports) so node tests can run them.
 * Ids are the route names under app/(tabs). Transfers and Settings are always shown.
 * The Assistant tab also needs Settings > Assistant to be on: that setting decides whether the
 * assistant exists, this list only decides where its tab sits and whether it shows.
 */

export type TabId = 'index' | 'search' | 'feeds' | 'settings' | 'assistant' | 'browse';

/** Today's bar, then the optional Browser. */
export const TAB_IDS: readonly TabId[] = ['index', 'search', 'feeds', 'settings', 'assistant', 'browse'];

/** Tabs that cannot be hidden. */
export const LOCKED_TABS: readonly TabId[] = ['index', 'settings'];

const HIDDEN_BY_DEFAULT: readonly TabId[] = ['browse'];

export interface TabPrefs {
  /** Every tab id, in bar order (hidden ones keep their place). */
  order: TabId[];
  /** Tabs the user turned off. */
  hidden: TabId[];
}

export function defaultTabPrefs(): TabPrefs {
  return { order: [...TAB_IDS], hidden: [...HIDDEN_BY_DEFAULT] };
}

const isId = (v: unknown): v is TabId => typeof v === 'string' && (TAB_IDS as readonly string[]).includes(v);
const unique = (ids: TabId[]) => ids.filter((id, i) => ids.indexOf(id) === i);

/** Tolerant parse: missing prefs give defaults, unknown ids are dropped, new ids are appended. */
export function normalizeTabPrefs(raw: unknown): TabPrefs {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const storedOrder = Array.isArray(o.order) ? unique(o.order.filter(isId)) : [];
  const order = [...storedOrder, ...TAB_IDS.filter((id) => !storedOrder.includes(id))];
  const storedHidden = Array.isArray(o.hidden) ? o.hidden.filter(isId) : null;
  // A tab missing from the stored order is new to this install: it starts at its default.
  const newcomers = TAB_IDS.filter((id) => !storedOrder.includes(id) && HIDDEN_BY_DEFAULT.includes(id));
  const hidden = unique([...(storedHidden ?? HIDDEN_BY_DEFAULT), ...newcomers]).filter((id) => !LOCKED_TABS.includes(id));
  return { order, hidden };
}

export function setTabShown(prefs: TabPrefs, id: TabId, shown: boolean): TabPrefs {
  if (LOCKED_TABS.includes(id)) return prefs;
  const hidden = shown ? prefs.hidden.filter((h) => h !== id) : unique([...prefs.hidden, id]);
  return { order: prefs.order, hidden };
}

/**
 * Swap a tab with its neighbour. `listed` limits the neighbours to rows the screen shows, so a
 * tab that is not listed (Assistant while it is off) is stepped over.
 */
export function moveTab(prefs: TabPrefs, id: TabId, dir: 'up' | 'down', listed?: readonly TabId[]): TabPrefs {
  const rows = prefs.order.filter((x) => !listed || listed.includes(x));
  const at = rows.indexOf(id);
  const other = rows[dir === 'up' ? at - 1 : at + 1];
  if (at < 0 || other === undefined) return prefs;
  const order = [...prefs.order];
  const a = order.indexOf(id);
  const b = order.indexOf(other);
  order[a] = other;
  order[b] = id;
  return { order, hidden: prefs.hidden };
}

/** The tabs on the bar, in order. */
export function visibleTabs(prefs: TabPrefs, opts: { assistantEnabled: boolean }): TabId[] {
  const shown = prefs.order.filter(
    (id) => !prefs.hidden.includes(id) && (id !== 'assistant' || opts.assistantEnabled),
  );
  // Never an empty bar.
  return LOCKED_TABS.reduce<TabId[]>((acc, id) => (acc.includes(id) ? acc : [...acc, id]), shown);
}
