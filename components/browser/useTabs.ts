import { useCallback, useEffect, useRef, useState } from 'react';
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
  type TabsState,
  type UndoClose,
} from '../../utils/browser/tabs';
import { flushTabs, loadTabs, scheduleSaveTabs } from '../../utils/history';

/**
 * The tabs of the open browser screen (contract 24.10). The state is pure (utils/browser/tabs.ts); this hook holds it,
 * restores it from the history database the first time the screen opens in this process, and saves it 500 ms after
 * every change. Closing the screen keeps the state in memory, so opening it again brings the same tabs back.
 */
let remembered: TabsState | null = null;

const env = () => ({ now: Date.now() });

export function useTabs() {
  const [state, setState] = useState<TabsState | null>(remembered);
  const ref = useRef<TabsState | null>(remembered);

  const commit = useCallback((next: TabsState) => {
    ref.current = next;
    remembered = next;
    setState(next);
    const { rows, activeId } = toRows(next);
    scheduleSaveTabs(rows, activeId);
  }, []);

  // First open in this process: read the saved tabs. Any failure leaves one blank tab.
  useEffect(() => {
    if (ref.current) return;
    let gone = false;
    loadTabs()
      .then((saved) => restoreTabs(saved.tabs, saved.activeId, env()))
      .catch(() => createTabsState(env()))
      .then((next) => {
        if (gone || ref.current) return;
        ref.current = next;
        remembered = next;
        setState(next);
      });
    return () => {
      gone = true;
    };
  }, []);

  useEffect(
    () => () => {
      void flushTabs();
    },
    [],
  );

  const open = useCallback(
    (opts: { url?: string; title?: string; opener?: string | null; background?: boolean }): OpenResult => {
      const cur = ref.current ?? createTabsState(env());
      const r = openTab(cur, opts, env());
      if (r.result === 'ok') commit(r.state);
      return r;
    },
    [commit],
  );
  const select = useCallback(
    (id: string) => {
      if (ref.current) commit(selectTab(ref.current, id, env()));
    },
    [commit],
  );
  const update = useCallback(
    (id: string, patch: { url?: string; title?: string }) => {
      if (ref.current) commit(updateTab(ref.current, id, patch));
    },
    [commit],
  );
  const close = useCallback(
    (id: string): UndoClose | null => {
      if (!ref.current) return null;
      const r = closeTab(ref.current, id, env());
      if (r.undo) commit(r.state);
      return r.undo;
    },
    [commit],
  );
  const closeEvery = useCallback((): UndoClose | null => {
    if (!ref.current) return null;
    const r = closeAllTabs(ref.current, env());
    commit(r.state);
    return r.undo;
  }, [commit]);
  const undo = useCallback(
    (payload: UndoClose) => {
      if (ref.current) commit(undoClose(ref.current, payload, env()));
    },
    [commit],
  );

  return { state, ref, open, select, update, close, closeAll: closeEvery, undo };
}
