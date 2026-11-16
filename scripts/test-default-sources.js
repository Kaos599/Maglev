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
  const on = PROVIDERS.filter((p) => p.enabledByDefault).map((p) => p.id).sort();
  check('defaults are archive, bitsearch, knaben, nyaa, torrentscsv, yts', on.join() === 'archive,bitsearch,knaben,nyaa,torrentscsv,yts');
  check('tpb stays off by default', PROVIDERS.find((p) => p.id === 'tpb')?.enabledByDefault === false);
  check('no nsfw source is on by default', PROVIDERS.every((p) => !p.enabledByDefault || !p.nsfw));

  const fresh = normalizeSearchPrefs(undefined, []);
  check('new install has bitsearch on', fresh.enabled.includes('bitsearch'));

  const old = normalizeSearchPrefs({ enabled: ['knaben', 'yts'] }, []);
  check('existing install gets bitsearch once', old.enabled.includes('bitsearch') && old.enabled.includes('knaben') && old.enabled.includes('yts'));
  check('and it is recorded as offered', old.defaultsAdded.includes('bitsearch'));

  const turnedOff = normalizeSearchPrefs({ enabled: ['knaben'], defaultsAdded: ['bitsearch'] }, []);
  check('turned off after the offer stays off', !turnedOff.enabled.includes('bitsearch'));

  const twice = normalizeSearchPrefs(old, []);
  check('normalising again adds no duplicate', twice.enabled.filter((x) => x === 'bitsearch').length === 1);

  if (failed) { console.log(`${failed} failed`); process.exit(1); }
  console.log('default sources: all passed');
})();
