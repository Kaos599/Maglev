// Source-level checks for the power budget: lock policy while seeding, background poll rate,
// cheap key renaming, and the commons-codec resource exclude. Kotlin is compiled by CI only.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const kt = (...p) => fs.readFileSync(path.join(root, 'modules/maglev-engine/android/src/main/java/com/maglev/engine', ...p), 'utf8');
const service = kt('service', 'MaglevTorrentService.kt');
const host = kt('EngineHost.kt');
const mod = kt('MaglevEngineModule.kt');
const json = kt('util', 'Json.kt');

// 1. Locks: not held for plain seeding.
assert(!/updateLocks\(\s*s\.busy\s*>\s*0\s*\)/.test(service), 'locks must not follow busy (it includes seeding)');
assert(/UPLOAD_LOCK_BPS\s*=\s*32L\s*\*\s*1024/.test(service), 'upload threshold must be 32 KiB/s');
assert(/UPLOAD_LOCK_HOLD_MS\s*=\s*60_000L/.test(service), 'upload hold window must be 60 s');
assert(/fun wantsLocks\(/.test(service), 'wantsLocks policy missing');
assert(/updateLocks\(\s*wantsLocks\(/.test(service), 'onSummary must call updateLocks(wantsLocks(...))');
assert(/SDK_INT\s*<\s*34/.test(service) && /WIFI_MODE_FULL_HIGH_PERF/.test(service), 'Wi-Fi lock only below API 34 (HIGH_PERF is remapped to LOW_LATENCY there)');
assert(!/WIFI_MODE_FULL_LOW_LATENCY/.test(service.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')), 'LOW_LATENCY is inactive in background and hurts throughput');
assert(/releaseLocks\(\)/.test(service.split('override fun onDestroy')[1] || ''), 'locks must still release on destroy');

// 2. Background and idle polling.
assert(/IDLE_POLL_MS\s*=\s*5_?000L/.test(host), 'idle poll interval must be 5 s');
assert(/BACKGROUND_EMIT_MS\s*=\s*5_?000L/.test(host), 'background emit interval must be 5 s');
assert(/fun onBackground\(/.test(host), 'EngineHost.onBackground missing');
assert(/pollWake/.test(host), 'poller must be wakeable from the idle sleep');
assert(/withTimeoutOrNull/.test(host), 'poll sleep must be interruptible');
assert(/fun pollNow\(\)[\s\S]{0,600}pollWake\.trySend/.test(host), 'pollNow must wake the poller');
assert(/OnActivityEntersBackground\s*\{[\s\S]*?EngineHost\.onBackground\(\)/.test(mod), 'module must tell EngineHost about backgrounding');
assert(/OnActivityEntersForeground\s*\{[\s\S]*?EngineHost\.onForeground\(\)/.test(mod), 'module must tell EngineHost about foreground');
assert(/forceEmit/.test(host), 'foreground return must force an immediate emit');

// 3. Key renaming is cached.
assert(/HashMap<String,\s*String>/.test(json), 'camelize needs a key cache');
assert(/camelCache/.test(json), 'camelCache missing');

// 4. Packaging exclude for the Beider-Morse tables only; zstd stays (expo/fetch advertises it).
const size = fs.readFileSync(path.join(root, 'plugins/withSizeReduction.js'), 'utf8');
assert(size.includes('org/apache/commons/codec/language/bm/**'), 'bm exclude missing');
assert(!/zstd/i.test(size.replace(/\/\/.*$/gm, '')), 'must not exclude zstd');
const { applyPackagingExcludes } = require('../plugins/withSizeReduction');
assert.strictEqual(typeof applyPackagingExcludes, 'function');
const sample = 'android {\n    compileSdk 1\n}\n';
const once = applyPackagingExcludes(sample);
assert(once.includes('org/apache/commons/codec/language/bm/**'));
assert.strictEqual(applyPackagingExcludes(once), once, 'not idempotent');
assert.throws(() => applyPackagingExcludes('plugins {}'), /android \{/);

console.log('power budget: all checks passed');
