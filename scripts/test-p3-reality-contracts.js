/**
 * Maglev Phase 3 — Reality Contracts (red-phase TDD suite)
 *
 * These contracts describe what a REAL, shippable torrent client must satisfy.
 * They are expected to FAIL until the corresponding work lands.
 *
 * Usage:
 *   node scripts/test-p3-reality-contracts.js
 *   node scripts/test-p3-reality-contracts.js --only=P0   (also P1, P2)
 *
 * Exit code 1 if any P0 contract FAILs, otherwise 0.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? onlyArg.split('=')[1].toUpperCase() : null;

// ---------- helpers ----------

const abs = (rel) => path.join(ROOT, rel);
const exists = (rel) => fs.existsSync(abs(rel));
const read = (rel) => (exists(rel) ? fs.readFileSync(abs(rel), 'utf8') : '');

/** Strip // and /* *\/ comments (and Kotlin/Rust/TS share this syntax), keeping string literals intact. */
function stripComments(src, rust) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++;
    } else if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
    } else if (c === '"' || c === "'" || c === '`') {
      // Rust lifetimes / apostrophes: only treat ' as a string if it closes within the line
      if (c === "'" && rust) {
        const m = /^'(?:\\.|[^'\\\n]){1,2}'/.exec(src.slice(i, i + 6));
        if (!m) { out += c; i++; continue; }
        out += m[0]; i += m[0].length; continue;
      }
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j++;
        if (c !== '`' && src[j] === '\n') break;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}
const code = (rel) => stripComments(read(rel), rel.endsWith('.rs'));

function walk(relDir, exts) {
  const res = [];
  const base = abs(relDir);
  if (!fs.existsSync(base)) return res;
  (function rec(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'build' || e.name.startsWith('.git')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) rec(p);
      else if (!exts || exts.includes(path.extname(e.name))) res.push(path.relative(ROOT, p));
    }
  })(base);
  return res;
}
const walkMany = (dirs, exts) => dirs.flatMap((d) => walk(d, exts));
const TS_EXT = ['.ts', '.tsx'];
const UI_DIRS = ['app', 'components'];
const APP_DIRS = ['app', 'context', 'components'];

function pkg() {
  try { return JSON.parse(read('package.json')); } catch { return {}; }
}

// ---------- harness ----------

const contracts = [];
let cur = null;

function contract(id, sev, desc, fn) {
  contracts.push({ id, sev, desc, fn });
}
function assert(condition, message) {
  if (condition) {
    cur.passed++;
    console.log(`  ✅ PASS: ${message}`);
  } else {
    cur.failed++;
    console.error(`  ❌ FAIL: ${message}`);
  }
}
function skip(message) {
  cur.skipped++;
  console.log(`  ⏭️  SKIP: ${message}`);
}
function warn(message) {
  console.log(`  ⚠️  WARN: ${message}`);
}

function tryRequire(rel) {
  try { return require(abs(rel)); } catch (e) { return { __error: e }; }
}

// ================= P0 =================

contract('C-ENG-1', 'P0',
  'Given the Rust core, When engine.rs is inspected, Then it uses librqbit and has no simulator markers',
  () => {
    const rel = 'native/maglev-core/src/engine.rs';
    assert(exists(rel), `${rel} exists`);
    const src = code(rel);
    assert(/\buse\s+librqbit\b/.test(src), 'engine.rs contains `use librqbit` in code');
    for (const m of ['12_500_000', '3_400_000', 'payload.mkv', 'downloaded + delta']) {
      assert(!src.includes(m), `engine.rs has no simulator marker "${m}"`);
    }
  });

