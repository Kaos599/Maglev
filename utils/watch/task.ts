// The background job. Import this file once for its side effect, at the top of app/_layout.tsx, so the task is
// defined in the global scope in the app and in the headless run (docs/contracts-0.19/watch.md section 2).
//   TaskManager.defineTask: https://docs.expo.dev/versions/v58.0.0/sdk/task-manager/
//   BackgroundTask:         https://docs.expo.dev/versions/v58.0.0/sdk/background-task/
import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import Storage from 'expo-sqlite/kv-store';
import { loadExtraProviders } from '../../components/search/extra';
import { providerMap } from '../../components/search/meta';
import { getSearchPrefs } from '../prefs/search';
import { searchAll } from '../search/aggregate';
import { runWatchCycle, type CycleDeps } from './cycle';
import { hasActive, jobIntervalMinutes, type Watch } from './logic';
import { postWatchNotification, watchNetwork } from './native';
import { onWatchesChanged } from './store';
import { createWatchStore } from './storeCore';

export const WATCH_TASK = 'maglev-watch-check';

/** Searches the way the Search tab does, never adult, and fails when no source answered. */
async function searchOnce(query: string, category: Watch['category']) {
  const prefs = getSearchPrefs();
  const providers = providerMap(prefs);
  const extraProviders = await loadExtraProviders(prefs.torznab);
  const ac = new AbortController();
  const update = await searchAll(query, category === 'adult' ? 'all' : category, {
    ...prefs,
    adult: false,
    enabled: prefs.enabled.filter((id) => !providers.get(id)?.nsfw),
    extraProviders,
    signal: ac.signal,
  });
  const answered = update.sources.some((s) => s.state === 'done' || s.state === 'empty');
  if (!answered) throw new Error('no source answered');
  return update.results;
}

export function liveDeps(): CycleDeps {
  const store = createWatchStore(Storage);
  return {
    now: () => Date.now(),
    list: store.list,
    save: store.save,
    network: watchNetwork,
    search: searchOnce,
    notify: postWatchNotification,
  };
}

TaskManager.defineTask(WATCH_TASK, async () => {
  try {
    await runWatchCycle(liveDeps());
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

/** Registers the job at the shortest active interval, or removes it when nothing is being watched. Safe to call often. */
export async function syncWatchTask(list: Watch[]): Promise<void> {
  try {
    if (hasActive(list)) {
      await BackgroundTask.registerTaskAsync(WATCH_TASK, { minimumInterval: jobIntervalMinutes(list) });
    } else if (await TaskManager.isTaskRegisteredAsync(WATCH_TASK)) {
      await BackgroundTask.unregisterTaskAsync(WATCH_TASK);
    }
  } catch {
    // Background work is unavailable (for example in Expo Go). The list still works; the next change retries.
  }
}

onWatchesChanged((list) => void syncWatchTask(list));
