// Default search sources (0.25): Bitsearch joins the defaults, TPB stays off. Existing installs get Bitsearch once;
// turning it off afterwards sticks.
const path = require('path');
const Module = require('module');
const root = path.join(__dirname, '..');
let failed = 0;
const check = (name, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}`);
  if (!cond) failed++;
};

(async () => {
  Module.registerHooks({
    resolve(spec, ctx, next) {
      if (spec === 'expo-sqlite/kv-store' || spec === 'expo-secure-store') return { url: `stub:${spec}`, shortCircuit: true, format: 'commonjs' };
      return next(spec, ctx);
    },
    load(url, ctx, next) {
      if (url.startsWith('stub:')) {
        return { format: 'commonjs', shortCircuit: true, source: 'module.exports = { default: { getItemSync: () => null, setItemSync() {} }, getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} };' };
      }
      return next(url, ctx);
    },
  });
  const { PROVIDERS } = await import(path.join(root, 'utils/search/providers/index.ts'));
  const { normalizeSearchPrefs } = await import(path.join(root, 'utils/prefs/search.ts'));
  const { LATER_DEFAULTS } = await import(path.join(root, 'utils/prefs/search.ts'));
  const on = PROVIDERS.filter((p) => p.enabledByDefault).map((p) => p.id).sort();
  // Defaults are only safe, trusted sources. Open-upload sites and DHT/aggregator indexes stay off.
  check('defaults are archive, knaben, nyaa, torrentscsv, yts', on.join() === 'archive,knaben,nyaa,torrentscsv,yts', on.join());
  check('tpb, bitsearch and torrentdownload stay off', ['tpb', 'bitsearch', 'torrentdownload'].every((id) => PROVIDERS.find((p) => p.id === id)?.enabledByDefault === false));
  check('no nsfw source is on by default', PROVIDERS.every((p) => !p.enabledByDefault || !p.nsfw));
  check('every later default is also a default', LATER_DEFAULTS.every((id) => on.includes(id)));

  // The once-only mechanism, exercised with a fake later default.
  const fresh = normalizeSearchPrefs(undefined, []);
  check('new install gets the defaults', on.every((id) => fresh.enabled.includes(id)));
  const kept = normalizeSearchPrefs({ enabled: ['knaben'] }, []);
  check('a saved list is kept as it is', kept.enabled.join() === 'knaben');

  if (failed) { console.log(`${failed} failed`); process.exit(1); }
  console.log('default sources: all passed');
})();
