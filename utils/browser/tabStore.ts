/**
 * The one tab set (docs/NATIVE_CONTRACT.md section 30, amends 24.10). Module-level state with subscribe, wrapping the
 * pure functions in tabs.ts. Every BrowserScreen instance (the Browse tab and the /browser stack route) reads this
 * store, so they always agree. No React and no native imports: the history database, the prefs and the native wipe
 * counter come in through `bindTabStore`, so tests can run it with fakes.
 */
import {
  closeAll as closeAllTabs,
  closeTab,
  createTabsState,
  openTab,
  restoreTabs,
  selectTab,
  toRows,
  undoClose,
  updateTab,
  type OpenResult,
  type TabRow,
  type TabsState,
  type UndoClose,
} from './tabs.ts';

export type TabStoreDeps = {
  /** Saved tabs, or none. Never throws. */
  load(): Promise<{ tabs: TabRow[]; activeId: string | null }>;
  /** Saves 500 ms after the last call. */
  scheduleSave(rows: TabRow[], activeId: string | null): void;
  /** Writes pending tabs now. */
  flush(): Promise<void>;
  /** Deletes every saved tab and drops pending saves. */
  deleteSaved(): Promise<void>;
  /** The "Save history" setting right now. */
  saveHistory(): boolean;
  /** Calls `fn` after every change to the browser prefs. */
  subscribePrefs(fn: () => void): () => void;
  /** How many times native emptied the history on close. */
  wipeCount(): Promise<number>;
};

const noDeps: TabStoreDeps = {
  load: async () => ({ tabs: [], activeId: null }),
  scheduleSave: () => {},
  flush: async () => {},
  deleteSaved: async () => {},
  saveHistory: () => true,
  subscribePrefs: () => () => {},
  wipeCount: async () => 0,
};

const env = () => ({ now: Date.now() });

export function createTabStore(initialDeps: TabStoreDeps = noDeps) {
  let deps = initialDeps;
  let state: TabsState | null = null;
  let restoring: Promise<void> | null = null;
  let lastSaveHistory: boolean | null = null;
  let lastWipe: number | null = null;
  const listeners = new Set<() => void>();

  const emit = () => listeners.forEach((l) => l());

  function persist(next: TabsState): void {
    if (!deps.saveHistory()) return; // memory-only while "Save history" is off
    const { rows, activeId } = toRows(next);
    deps.scheduleSave(rows, activeId);
  }

  function commit(next: TabsState): void {
    state = next;
    persist(next);
    emit();
  }

  /** Reacts to the "Save history" setting: off deletes the saved rows, on saves the current tabs again. */
  function onPrefs(): void {
    const on = deps.saveHistory();
    if (lastSaveHistory === on) return;
    const was = lastSaveHistory;
    lastSaveHistory = on;
    if (was === null) return;
    if (!on) void deps.deleteSaved();
    else if (state) persist(state);
  }
  let unsubPrefs: (() => void) | null = null;

  const api = {
    /** Replaces the injected pieces (the real ones are bound by components/browser/useTabs.ts). */
    bind(next: TabStoreDeps): void {
      unsubPrefs?.();
      deps = next;
      lastSaveHistory = deps.saveHistory();
      unsubPrefs = deps.subscribePrefs(onPrefs);
    },

    getState: (): TabsState | null => state,

    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },

    /** Restores from the saved tabs once per process. Later calls return the same promise. Any failure leaves one blank tab. */
    ensureRestored(): Promise<void> {
      if (state) return Promise.resolve();
      if (!restoring) {
        restoring = (async () => {
          let next: TabsState;
          try {
            // With "Save history" off nothing is read and nothing is written.
            const saved = deps.saveHistory() ? await deps.load() : { tabs: [], activeId: null };
            next = restoreTabs(saved.tabs, saved.activeId, env());
          } catch {
            next = createTabsState(env());
          }
          if (!state) {
            state = next;
            emit();
          }
        })();
      }
      return restoring;
    },

    /**
     * Call when a browser screen mounts. When native emptied the history since the last time JS looked (the activity
     * was finished with "Clear history when Maglev closes" on), the in-memory tabs are stale: one blank tab.
     */
    async checkWipe(): Promise<void> {
      let n: number;
      try {
        n = await deps.wipeCount();
      } catch {
        return;
      }
      if (lastWipe === null) {
        lastWipe = n;
        return;
      }
      if (n === lastWipe) return;
      lastWipe = n;
      if (state) commit(createTabsState(env()));
    },

    open(opts: { url?: string; title?: string; opener?: string | null; background?: boolean }): OpenResult {
      const cur = state ?? createTabsState(env());
      const r = openTab(cur, opts, env());
      if (r.result === 'ok') commit(r.state);
      return r;
    },
    select(id: string): void {
      if (state) commit(selectTab(state, id, env()));
    },
    update(id: string, patch: { url?: string; title?: string }): void {
      if (state) commit(updateTab(state, id, patch));
    },
    close(id: string): UndoClose | null {
      if (!state) return null;
      const r = closeTab(state, id, env());
      if (r.undo) commit(r.state);
      return r.undo;
    },
    closeAll(): UndoClose | null {
      if (!state) return null;
      const r = closeAllTabs(state, env());
      commit(r.state);
      return r.undo;
    },
    undo(payload: UndoClose): void {
      if (state) commit(undoClose(state, payload, env()));
    },
    flush: (): Promise<void> => deps.flush(),
  };
  return api;
}

export type TabStore = ReturnType<typeof createTabStore>;

/** The process-wide store every screen instance uses. */
export const tabStore = createTabStore();