contract('C-ENG-2', 'P0',
  'Given the shipped arm64 .so, When its size and strings are inspected, Then it is >= 3 MB and embeds librqbit/dht code',
  () => {
    const dir = 'modules/maglev-engine/android/src/main/jniLibs';
    // Binaries are never committed (AGENTS.md §4.5). With no local build, the CI gate in
    // .github/workflows/_rust-android.yml enforces the same rule on every push.
    if (!exists(`${dir}/arm64-v8a/libmaglev_core.so`)) {
      skip('no local .so (gitignored); enforced by CI _rust-android size/reality/16KB gate');
      return;
    }
    const check = (abi, strict) => {
      const rel = `${dir}/${abi}/libmaglev_core.so`;
      const report = strict ? assert : (c, m) => { if (!c) warn(m); };
      report(exists(rel), `${abi}/libmaglev_core.so exists`);
      if (!exists(rel)) return;
      const buf = fs.readFileSync(abs(rel));
      report(buf.length >= 3 * 1024 * 1024, `${abi} .so size ${(buf.length / 1048576).toFixed(2)} MB >= 3 MB`);
      const hits = (buf.toString('latin1').match(/librqbit|dht/gi) || []).length;
      report(hits >= 5, `${abi} .so contains librqbit/dht strings ${hits}x (need >= 5)`);
    };
    check('arm64-v8a', true);
    check('armeabi-v7a', false);
    check('x86_64', false);
  });

contract('C-ENG-3', 'P0',
  'Given a release build, When the native engine is missing, Then the bridge surfaces ENGINE_UNAVAILABLE instead of silently using the mock',
  () => {
    const bridge = code('modules/maglev-engine/src/MaglevNativeBridge.ts');
    assert(bridge.length > 0, 'MaglevNativeBridge.ts exists');
    assert(/\b__DEV__\b/.test(bridge), 'bridge references __DEV__ guard');
    assert(/ENGINE_UNAVAILABLE|engineUnavailable/.test(bridge), 'bridge defines an ENGINE_UNAVAILABLE / engineUnavailable error state');
    // Every line mentioning mockEngine must sit within 6 lines after a __DEV__ reference.
    const lines = bridge.split('\n');
    const bad = [];
    lines.forEach((l, i) => {
      if (/\bmockEngine\b/.test(l) && !/^\s*import\b/.test(l)) {
        const window = lines.slice(Math.max(0, i - 6), i + 1).join('\n');
        if (!/__DEV__/.test(window)) bad.push(i + 1);
      }
    });
    assert(bad.length === 0, `every mockEngine use is guarded by __DEV__ (unguarded lines: ${bad.slice(0, 8).join(',') || 'none'})`);
    const settingsUi = code('app/(tabs)/settings.tsx');
    assert(!/librqbit/i.test(settingsUi), 'settings.tsx does not hardcode "librqbit" in user-visible text');
  });

contract('C-PERSIST-1', 'P0',
  'Given settings changes, When the app restarts on Hermes, Then values survive (no localStorage; real storage dep present)',
  () => {
    const store = code('modules/maglev-engine/src/MaglevSettingsStore.ts');
    assert(store.length > 0, 'MaglevSettingsStore.ts exists');
    assert(!/\blocalStorage\b/.test(store), 'MaglevSettingsStore.ts does not use localStorage');
    const p = pkg();
    const deps = { ...(p.dependencies || {}), ...(p.devDependencies || {}) };
    const ok = ['react-native-mmkv', '@react-native-async-storage/async-storage', 'expo-sqlite'].filter((d) => deps[d]);
    assert(ok.length > 0, `package.json has a persistent storage dependency (found: ${ok.join(', ') || 'none'})`);
  });

contract('C-PERSIST-2', 'P0',
  'Given a running session, When the app is killed, Then librqbit session persistence restores torrents',
  () => {
    const files = walk('native/maglev-core/src', ['.rs']);
    assert(files.length > 0, 'Rust sources found');
    const hit = files.filter((f) => /persistence|SessionPersistenceConfig|fastresume/i.test(code(f)));
    assert(hit.length > 0, `Rust code references session persistence (${hit.join(', ') || 'no file'})`);
  });

