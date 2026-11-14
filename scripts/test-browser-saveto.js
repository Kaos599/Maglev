#!/usr/bin/env node
// "Save to" for one download (docs/BROWSER_DOWNLOAD_GAPS.md R5). The choice goes to addDownload as
// DownloadOptions.folder and never changes the engine's target. `folder` is a POSIX path Rust writes to
// (EngineHost.addDownload only fills it in when it is missing), so the sheet offers subfolders of the default
// root, not a SAF tree. Needs Node 22.18+ (runs TypeScript source directly).
process.removeAllListeners('warning');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`); }
}
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

async function main() {
  const s = await import('../components/browser/saveTo.ts');
  const R = '/storage/emulated/0/Download/Maglev';

  console.log('subfolderName');
  check('a plain name stays', s.subfolderName('Films') === 'Films');
  check('spaces are trimmed and collapsed', s.subfolderName('  Road  trip ') === 'Road trip');
  check('slashes cannot make a deeper or outside path', !/[\\/]/.test(s.subfolderName('a/b\\c')));
  check('.. is never a name', s.subfolderName('..') === '' && s.subfolderName('../x') !== '../x' && !s.subfolderName('../x').includes('..'));
  check('leading dots are dropped (no hidden folders)', s.subfolderName('.hidden') === 'hidden');
  check('control characters and reserved characters go', s.subfolderName('a\u0000b:c*d?e"f<g>h|i') === 'abcdefghi');
  check('empty stays empty', s.subfolderName('   ') === '');
  check('long names are cut to 64', s.subfolderName('x'.repeat(200)).length === 64);

  console.log('saveFolder');
  check('joins the root and the name', s.saveFolder(R, 'Films') === `${R}/Films`);
  check('a trailing slash on the root is fine', s.saveFolder(`${R}/`, 'Films') === `${R}/Films`);
  check('an empty name gives null', s.saveFolder(R, ' ') === null);
  check('a name that tries to leave the root stays inside it', (s.saveFolder(R, '../../etc') ?? '').startsWith(`${R}/`) && !(s.saveFolder(R, '../../etc') ?? '').includes('..'));

  console.log('wiring');
  const sheet = read('components/browser/FoundDownload.tsx');
  const choice = read('components/browser/SaveToChoice.tsx');
  check('the download sheet uses the one-download choice', /<SaveToChoice/.test(sheet) && !/<SaveToRow/.test(sheet));
  check('startDownload gets the folder', /startDownload\(t\.url,[^;]*folder/.test(sheet));
  check('the choice never calls the folder picker', !/pickDownloadFolder/.test(choice) && !/maglevEngine/.test(choice));
  check('the sheet never changes the engine target', !/pickDownloadFolder|setStorage|setDownloadFolder/.test(sheet));
  check('the default is to pass no folder', /folder\s*\?\s*\{\s*folder\s*\}|\.\.\.\(folder/.test(sheet));
  const host = read('modules/maglev-engine/android/src/main/java/com/maglev/engine/EngineHost.kt');
  check('native: a given folder is used as is, the active target only fills a missing one', /opts\["folder"\] == null/.test(host));
  const bridge = read('modules/maglev-engine/src/MaglevNativeBridge.ts');
  check('native: pickDownloadFolder is the call that changes the target', /pickDownloadFolder\(\)/.test(bridge));
  const copy = await import('../constants/copy.ts');
  check('copy exists', typeof copy.saveTo === 'object');
}

main().then(() => {
  if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
  console.log('\nall ok');
}, (e) => { console.error(e); process.exit(1); });
