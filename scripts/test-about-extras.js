#!/usr/bin/env node
// About extras: Website link, open-source licence page with a generated "Built with" list, and What's new
// for the installed version (bundled notes, no network).
// Needs Node 22.18+ (runs the TypeScript source directly via type stripping).
process.removeAllListeners('warning');
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
const exists = (p) => fs.existsSync(path.join(root, p));

(async () => {
  const app = JSON.parse(read('app.json')).expo;
  check('app.json extra.homepage is the Maglev page', app.extra && app.extra.homepage === 'https://harshdayal.dev/maglev');
  check('no privacyUrl while that page is broken', !(app.extra && app.extra.privacyUrl));

  const licenceFile = read('LICENSE');
  check('LICENSE at repo root is GPL v3', /GNU GENERAL PUBLIC LICENSE\s+Version 3/.test(licenceFile));

  const about = read('app/settings/about.tsx');
  const layout = read('app/_layout.tsx');
  check('About has an Open-source licence row valued GPL-3.0', /Open-source licence/.test(about + read('constants/aboutCopy.ts')) && /GPL-3\.0/.test(about + read('constants/aboutCopy.ts')));
  check('licence row opens /settings/licenses', about.includes("/settings/licenses"));
  check('licences page exists and is registered', exists('app/settings/licenses.tsx') && layout.includes('name="settings/licenses"'));
  const page = exists('app/settings/licenses.tsx') ? read('app/settings/licenses.tsx') : '';
  const copy = read('constants/aboutCopy.ts');
  check('licences page says GPL v3 free software', /free software under the GNU General Public License v3\.0/.test(copy));
  check('licences page links to LICENSE on GitHub via REPO_URL', /REPO_URL/.test(page + copy) && /blob\/main\/LICENSE/.test(page + copy));
  check('licences page titled Licences with Built with section', /Licences/.test(page + copy) && /Built with/.test(page + copy));

  const lic = await import('../constants/licenses.generated.ts');
  const list = lic.LICENSES;
  check('generated licence list is non-empty', Array.isArray(list) && list.length > 10);
  const find = (n) => list.find((x) => x.name === n);
  for (const n of ['react-native', 'expo', 'librqbit', 'pixelarticons', '@expo-google-fonts/inter']) {
    const e = find(n);
    check(`list includes ${n} with a licence`, !!e && typeof e.license === 'string' && e.license.length > 0 && e.license !== 'UNKNOWN');
  }
  check('every row has name, version, licence', list.every((x) => x.name && x.version && x.license));
  check('react-native is MIT', find('react-native') && find('react-native').license === 'MIT');
  check('librqbit is Apache-2.0 (from vendored Cargo.toml)', find('librqbit') && find('librqbit').license === 'Apache-2.0');
  const pkg = JSON.parse(read('package.json'));
  check('every runtime dependency is listed', Object.keys(pkg.dependencies).filter((d) => d !== 'maglev-engine').every((d) => find(d)));

  check('Release notes row in About shows installed version', /Release notes/.test(copy) && /aboutExtrasCopy\.releaseNotes\b/.test(about) && /value=\{appVersion\}/.test(about) && about.includes('/settings/whats-new'));
  check('whats-new page exists and is registered', exists('app/settings/whats-new.tsx') && layout.includes('name="settings/whats-new"'));
  const wn = exists('app/settings/whats-new.tsx') ? read('app/settings/whats-new.tsx') : '';
  check('whats-new reads bundled notes, no fetch', /releaseNotes\.generated/.test(wn) && !/fetch\(/.test(wn));
  check('whats-new renders parsed sections', /parseReleaseNotes/.test(wn));
  const rn = await import('../constants/releaseNotes.generated.ts');
  check('bundled notes include the installed version or an older one', typeof rn.RELEASE_NOTES === 'object' && Object.keys(rn.RELEASE_NOTES).length > 5);
  check('bundled notes match release-notes/*.md', fs.readdirSync(path.join(root, 'release-notes')).filter((f) => /^\d+\.\d+\.md$/.test(f)).every((f) => rn.RELEASE_NOTES[f.replace('.md', '')]));
  check('footer still opens Updates', about.includes("openUpdates") && /Opens Updates/.test(about));

  if (failed) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('about extras: all checks passed');
})();