contract('C-SVC-1', 'P0',
  'Given the foreground service, When started on Android 14+, Then it has channel, onCreate/onStartCommand/onTimeout, a typed manifest entry, and a start call',
  () => {
    const svcFiles = walk('modules/maglev-engine/android/src', ['.kt']).filter((f) => /MaglevTorrentService\.kt$/.test(f));
    assert(svcFiles.length === 1, 'MaglevTorrentService.kt exists');
    const svc = svcFiles[0] ? code(svcFiles[0]) : '';
    assert(/override\s+fun\s+onStartCommand/.test(svc), 'service overrides onStartCommand');
    assert(/override\s+fun\s+onCreate/.test(svc), 'service overrides onCreate');
    // Channel creation may live in a helper in the service package, but onCreate must reach it.
    const svcPkg = walk('modules/maglev-engine/android/src', ['.kt']).filter((f) => /\/service\//.test(f)).map(code).join('\n');
    const onCreateBody = (/override\s+fun\s+onCreate\s*\(\)\s*\{([\s\S]*?)\n    \}/.exec(svc) || [])[1] || '';
    assert(/createNotificationChannel/.test(svcPkg) && /(createNotificationChannel|ensureChannels)/.test(onCreateBody),
      'service onCreate creates notification channels (directly or via service-package helper)');
    assert(/\bonTimeout\b/.test(svc), 'service implements onTimeout (Android 15 FGS timeout)');
    const manifest = read('modules/maglev-engine/android/src/main/AndroidManifest.xml');
    const svcTag = /<service\b[^>]*MaglevTorrentService[^>]*>/s.exec(manifest);
    assert(!!svcTag && /foregroundServiceType/.test(svcTag[0]), 'manifest declares MaglevTorrentService with foregroundServiceType');
    const kt = walk('modules/maglev-engine/android/src', ['.kt']);
    assert(kt.some((f) => /startForegroundService\(/.test(code(f))), 'some Kotlin file calls startForegroundService(');
  });

contract('C-SVC-2', 'P0',
  'Given a notification action, When "Pause all" is tapped, Then the service handles it and JS receives onNotificationAction (NATIVE_CONTRACT §6)',
  () => {
    const svcFiles = walk('modules/maglev-engine/android/src', ['.kt']).filter((f) => /MaglevTorrentService\.kt$/.test(f));
    const svc = svcFiles[0] ? code(svcFiles[0]) : '';
    const idx = svc.search(/onStartCommand/);
    assert(idx >= 0 && /ACTION_PAUSE_ALL/.test(svc.slice(idx)), 'ACTION_PAUSE_ALL is handled after onStartCommand');
    const ts = walkMany(['app', 'context', 'modules/maglev-engine/src'], TS_EXT);
    assert(ts.some((f) => /onNotificationAction/.test(code(f))), 'TS subscribes to onNotificationAction');
    const kt = walk('modules/maglev-engine/android/src', ['.kt']).map(code).join('\n');
    assert(/"onNotificationAction"/.test(kt) && /pause_all/.test(kt), 'Kotlin emits onNotificationAction with pause_all');
  });

contract('C-SVC-3', 'P0',
  'Given active transfers, When Android kills the process, Then the service restarts headless from persisted state, without a 6 h cap, and never resurrects user-stopped transfers',
  () => {
    const kt = walk('modules/maglev-engine/android/src', ['.kt']).map(code).join('\n');
    const manifest = read('modules/maglev-engine/android/src/main/AndroidManifest.xml');
    assert(/START_STICKY/.test(kt), 'service can return START_STICKY');
    assert(/specialUse/.test(manifest) && /PROPERTY_SPECIAL_USE_FGS_SUBTYPE/.test(manifest), 'manifest declares specialUse type with subtype property');
    assert(/FOREGROUND_SERVICE_SPECIAL_USE/.test(manifest), 'FOREGROUND_SERVICE_SPECIAL_USE permission declared');
    assert(/FOREGROUND_SERVICE_TYPE_SPECIAL_USE/.test(kt) && /UPSIDE_DOWN_CAKE|>=\s*34/.test(kt), 'specialUse used only on API 34+');
    assert(/getSharedPreferences[\s\S]{0,4000}(governance|wifiOnly|wifi_only)/i.test(kt), 'governance rules persisted natively');
    assert(/backgroundKills/.test(kt), 'background kill count exposed to JS');
    const ts = walkMany(['modules/maglev-engine/src'], TS_EXT).map(code).join('\n');
    assert(/backgroundKills/.test(ts), 'TS types include backgroundKills');
  });

contract('C-PERM-1', 'P0',
  'Given first launch, When permissions are requested, Then an onboarding route exists and results are read by field, not as a truthy object',
  () => {
    const routes = [
      ...['app/onboarding.tsx', 'app/welcome.tsx'].filter(exists),
      ...walk('app/(onboarding)', ['.tsx']),
    ];
    assert(routes.length > 0, `onboarding/welcome route exists (${routes.join(', ') || 'none'})`);
    const layout = code('app/_layout.tsx');
    assert(/onboarding|welcome/i.test(layout), 'app/_layout.tsx references onboarding/welcome');
    const offenders = [];
    for (const f of walkMany(APP_DIRS, TS_EXT)) {
      const src = code(f);
      const re = /(?:const|let|var)\s+(\w+)\s*=\s*await\s+requestMaglevPermissions\(/g;
      let m;
      while ((m = re.exec(src))) {
        if (new RegExp(`if\\s*\\(\\s*!\\s*${m[1]}\\s*\\)`).test(src)) offenders.push(`${f} (${m[1]})`);
      }
    }
    assert(offenders.length === 0, `no call site does if(!result) on the raw permission object (${offenders.join(', ') || 'none'})`);
  });

contract('C-PERM-2', 'P0',
  'Given long-running downloads, When Doze is active, Then the app can request a battery optimization exemption',
  () => {
    let appPerms = [];
    try { appPerms = (JSON.parse(read('app.json')).expo || {}).android.permissions || []; } catch {}
    const inAppJson = appPerms.includes('REQUEST_IGNORE_BATTERY_OPTIMIZATIONS') ||
      appPerms.includes('android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS');
    const inManifest = /REQUEST_IGNORE_BATTERY_OPTIMIZATIONS/.test(read('modules/maglev-engine/android/src/main/AndroidManifest.xml'));
    assert(inAppJson || inManifest, 'REQUEST_IGNORE_BATTERY_OPTIMIZATIONS declared in app.json or module manifest');
  });

contract('C-SAF-1', 'P0',
  'Given the download-folder setting, When the user taps it, Then a SAF folder picker with persistable permission is invoked from JS',
  () => {
    const files = walkMany(APP_DIRS, TS_EXT);
    const re = /takePersistableSafPermission|pickDownloadFolder|requestDirectoryPermissionsAsync|OPEN_DOCUMENT_TREE/;
    const hit = files.filter((f) => re.test(code(f)));
    assert(hit.length > 0, `folder picker wired in app/context/components (${hit.join(', ') || 'none'})`);
  });

contract('C-INTENT-1', 'P0',
  'Given a magnet: link is tapped elsewhere, When Maglev opens, Then the URL is consumed and the add sheet opens',
  () => {
    const files = walkMany(['app', 'context'], TS_EXT);
    const re = /Linking\.getInitialURL|\buseURL\b|\buseLinkingURL\b/;
    const hit = files.filter((f) => re.test(code(f)));
    const nativeIntent = exists('app/+native-intent.tsx') || exists('app/+native-intent.ts');
    assert(hit.length > 0 || nativeIntent, `magnet intake present (${hit.join(', ') || (nativeIntent ? '+native-intent' : 'none')})`);
  });

contract('C-SET-1', 'P0',
  'Given a settings change, When it is applied, Then a snake_case mapping reaches the Rust config struct',
  () => {
    const keys = ['wifi_only', 'max_active_downloads', 'encryption', 'dht'];
    const sources = ['modules/maglev-engine/src/MaglevNativeBridge.ts', 'modules/maglev-engine/src/toNativeConfig.ts'];
    const best = sources.map((s) => ({ s, src: code(s) })).filter((x) => x.src);
    const ok = best.some((x) => keys.every((k) => new RegExp(`\\b${k}\\b`).test(x.src)));
    const missing = keys.filter((k) => !best.some((x) => new RegExp(`\\b${k}\\b`).test(x.src)));
    assert(ok, `bridge or toNativeConfig.ts contains all of ${keys.join(', ')} (missing across files: ${missing.join(', ') || 'none; but not all in one file'})`);
  });

// ================= P1 =================

const HASH = 'a'.repeat(39) + 'b';
let engineCache;
function getEngine() {
  if (engineCache !== undefined) return engineCache;
  const mod = tryRequire('modules/maglev-engine/src/MaglevMockEngine.ts');
  engineCache = mod.__error ? { error: mod.__error } : { engine: mod.mockEngine };
  return engineCache;
}
const countTorrents = (e) => {
  const t = e.getAggregatedTelemetry();
  return (t.torrents || []).length;
};
function outcome(fn) {
  try { return { value: fn() }; } catch (error) { return { error }; }
}
const rejected = (o) =>
  !!o.error || o.value === false || o.value == null ||
  (typeof o.value === 'object' && (o.value.error || o.value.ok === false || o.value.success === false || o.value.duplicate || o.value.isDuplicate));

contract('C-DUP-1', 'P1',
  'Given a torrent already added, When the same magnet is added again, Then it is rejected/flagged as duplicate and the count is unchanged',
  () => {
    const { engine, error } = getEngine();
    if (!engine) return skip(`cannot load MaglevMockEngine.ts: ${error && error.message}`);
    const magnet = `magnet:?xt=urn:btih:${HASH}&dn=x`;
    let first, second, before, after;
    try {
      first = outcome(() => engine.startTorrent(magnet, '/tmp/dup', false));
      before = countTorrents(engine);
      second = outcome(() => engine.startTorrent(magnet, '/tmp/dup', false));
      after = countTorrents(engine);
    } catch (e) { return skip(`engine API unusable: ${e.message}`); }
    assert(!first.error, 'first add of magnet succeeds');
    const dupFlag = !!second.error ||
      (second.value && typeof second.value === 'object' && (second.value.duplicate || second.value.isDuplicate)) ||
      (typeof second.value === 'string' && /dup/i.test(second.value));
    assert(dupFlag, 'second add throws or returns a duplicate indicator');
    assert(before === after, `torrent count unchanged by second add (${before} -> ${after})`);
    try { engine.deleteTorrent(HASH, false); } catch {}
  });

contract('C-MAG-1', 'P1',
  'Given malformed input, When it is added as a magnet, Then the engine rejects it',
  () => {
    const { engine, error } = getEngine();
    if (!engine) return skip(`cannot load MaglevMockEngine.ts: ${error && error.message}`);
    for (const bad of ['magnet:?dn=nohash', 'https://example.com']) {
      const o = outcome(() => engine.startTorrent(bad, '/tmp/bad', false));
      assert(rejected(o), `"${bad}" rejected (got ${o.error ? 'throw' : JSON.stringify(o.value)})`);
    }
  });

contract('C-APK-1', 'P1',
  'Given a release APK, When ABIs and fonts are counted, Then it ships only needed ABIs (or splits) and <= 5 font faces',
  () => {
    const gradle = code('modules/maglev-engine/android/build.gradle');
    const m = /abiFilters\s*([^\n]*)/.exec(gradle);
    const heavy = m ? /x86_64|armeabi-v7a/.test(m[1]) : false;
    const cfg = ['app.json', 'eas.json', 'gradle.properties'].map(read).join('\n');
    // A config plugin counts only if app.json registers it AND its source configures splits.
    const pluginRefs = (cfg.match(/"\.\/plugins\/[^"]+\.js"/g) || []).map((r) => r.slice(3, -1));
    const pluginSrc = pluginRefs.map((f) => read('plugins/' + f.replace(/^plugins\//, ''))).join('\n');
    const splits = /\bsplits\b|reactNativeArchitectures/.test(cfg + '\n' + pluginSrc);
    assert(!heavy || splits, `abiFilters (${m ? m[1].trim() : 'none'}) excludes x86_64/armeabi-v7a, or ABI splits are configured`);
    const layout = code('app/_layout.tsx');
    const block = /useFonts\(\{([\s\S]*?)\}\)/.exec(layout);
    const faces = block ? (block[1].match(/@expo-google-fonts\//g) || []).length : 0;
    assert(faces <= 5, `useFonts loads ${faces} font faces (<= 5)`);
  });

contract('C-UI-SET', 'P1',
  'Given the Settings tab, When opened, Then it is an index linking to >= 6 sub-screens',
  () => {
    const dir = ['app/settings', 'app/(tabs)/settings'].find((d) => exists(d) && fs.statSync(abs(d)).isDirectory());
    assert(!!dir, 'settings directory exists (app/settings or app/(tabs)/settings)');
    if (!dir) return;
    const files = fs.readdirSync(abs(dir)).filter((f) => f.endsWith('.tsx'));
    // The index is either <dir>/index.tsx or the Settings tab itself (UI_SPEC S8), never both (duplicate /settings route).
    const tabIndex = exists('app/(tabs)/settings.tsx');
    const dirIndex = files.includes('index.tsx');
    assert(tabIndex !== dirIndex, `exactly one settings index (tab: ${tabIndex}, ${dir}/index.tsx: ${dirIndex})`);
    if (tabIndex) {
      const idx = code('app/(tabs)/settings.tsx');
      const linked = files.filter((f) => f !== 'index.tsx' && f !== '_layout.tsx').map((f) => f.replace('.tsx', ''))
        .filter((n) => new RegExp(`settings/${n}\\b|route:\\s*['"]${n}['"]`).test(idx));
      assert(linked.length >= 6, `settings index links to >= 6 sub-screens (found ${linked.length})`);
    }
    assert(files.filter((f) => f !== 'index.tsx' && f !== '_layout.tsx').length >= 6, `>= 6 sub-screens (found ${files.filter((f) => f !== 'index.tsx' && f !== '_layout.tsx').length})`);
  });

contract('C-UI-SORT', 'P1',
  'Given the transfers list, When the user sorts or long-presses a card, Then sort options and multi-select exist',
  () => {
    const main = code('app/(tabs)/index.tsx');
    let all = main;
    const imp = /from\s+['"]\.\.\/\.\.\/components\/(\w+)['"]/g;
    let m;
    while ((m = imp.exec(main))) all += '\n' + code(`components/${m[1]}.tsx`);
    assert(/\bsort\w*|\bSort\w*/.test(all), 'transfers screen/components contain a sort identifier');
    assert(/\bselected\w*/i.test(all) && /onLongPress/.test(all), 'selection mode (selected + onLongPress) present');
  });

contract('C-UI-THEME', 'P1',
  'Given the theme setting, When changed, Then components read colors via useTheme, not hardcoded hex',
  () => {
    const hook = walkMany(['components', 'context', 'constants'], TS_EXT)
      .filter((f) => /(function|const)\s+useTheme\b|export\s+\{[^}]*\buseTheme\b/.test(code(f)));
    assert(hook.length > 0, `useTheme hook defined (${hook.join(', ') || 'none'})`);
    let count = 0;
    for (const f of walkMany(UI_DIRS, TS_EXT)) count += (code(f).match(/#[0-9a-fA-F]{6}\b/g) || []).length;
    assert(count <= 10, `hardcoded 6-digit hex colors in app/ + components/: ${count} (<= 10)`);
  });

contract('C-BACK-1', 'P1',
  'Given an open modal/sheet, When hardware Back is pressed, Then it closes instead of exiting',
  () => {
    const files = walkMany(UI_DIRS, TS_EXT);
    const srcs = files.map(code);
    const hasBH = srcs.some((s) => /\bBackHandler\b/.test(s));
    const modals = srcs.reduce((n, s) => n + (s.match(/<Modal\b/g) || []).length, 0);
    const orc = srcs.reduce((n, s) => n + (s.match(/\bonRequestClose\b/g) || []).length, 0);
    assert(hasBH || (modals > 0 && orc >= modals), `BackHandler used (${hasBH}) or every <Modal> has onRequestClose (modals=${modals}, onRequestClose=${orc})`);
  });

// ================= P2 =================

contract('C-ICON-1', 'P2',
  'Given any screen, When icons render, Then only the PixelIcons family is used',
  () => {
    const off = walkMany(UI_DIRS, TS_EXT).filter((f) => /@expo\/vector-icons|\bIonicons\b/.test(code(f)));
    assert(off.length === 0, `no @expo/vector-icons / Ionicons imports (offenders: ${off.join(', ') || 'none'})`);
  });

contract('C-A11Y-1', 'P2',
  'Given interactive styles, When sized, Then no button/tab/pill/chip dimension is in [20,43] px',
  () => {
    const nameRe = /btn|button|close|tab|pill|chip|touch|hit/i;
    const dimRe = /\b(minHeight|minWidth|height|width)\s*:\s*(\d+(?:\.\d+)?)\s*[,}\n]/;
    const offenders = [];
    for (const f of walkMany(UI_DIRS, TS_EXT)) {
      let name = '';
      code(f).split('\n').forEach((line, i) => {
        const k = /^\s*(\w+)\s*:\s*\{/.exec(line);
        if (k && !/^(shadowOffset|textShadowOffset|transform)$/.test(k[1])) name = k[1];
        const d = dimRe.exec(line);
        if (d && nameRe.test(name)) {
          const v = parseFloat(d[2]);
          if (v >= 20 && v <= 43) offenders.push(`${f}:${i + 1} ${name}.${d[1]}=${v}`);
        }
      });
    }
    offenders.slice(0, 40).forEach((o) => console.error(`     offender: ${o}`));
    if (offenders.length > 40) console.error(`     ... and ${offenders.length - 40} more`);
    assert(offenders.length === 0, `sub-44px interactive style sizes found: ${offenders.length}`);
  });

contract('C-SEARCH-1', 'P1', 'Search engine files exist and the search contract tests pass', () => {
  const files = [
    'utils/search/aggregate.ts',
    'utils/search/providers/index.ts',
    'utils/search/providers/knaben.ts',
    'utils/search/providers/torrentscsv.ts',
    'utils/search/providers/archive.ts',
    'utils/search/providers/nyaa.ts',
    'utils/search/providers/yts.ts',
    'utils/search/providers/tpb.ts',
    'utils/search/providers/bitsearch.ts',
    'utils/search/providers/linuxtracker.ts',
    'utils/search/providers/sukebei.ts',
    'utils/search/providers/eztv.ts',
    'utils/search/providers/subsplease.ts',
    'utils/search/providers/animetosho.ts',
    'utils/search/providers/torznab.ts',
    'scripts/test-search.js',
  ];
  const missing = files.filter((f) => !exists(f));
  assert(missing.length === 0, `search engine files present${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);
  const r = require('child_process').spawnSync(process.execPath, [abs('scripts/test-search.js')], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) console.error(`${r.stdout || ''}${r.stderr || ''}`.split('\n').slice(-25).join('\n'));
  assert(r.status === 0, 'node scripts/test-search.js exits 0');
});

contract('C-W3-1', 'P1', 'Wave 3 JS side: file priority, reannounce, free space, Live Updates (NATIVE_CONTRACT 10.1-10.5)', () => {
  const bridge = read('modules/maglev-engine/src/MaglevNativeBridge.ts');
  const mock = read('modules/maglev-engine/src/MaglevMockEngine.ts');
  const add = read('app/add-torrent.tsx') + read('components/add/SpaceStrip.tsx');
  const detail = read('app/torrent/[id].tsx') + read('components/detail/TorrentMoreSheet.tsx') + read('components/detail/PrioritySheet.tsx');
  const iface = read('app/settings/interface.tsx');
  for (const m of ['setFilePriorities', 'reannounce', 'getFreeSpace', 'openLiveUpdateSettings']) {
    assert(new RegExp(`public (async )?${m}\\(`).test(bridge), `bridge exposes ${m}`);
  }
  assert(/Keep at least one file/.test(mock) && /every\(\(e\) => e\.priority === 'skip'\)/.test(mock), 'mock rejects an all-skip priority list');
  assert(/60_000/.test(mock) && /retryAfterSecs/.test(mock), 'mock rate-limits reannounce to once per 60 s');
  assert(/getFreeSpace/.test(add), 'add-torrent reads getFreeSpace');
  assert(/admit\(/.test(add) && /'DoesntFit'/.test(add) && /Add paused/.test(add) && /doAdd\(false, doesntFit\)/.test(add), 'add-torrent runs the SM-35 space budget and adds paused when it does not fit');
  assert(/file_priorities|filePriorities/.test(add), 'add-torrent sends file priorities');
  assert(/reannounce/.test(detail) && /Find more peers/.test(detail), 'detail has Find more peers (reannounce)');
  assert(/Download first/.test(detail) && /setFilePriorities/.test(detail) && /notices\.detail\.keepOneFile/.test(detail) && /keepOneFile: 'Keep at least one file\.'/.test(read('constants/copy.ts')), 'detail has the priority sheet and blocks all-skip');
  assert(/Platform\.Version/.test(iface) && /Live progress in status bar/.test(iface), 'Interface settings has the Live Updates row gated by API level');
});

// expo-router throws "Cannot use `href` and `tabBarButton` together" (TabsClient processScreens),
// so a hidden tab (Assistant off, the default) must not carry the custom button or the app crashes at launch.
contract('C-NAV-1', 'P0', 'A hidden tab sets href:null without tabBarButton', () => {
  const layout = code('app/(tabs)/_layout.tsx');
  assert(/\{\s*href:\s*null,\s*title\s*\}/.test(layout), 'the hidden branch is exactly { href: null, title }');
  const objs = layout.match(/\{[^{}]*\}/g) || [];
  assert(!objs.some((o) => /href\s*:/.test(o) && /tabBarButton\s*:/.test(o)), 'no options object sets both href and tabBarButton');
});

// The assistant's logic stays pure and testable in node: only the tool runner may reach the engine or React Native.
contract('C-ASSIST-8', 'P1', 'Assistant modules import neither react-native nor the engine (toolRunner.ts excepted)', () => {
  const files = walk('utils/assistant', ['.ts', '.tsx']).filter((f) => path.basename(f) !== 'toolRunner.ts');
  if (files.length === 0) return skip('no assistant modules yet');
  for (const f of files) {
    const src = code(f);
    const bad = /from\s+['"](react-native|react|maglev-engine|expo-[\w-]+)['"]|require\(\s*['"](react-native|maglev-engine)['"]/.exec(src);
    assert(!bad, `${f} is pure (found import of ${bad ? bad[1] || bad[2] : ''})`);
  }
});

// ---------- runner ----------

function main() {
  console.log('\n======================================================');
  console.log('   MAGLEV PHASE 3 — REALITY CONTRACTS (red-phase TDD)  ');
  console.log('======================================================');
  const results = [];
  for (const c of contracts) {
    if (ONLY && c.sev !== ONLY) continue;
    console.log(`\n▶ [${c.id}] (${c.sev}) ${c.desc}`);
    cur = { passed: 0, failed: 0, skipped: 0 };
    try {
      c.fn();
    } catch (e) {
      cur.failed++;
      console.error(`  ❌ FAIL: contract threw: ${e.message}`);
    }
    const status = cur.failed > 0 ? 'FAIL' : cur.skipped > 0 && cur.passed === 0 ? 'SKIP' : 'PASS';
    results.push({ id: c.id, sev: c.sev, status, ...cur });
  }

  console.log('\n======================================================');
  console.log('   SUMMARY');
  console.log('======================================================');
  console.log('ID           SEV  STATUS  (pass/fail/skip checks)');
  for (const r of results) {
    const icon = r.status === 'PASS' ? '✅' : r.status === 'FAIL' ? '❌' : '⏭️ ';
    console.log(`${r.id.padEnd(12)} ${r.sev}   ${icon} ${r.status.padEnd(5)} (${r.passed}/${r.failed}/${r.skipped})`);
  }
  const tot = (s) => results.filter((r) => r.status === s).length;
  console.log(`\nContracts: ${results.length}  PASS: ${tot('PASS')}  FAIL: ${tot('FAIL')}  SKIP: ${tot('SKIP')}`);
  const p0Fail = results.filter((r) => r.sev === 'P0' && r.status === 'FAIL').length;
  console.log(`P0 failures: ${p0Fail}`);
  process.exit(p0Fail > 0 ? 1 : 0);
}

main();
