#!/usr/bin/env node
// 0.18 crash safety: local crash log, redaction, report, global handler chain, route ErrorBoundary exports.
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
let failed = 0;
const check = (name, ok) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) failed++;
};

(async () => {
  const log = await import('../utils/crashLog.ts');
  log.setEnvProvider(() => ({ appVersion: '0.18', androidVersion: 'android 35', deviceModel: 'Pixel 9' }));
  log.clearCrashLog();

  // ring buffer
  for (let i = 0; i < 25; i++) log.recordCrash(new Error(`boom ${i}`), { route: '/x' });
  const all = log.getCrashLog();
  check('keeps only the last 20', all.length === 20 && all[0].message === 'boom 5' && all[19].message === 'boom 24');
  const big = new Error('big');
  big.stack = 'x'.repeat(10000);
  log.recordCrash(big);
  check('stack truncated to 4 KB', log.getCrashLog().at(-1).stack.length === 4096);
  const e = log.recordCrash(new TypeError('bad'), { isFatal: true, route: '/torrent/1', source: 'boundary' });
  check('entry has time, version, route, name, message, isFatal',
    !!Date.parse(e.time) && e.appVersion === '0.18' && e.route === '/torrent/1' && e.name === 'TypeError' && e.message === 'bad' && e.isFatal === true);
  log.clearCrashLog();
  check('clear empties the log', log.getCrashLog().length === 0);
  check('recording a non-Error never throws', log.recordCrash('plain string') !== null && log.recordCrash(undefined) !== null);
  log.clearCrashLog();

  // redaction
  const r = log.redact('open /storage/emulated/0/Download/a.mkv and content://com.x/doc/1 and magnet:?xt=urn:btih:abc&dn=n and https://a.com/p?q=1 key sk-abcdef1234567890XYZ');
  check('paths replaced', !/storage\/emulated|content:\/\//.test(r) && r.includes('<path>'));
  check('magnet and urls replaced', !/magnet:|https:\/\/a\.com/.test(r) && r.includes('<link>'));
  check('sk- keys replaced', !/sk-abcdef/.test(r) && r.includes('<key>'));
  const withSecret = new Error('failed https://x.test/t?k=1');
  withSecret.stack = 'at f (/storage/emulated/0/x.js:1:2)';
  log.recordCrash(withSecret);
  check('redacted before it is stored', !/x\.test|\/storage/.test(JSON.stringify(log.getCrashLog())));

  // report
  const report = log.formatReport(log.getCrashLog());
  check('report has app, Android, device', /App version: 0\.18/.test(report) && /Android: android 35/.test(report) && /Device: Pixel 9/.test(report));
  check('report lists the entries', /#1 /.test(report) && /Error: failed <link>/.test(report));
  check('report has no raw paths or links', !/\/storage|https?:\/\//.test(report));
  log.clearCrashLog();

  // global handler
  let installed = null;
  const calls = [];
  const prev = (err, fatal) => calls.push([err.message, fatal]);
  const fake = { getGlobalHandler: () => prev, setGlobalHandler: (fn) => { installed = fn; } };
  check('install succeeds on ErrorUtils', log.installGlobalHandler(fake) === true && typeof installed === 'function');
  installed(new Error('fatal one'), true);
  check('handler records the crash', log.getCrashLog().length === 1 && log.getCrashLog()[0].isFatal === true);
  check('handler chains to the previous one with the same args', calls.length === 1 && calls[0][0] === 'fatal one' && calls[0][1] === true);
  check('install without ErrorUtils is a no-op', log.installGlobalHandler({}) === false);
  log.clearCrashLog();

  // source checks
  for (const f of ['_layout', 'assistant', 'browse', 'feeds', 'index', 'search', 'settings']) {
    check(`tabs/${f} exports ErrorBoundary`, /export \{ ErrorBoundary \} from '\.\.\/\.\.\/components\/ErrorScreen'/.test(read(`app/(tabs)/${f}.tsx`)));
  }
  const rootLayout = read('app/_layout.tsx');
  check('root layout exports ErrorBoundary and installs the handler', /export \{ ErrorBoundary \}/.test(rootLayout) && /installGlobalHandler\(\)/.test(rootLayout));
  const es = read('components/ErrorScreen.tsx');
  check('error screen has Reload (retry) and Copy crash report', /retry\(\)/.test(es) && /errorScreenCopy\.copy/.test(es) && /recordCrash\(error/.test(es));
  check('error screen does not need the theme provider', !/useTheme/.test(es));
  const about = read('app/settings/about.tsx');
  check('About shows copy and clear only when the log has entries', /crashCount > 0/.test(about) && /clearCrashLog/.test(about) && /copyCrashReport/.test(about));
  const copy = read('constants/copy.ts');
  check('copy: title and reload text', /Something went wrong/.test(copy) && /reload: 'Reload'/.test(copy));
  check('nothing is sent anywhere', !/fetch\(|XMLHttpRequest/.test(read('utils/crashLog.ts')));

  console.log(failed ? `\n${failed} failed` : '\ncrash safety: all passed');
  process.exit(failed ? 1 : 0);
})();
