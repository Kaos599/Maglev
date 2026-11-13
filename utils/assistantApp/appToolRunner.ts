/**
 * Binds the real search, prefs and engine modules into the pure tool runner (build step 12).
 * This is the only assistant file that imports the engine and the search stack.
 */
import { maglevEngine } from 'maglev-engine';
import { loadExtraProviders } from '../../components/search/extra';
import { providerMap } from '../../components/search/meta';
import { getSearchPrefs } from '../prefs/search';
import { resolveResult, searchAll } from '../search/aggregate';
import { browseAll } from '../search/browse';
import type { ToolRunner } from '../assistant/runtime';
import { createToolRunner } from '../assistant/toolRunner';
import { watchApi } from '../watch/store';

export function createAppToolRunner(): ToolRunner {
  return createToolRunner({
    watch: watchApi,
    async search(query, category, opts) {
      const prefs = getSearchPrefs();
      const providers = providerMap(prefs);
      const extraProviders = await loadExtraProviders(prefs.torznab);
      return searchAll(query, category, {
        ...prefs,
        // D2: the assistant never searches adult content, whatever the Search tab is set to.
        adult: false,
        enabled: prefs.enabled.filter((id) => !providers.get(id)?.nsfw),
        extraProviders,
        signal: opts.signal,
        onUpdate: opts.onUpdate,
      });
    },
    async browse(kind, order, period, opts) {
      const prefs = getSearchPrefs();
      const providers = providerMap(prefs);
      // Same prefs as search: enabled sources, per-source kinds, mirrors and wait. Never adult (D2).
      return browseAll(kind, order, period, {
        ...prefs,
        adult: false,
        enabled: prefs.enabled.filter((id) => !providers.get(id)?.nsfw),
        signal: opts.signal,
        onUpdate: opts.onUpdate,
      });
    },
    searchPrefs() {
      const prefs = getSearchPrefs();
      return { warnUnsafe: prefs.warnUnsafe, providers: providerMap(prefs) };
    },
    async resolveResult(result, signal) {
      const extra = await loadExtraProviders(getSearchPrefs().torznab);
      return resolveResult(result, signal, extra);
    },
    engine: maglevEngine,
    playbackSupport: () => maglevEngine.getPlaybackSupport().catch(() => null),
    now: () => Date.now(),
  });
}
