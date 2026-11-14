#!/usr/bin/env node
// Self-hosted F-Droid repo (GitHub Pages, /fdroid/repo): built in pages.yml from release APKs.
// Checks the wiring and the safety properties: secret-gated, split APKs only, keystore and config never published.
process.removeAllListeners('warning');

const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}

const exists = (p) => fs.existsSync(path.join(root, p));

console.log('[pages.yml]');
const wf = exists('.github/workflows/pages.yml') ? read('.github/workflows/pages.yml') : '';
check('runs when the release workflow finishes (GITHUB_TOKEN releases do not fire release events)',
  /workflow_run:\s*\n\s*workflows:\s*\[\s*["']Build and Release Android APK["']\s*\]/.test(wf) && /types:\s*\[\s*completed\s*\]/.test(wf));
check('runs on a daily schedule as a fallback', /schedule:\s*\n\s*-\s*cron:/.test(wf));
check('can be run by hand', /workflow_dispatch:/.test(wf));
check('F-Droid step is skipped when the keystore secret is missing', /if:\s*env\.FDROID_KEYSTORE_B64\s*!=\s*''/.test(wf));
check('reads the three secrets', ['FDROID_KEYSTORE_B64', 'FDROID_KEYSTORE_PASS', 'FDROID_KEY_ALIAS'].every((s) => wf.includes(`secrets.${s}`)));
check('F-Droid repo is built before the site is uploaded',
  wf.indexOf('build-fdroid-repo.sh') > -1 && wf.indexOf('build-fdroid-repo.sh') < wf.indexOf('upload-pages-artifact'));

console.log('[scripts/build-fdroid-repo.sh]');
const sh = exists('scripts/build-fdroid-repo.sh') ? read('scripts/build-fdroid-repo.sh') : '';
check('script exists and fails fast', /set -euo pipefail/.test(sh));
check('pins fdroidserver', /fdroidserver==\d+\.\d+\.\d+/.test(sh));
check('downloads only the split APKs (no universal, no .apks set)',
  /-arm64-v8a\.apk/.test(sh) && /-armeabi-v7a\.apk/.test(sh) && /-x86_64\.apk/.test(sh) && !/universal\.apk/.test(sh) && !/'\*\.apks'/.test(sh));
check('keeps a bounded number of releases', /KEEP_RELEASES=\$\{KEEP_RELEASES:-\d+\}/.test(sh));
check('listing comes from fastlane/metadata', /fastlane\/metadata\/android\/en-US/.test(sh));
check('repo icon goes to repo/icons/icon.png', /repo\/icons\/icon\.png/.test(sh));
check('publishes only repo/ (never config.yml or the keystore)',
  /cp -R[^\n]*repo\/\.?["']?\s+["']?\$OUT/.test(sh) && !/cp[^\n]*config\.yml[^\n]*\$OUT/.test(sh) && !/cp[^\n]*keystore[^\n]*\$OUT/.test(sh));
check('works outside the published folder', /WORK=.*mktemp -d/.test(sh));
check('output path is made absolute before the script changes folder', (() => { const i = sh.search(/OUT="\$\(cd "\$OUT" && pwd\)"/); const j = sh.indexOf('cd "$WORK"'); return i > -1 && j > -1 && i < j; })());

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
