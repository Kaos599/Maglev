import { useEffect, useSyncExternalStore } from 'react';
import { getHistoryWipeCount } from 'maglev-engine';
import type { TabsState } from '../../utils/browser/tabs';
import { tabStore } from '../../utils/browser/tabStore';
import { deleteSavedTabs, flushTabs, loadTabs, scheduleSaveTabs } from '../../utils/history';
import { getBrowserPrefs, subscribeBrowserPrefs } from '../../utils/prefs/browser';

// Section 30: bind the one store to the history database, the prefs and the native wipe counter, once per process.
tabStore.bind({
  load: loadTabs,
  scheduleSave: scheduleSaveTabs,
  flush: flushTabs,
  deleteSaved: deleteSavedTabs,
  saveHistory: () => getBrowserPrefs().saveHistory,
  subscribePrefs: subscribeBrowserPrefs,
  wipeCount: getHistoryWipeCount,
});

/** Always the latest state, for callbacks that must not close over a render. */
const ref = {
  get current(): TabsState | null {
    return tabStore.getState();
  },
};

const actions = {
  ref,
  open: tabStore.open,
  select: tabStore.select,
  update: tabStore.update,
  close: tabStore.close,
  closeAll: tabStore.closeAll,
  undo: tabStore.undo,
};

/**
 * The tabs of every browser screen (contract section 30). The state lives in utils/browser/tabStore.ts and is shared by
 * the Browse tab and the /browser stack route; this hook only reads it and restores it the first time it is needed.
 */
export function useTabs() {
  const state = useSyncExternalStore(tabStore.subscribe, tabStore.getState, tabStore.getState);
  useEffect(() => {
    void tabStore.ensureRestored();
    void tabStore.checkWipe();
    return () => {
      void tabStore.flush();
    };
  }, []);
  return { state, ...actions };
}
