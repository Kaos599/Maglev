#!/usr/bin/env node
/** 0.14 add-flow contract: one global notice host, mobile-data note and folder row in browser sheets,
 *  add-download keeps the pasted link when the quality sheet is dismissed, one-tap add note, titles. */
process.removeAllListeners('warning');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let failed = 0;
const check = (ok, msg) => {
  if (ok) console.log(`ok   ${msg}`);
  else { failed++; console.log(`FAIL ${msg}`); }
};

const layout = read('app/_layout.tsx');
const host = fs.existsSync(path.join(root, 'components/ui/NoticeHost.tsx')) ? read('components/ui/NoticeHost.tsx') : '';
check(/NoticeHost/.test(layout) && /<NoticeHost/.test(layout), '_layout renders <NoticeHost />');
check(/useMaglevEngine/.test(host) && /<Banner/.test(host) && /dismissNotice/.test(host) && /actionLabel/.test(host) && /onAction/.test(host),
  'NoticeHost reads the engine notice and renders a Banner with action and dismiss');
check(/useSafeAreaInsets/.test(host), 'NoticeHost is safe-area aware');

const saveTo = read('components/browser/SaveToRow.tsx');
check(/pickDownloadFolder/.test(saveTo) && /Save to/.test(saveTo) && /Change/.test(saveTo), 'SaveToRow picks a folder with Save to / Change');
for (const f of ['components/browser/FoundDownload.tsx', 'components/browser/StreamSheet.tsx']) {
  const s = read(f);
  check(/mobileDataLine/.test(s) && /onMeteredNetwork/.test(s) && /wifiOnly/.test(s), `${f} shows the mobile-data note`);
  check(/<SaveToRow/.test(s), `${f} has a Save to / Change folder row`);
}

const add = read('app/add-download.tsx');
const sheet = add.match(/<StreamSheet[\s\S]*?\/>\s*\n/);
check(!!sheet && !/onClose=\{[^}]*close\(\)/.test(sheet[0]), 'add-download: dismissing the quality sheet does not call close()');
check(!!sheet && /onStarted=/.test(sheet[0]), 'add-download: a started stream still leaves the screen');
check(!/title="Add download"/.test(add) && /title="Add a link"/.test(add), 'add-download title is "Add a link"');
check(/title="Add a link or torrent"/.test(read('app/add-torrent.tsx')), 'add-torrent entry title is "Add a link or torrent"');


(async () => {
  const { oneTapAddNote } = await import('../utils/addChecks.ts');
  check(oneTapAddNote({ sizeBytes: 5e9, onMetered: false, wifiOnly: false }) === null, 'oneTapAddNote: on Wi-Fi gives no note');
  check(oneTapAddNote({ sizeBytes: 5e9, onMetered: true, wifiOnly: true }) === 'This waits for Wi-Fi.', 'oneTapAddNote: metered + Wi-Fi only waits');
  check(/mobile data/.test(oneTapAddNote({ sizeBytes: 1.5e9, onMetered: true, wifiOnly: false }) || ''), 'oneTapAddNote: metered shows size line');
  check(oneTapAddNote({ sizeBytes: null, onMetered: true, wifiOnly: false }) === null, 'oneTapAddNote: unknown size gives no note');
  check(read('utils/addChecks.ts').includes('mobileDataLine'), 'oneTapAddNote reuses mobileDataLine');
  if (failed) { console.log(`${failed} failed`); process.exit(1); }
  console.log('all ok');
})();
