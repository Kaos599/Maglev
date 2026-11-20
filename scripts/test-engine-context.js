#!/usr/bin/env node
// Engine context split: a telemetry tick must not re-render the whole app, and fonts are embedded at
// build time (expo-font config plugin) so first paint does not wait on useFonts.
// Source-level checks, plain node.

const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}

const ctx = read('context/EngineContext.tsx');
const layout = read('app/_layout.tsx');
const noticeHost = read('components/ui/NoticeHost.tsx');
const starPrompt = read('components/StarPrompt.tsx');

// ---- provider values are memoized, never inline
check('no inline value={{ in EngineContext.tsx', !/value=\{\{/.test(ctx));
const providers = [...ctx.matchAll(/<(\w+)\.Provider value=\{(\w+)\}/g)];
check('at least 5 narrow providers', providers.length >= 5, String(providers.length));
for (const [, , v] of providers) {
  check(`provider value "${v}" is built with useMemo`, new RegExp(`const ${v}\\s*=\\s*useMemo`).test(ctx));
}

// ---- dead filter state is gone
check('activeFilter removed', !/activeFilter/.test(ctx));
check('setActiveFilter removed', !/setActiveFilter/.test(ctx));
check('filteredTorrents removed', !/filteredTorrents/.test(ctx));

// ---- detail refresh goes through an external store
check('detail store uses useSyncExternalStore', /useSyncExternalStore\(/.test(ctx));
check('no setDetailVersion state in the provider', !/setDetailVersion/.test(ctx));
check('useDetailVersion hook exported', /export function useDetailVersion/.test(ctx));

// ---- narrow hooks and the composed one
for (const h of ['useMaglevEngine', 'useEngineActions', 'useEngineStatus', 'useEngineTelemetry', 'useEngineNotice', 'useEngineLastCompleted']) {
  check(`${h} exported`, new RegExp(`export function ${h}\\b`).test(ctx));
}

// ---- actions context holds only stable functions: no state in its useMemo deps
const am = /const actions\s*=\s*useMemo(?:<[^>]*>)?\(\s*\(\)\s*=>\s*\(\{[\s\S]*?\}\),\s*\[([\s\S]*?)\]\s*\)/.exec(ctx);
check('actions value is a useMemo', !!am);
if (am) {
  const deps = am[1].split(',').map((s) => s.trim()).filter(Boolean);
  const stateNames = /^(telemetry|downloads|notice|engineStatus|defaultStoragePath|storageStatus|lastCompleted|networkOnline|onMeteredNetwork|clipboardMagnet|listsLive)$/;
  check('actions deps are only functions (no state values)', deps.every((d) => !stateNames.test(d)), deps.join(','));
}

// ---- root layout and hosts use the narrowest hook
check('_layout.tsx does not call useMaglevEngine', !/useMaglevEngine/.test(layout));
check('_layout.tsx reads useEngineStatus', /useEngineStatus\(\)/.test(layout));
check('Stack screenOptions is not inline', !/screenOptions=\{\{/.test(layout));
check('NoticeHost uses useEngineNotice', /useEngineNotice\(\)/.test(noticeHost) && !/useMaglevEngine/.test(noticeHost));
check('StarPrompt uses useEngineLastCompleted', /useEngineLastCompleted\(\)/.test(starPrompt) && !/useMaglevEngine/.test(starPrompt));

// ---- fonts embedded at build time
const app = JSON.parse(read('app.json')).expo;
const entry = (app.plugins || []).find((p) => Array.isArray(p) && p[0] === 'expo-font');
check('app.json registers the expo-font plugin with options', !!entry && typeof entry[1] === 'object');
const fonts = (entry && entry[1].android && entry[1].android.fonts) || [];
const names = (() => {
  const src = read('constants/fontStyles.ts');
  const m = /FONT_NAMES\s*=\s*\{([\s\S]*?)\}\s*as const/.exec(src);
  return Object.fromEntries([...m[1].matchAll(/(\w+):\s*'([^']+)'/g)].map((x) => [x[1], x[2]]));
})();
check('FONT_NAMES parsed', Object.keys(names).length === 7, String(Object.keys(names).length));
for (const [key, family] of Object.entries(names)) {
  const f = fonts.find((x) => x && x.fontFamily === family);
  check(`font family ${family} (${key}) is embedded`, !!f);
  const p = f && (f.path || (f.fontDefinitions[0] && f.fontDefinitions[0].path));
  check(`${family}: font file exists`, !!p && fs.existsSync(path.join(root, p)), String(p));
  check(`${family}: full file from @expo-google-fonts, not a subset`, !!p && /@expo-google-fonts\//.test(p));
}
check('_layout no longer gates first paint on useFonts', !/useFonts/.test(layout));

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nengine-context: all checks passed');
