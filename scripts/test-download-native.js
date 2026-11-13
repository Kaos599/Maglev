#!/usr/bin/env node
// Static checks for link-download native actions: open folder, completion "Open", notification routing.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const kt = 'modules/maglev-engine/android/src/main/java/com/maglev/engine/';

let failed = 0;
function check(name, cond) {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.error(`  FAIL ${name}`); }
}

const module_ = read(kt + 'MaglevEngineModule.kt');
const host = read(kt + 'EngineHost.kt');
const files = read(kt + 'storage/FileActions.kt');
const types = read('modules/maglev-engine/src/MaglevEngine.types.ts');
const bridge = read('modules/maglev-engine/src/MaglevNativeBridge.ts');
const mock = read('modules/maglev-engine/src/MaglevMockEngine.ts');
const intent = read('app/+native-intent.tsx');
const { readPrivateDoc } = require('./lib/privateDocs');
const contract = readPrivateDoc('NATIVE_CONTRACT.md');

check('module exposes openDownloadFolder', /AsyncFunction\("openDownloadFolder"\)/.test(module_));
check('host has openDownloadFolder reading the downloads list', /fun openDownloadFolder\(id: String\)/.test(host) && /openDownloadFolder[\s\S]{0,900}downloads/.test(host));
check('openDownloadFolder is not limited to finished', !/openDownloadFolder[\s\S]{0,900}state"\] != "finished"/.test(host));
check('TS type has openDownloadFolder', /openDownloadFolder\(id: string\): Promise<EngineResult>/.test(types));
check('bridge routes openDownloadFolder', /openDownloadFolder\(id: string\)[\s\S]{0,80}route\('openDownloadFolder'/.test(bridge));
check('mock has openDownloadFolder', /async openDownloadFolder\(/.test(mock));
check('link completion passes an open action', /Notifications\.notifyCompleted\(c, id, name, Json\.long\(d\["size"\]\), (?!null)/.test(host));
check('folder open has a fallback chain and plain error', /No file manager could open this folder/.test(files) && /ACTION_OPEN_DOCUMENT_TREE/.test(files));
check('native-intent routes dl_ ids to a download param', /\/\?download=\$\{/.test(intent));
if (contract) check('contract documents openDownloadFolder', /openDownloadFolder/.test(contract));

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nAll download-native checks passed');
