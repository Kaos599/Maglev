// Default search sources: Gutenberg and LibriVox join the defaults, TPB stays off. Existing installs get them once;
// turning one off afterwards sticks.
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
  check('defaults are archive, gutenberg, knaben, librivox, nyaa, torrentscsv, yts', on.join() === 'archive,gutenberg,knaben,librivox,nyaa,torrentscsv,yts', on.join());
  check('tpb, bitsearch and torrentdownload stay off', ['tpb', 'bitsearch', 'torrentdownload'].every((id) => PROVIDERS.find((p) => p.id === id)?.enabledByDefault === false));
  check('no nsfw source is on by default', PROVIDERS.every((p) => !p.enabledByDefault || !p.nsfw));
  check('every later default is also a default', LATER_DEFAULTS.every((id) => on.includes(id)));

  check('later defaults are exactly gutenberg and librivox', LATER_DEFAULTS.join() === 'gutenberg,librivox');
  check('other new sources are not later defaults', ['showrss', 'distrowatch', 'acgrip', 'u3c3'].every((id) => !LATER_DEFAULTS.includes(id) && PROVIDERS.find((p) => p.id === id)?.enabledByDefault === false));

  const fresh = normalizeSearchPrefs(undefined, []);
  check('new install gets the defaults', on.every((id) => fresh.enabled.includes(id)));
  const kept = normalizeSearchPrefs({ enabled: ['knaben'] }, []);
  check('existing install gets gutenberg and librivox once', kept.enabled.includes('knaben') && LATER_DEFAULTS.every((id) => kept.enabled.includes(id)) && kept.enabled.length === 1 + LATER_DEFAULTS.length, kept.enabled.join());
  check('and records them as added', LATER_DEFAULTS.every((id) => kept.defaultsAdded.includes(id)));
  const off = normalizeSearchPrefs({ enabled: ['knaben'], defaultsAdded: ['gutenberg', 'librivox'] }, []);
  check('turned off after being added stays off', off.enabled.join() === 'knaben');
  const partial = normalizeSearchPrefs({ enabled: ['knaben'], defaultsAdded: ['gutenberg'] }, []);
  check('only the not-yet-added one comes in', partial.enabled.includes('librivox') && !partial.enabled.includes('gutenberg'));
  const twice = normalizeSearchPrefs(kept, []);
  check('no duplicates on a second pass', new Set(twice.enabled).size === twice.enabled.length && twice.enabled.length === kept.enabled.length);

  if (failed) { console.log(`${failed} failed`); process.exit(1); }
  console.log('default sources: all passed');
})();
