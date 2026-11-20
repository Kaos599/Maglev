#!/usr/bin/env node
// NATIVE_CONTRACT 41 (Debug log): exportDebugLog across TS types, bridge, mock, Kotlin wiring, Rust logcat init,
// the About row and its Dialog copy, and the settings index. Static checks; Rust and Gradle run in CI.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let failed = 0;
function check(name, cond) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}`);
  }
}

const types = read('modules/maglev-engine/src/MaglevEngine.types.ts');
const bridge = read('modules/maglev-engine/src/MaglevNativeBridge.ts');
const mock = read('modules/maglev-engine/src/MaglevMockEngine.ts');
const mod = read('modules/maglev-engine/android/src/main/java/com/maglev/engine/MaglevEngineModule.kt');
const host = read('modules/maglev-engine/android/src/main/java/com/maglev/engine/EngineHost.kt');
const log = read('modules/maglev-engine/android/src/main/java/com/maglev/engine/DebugLog.kt');
const paths = read('modules/maglev-engine/android/src/main/res/xml/file_paths.xml');
const rustLog = read('native/maglev-core/src/android_log.rs');
const rustJni = read('native/maglev-core/src/jni.rs');
const about = read('app/settings/about.tsx');
const copy = read('constants/aboutCopy.ts');
const index = read('utils/settingsIndex.ts');

console.log('TS API');
check('types: exportDebugLog(): Promise<EngineResult<{ uri: string }>>', /exportDebugLog\(\): Promise<EngineResult<\{ uri: string \}>>;/.test(types));
check('types: shareDebugLog(uri)', /shareDebugLog\(uri: string\): Promise<EngineResult>;/.test(types));
check('bridge routes exportDebugLog and shareDebugLog', /route\('exportDebugLog'\)/.test(bridge) && /route\('shareDebugLog', uri\)/.test(bridge));
check('both are read-class methods', /export const READ_METHODS[^;]*'exportDebugLog'[^;]*'shareDebugLog'/s.test(bridge));
check('mock returns ok with a fake content uri', /async exportDebugLog\(\)[\s\S]{0,120}ok: true, uri: 'content:\/\//.test(mock) && /async shareDebugLog\(/.test(mock));

console.log('Kotlin and Rust');
check('module exposes exportDebugLog off the main thread (io)', /AsyncFunction\("exportDebugLog"\)[\s\S]{0,120}io\(promise\)[\s\S]{0,60}EngineHost\.exportDebugLog\(\)/.test(mod));
check('module exposes shareDebugLog through io', /AsyncFunction\("shareDebugLog"\)[\s\S]{0,140}EngineHost\.shareDebugLog\(uri\)/.test(mod));
check('host only shares uris of its own FileProvider debug_log path', /FileActions\.authority\(c\)/.test(host) && /"debug_log"/.test(host));
check('log file lives in cache/debug and replaces older ones', /File\(c\.cacheDir, DIR\)/.test(log) && /DIR = "debug"/.test(log) && /listFiles\(\)\?\.forEach \{ if \(it\.name != file\.name\) it\.delete\(\) \}/.test(log));
check('file holds version, device, Android, settings and 2,000 logcat lines',
  /info\.versionName/.test(log) && /Build\.MANUFACTURER/.test(log) && /Build\.MODEL/.test(log) && /Build\.VERSION\.SDK_INT/.test(log)
  && /MAX_LOGCAT_LINES = 2000/.test(log) && /"logcat", "-d", "-v", "threadtime", "--pid"/.test(log));
check('size is capped near 2 MB and the text is redacted', /MAX_BYTES = 2 \* 1024 \* 1024/.test(log) && /capBytes\(DebugLogRedactor\.redact\(logcat\(\)\)/.test(log));
check('redactor covers query, Cookie, Authorization and sk- keys', /\\\?\[\^\\s"'<>\]\*/.test(log) && /Cookie/.test(log) && /Authorization/.test(log) && /sk-/.test(log));
check('config secrets are removed by key name', /password\|passwd\|cookie\|api_\?key/.test(log));
check('FileProvider has a cache-path for debug/', /<cache-path name="debug_log" path="debug\/" \/>/.test(paths));
check('Rust logs info and above to logcat tag MaglevCore', /TAG: &str = "MaglevCore"/.test(rustLog) && /<= Level::INFO/.test(rustLog) && /__android_log_write/.test(rustLog));
check('logcat writer is android-only (host tests still build)', /#\[cfg\(target_os = "android"\)\]\s*fn write_logcat/.test(rustLog) && /#\[cfg\(not\(target_os = "android"\)\)\]/.test(rustLog));
check('nativeInit installs it once', /crate::android_log::init\(\)/.test(rustJni));

console.log('About row and Dialog');
check('copy: row title and caption', /title: 'Export debug log'/.test(copy) && /subtitle: 'For bug reports\. Shows a warning before you share\.'/.test(copy));
check('copy: dialog title, body and buttons', /dialogTitle: 'Share debug log\?'/.test(copy)
  && /dialogBody: 'The log can include file names and website addresses\. Send it only to someone you trust\.'/.test(copy)
  && /share: 'Share'/.test(copy) && /cancel: 'Cancel'/.test(copy));
check('copy: failure notice', /failed: "Couldn't make the debug log\."/.test(copy));
check('About has the row, opening the warning first', /aboutExtrasCopy\.debugLog\.title/.test(about) && /setLogWarning\(true\)/.test(about) && /<Dialog/.test(about));
check('Share exports, then opens the share sheet', /exportDebugLog\(\)[\s\S]{0,200}shareDebugLog\(made\.uri\)/.test(about));
check('an error shows the notice', /showNotice\(\{ message: aboutExtrasCopy\.debugLog\.failed \}\)/.test(about));

console.log('Settings index');
const entry = /"about-export-debug-log",\s*"Export debug log",\s*"about",[\s\S]*?\],\s*\)/.exec(index);
check('entry exists with the visible title', !!entry);
check('entry keywords: logs, debug, bug report, diagnostics, support',
  !!entry && ['logs', 'debug', 'bug report', 'diagnostics', 'support'].every((k) => entry[0].includes(`"${k}"`)));

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nall debug log checks passed');
