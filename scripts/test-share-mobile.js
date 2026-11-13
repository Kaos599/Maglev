#!/usr/bin/env node
// Share for finished link downloads, and the mobile-data note on the add screens.
// Static checks plus the pure copy builder. Needs Node 22.18+ (runs the TypeScript source directly).
process.removeAllListeners('warning');
const fs = require('fs');
const path = require('path');

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

async function main() {
  const module_ = read('modules/maglev-engine/android/src/main/java/com/maglev/engine/MaglevEngineModule.kt');
  const host = read('modules/maglev-engine/android/src/main/java/com/maglev/engine/EngineHost.kt');
  const actions = read('modules/maglev-engine/android/src/main/java/com/maglev/engine/storage/FileActions.kt');
  const types = read('modules/maglev-engine/src/MaglevEngine.types.ts');
  const bridge = read('modules/maglev-engine/src/MaglevNativeBridge.ts');
  const mock = read('modules/maglev-engine/src/MaglevMockEngine.ts');
  const index = read('app/(tabs)/index.tsx');
  const ctx = read('context/EngineContext.tsx');
  const addDl = read('app/add-download.tsx');
  const addTor = read('app/add-torrent.tsx');
  const dlCopy = read('utils/downloadCopy.ts');

  console.log('share a finished download');
  check('module exposes shareDownload', /AsyncFunction\("shareDownload"\)/.test(module_));
  check('host has shareDownload requiring finished', /fun shareDownload\(id: String\)/.test(host) && /shareDownload[\s\S]{0,1200}"finished"/.test(host));
  check('FileActions can share a document URI', /fun shareUri\(/.test(actions));
  check('TS type has shareDownload', /shareDownload\(id: string\): Promise<EngineResult>/.test(types));
  check('bridge routes shareDownload', /shareDownload\(id: string\)[\s\S]{0,80}route\('shareDownload'/.test(bridge));
  check('mock has shareDownload', /async shareDownload\(/.test(mock));
  check('index wires onShare to shareDownload', /onShare=\{/.test(index) && /maglevEngine\.shareDownload\(/.test(index));
  check('share failure text lives in downloadCopy', /export const SHARE_FAILED_TEXT/.test(dlCopy) && /SHARE_FAILED_TEXT/.test(index));

  console.log('mobile data awareness');
  check('module exposes getNetworkState', /AsyncFunction\("getNetworkState"\)/.test(module_));
  check('host has networkState with metered and connected', /fun networkState\(\)/.test(host) && /"metered"/.test(host) && /"connected"/.test(host));
  check('TS type has getNetworkState', /getNetworkState\(\): Promise<EngineResult<NetworkState>>/.test(types) && /interface NetworkState/.test(types));
  check('bridge routes getNetworkState', /route\('getNetworkState'/.test(bridge));
  check('mock getNetworkState says not metered', /async getNetworkState\(/.test(mock) && /metered: false/.test(mock));
  check('EngineContext exposes onMeteredNetwork', /onMeteredNetwork: boolean/.test(ctx) && /onMeteredNetwork,/.test(ctx));
  check('EngineContext refreshes on app active', /getNetworkState/.test(ctx) && /next === 'active'/.test(ctx));
  check('add-download shows the mobile data note', /mobileDataLine\(/.test(addDl) && /onMeteredNetwork/.test(addDl) && /wifiOnly/.test(addDl));
  check('add-torrent shows the mobile data note', /mobileDataLine\(/.test(addTor) && /onMeteredNetwork/.test(addTor) && /wifiOnly/.test(addTor));

  const { mobileDataLine } = await import('../constants/copy.ts');
  const GIB = 1024 ** 3;
  check('builder: 1.2 GiB on mobile data', mobileDataLine(true, false, 1.2 * GIB) === "You're on mobile data. This is 1.2 GB.", String(mobileDataLine(true, false, 1.2 * GIB)));
  check('builder: unknown size says nothing', mobileDataLine(true, false, null) === null);
  check('builder: zero size says nothing', mobileDataLine(true, false, 0) === null);
  check('builder: not metered says nothing', mobileDataLine(false, false, 5 * GIB) === null);
  check('builder: Wi-Fi only on mobile data waits', mobileDataLine(true, true, 5 * GIB) === 'This waits for Wi-Fi.');
  check('builder: Wi-Fi only waits even with unknown size', mobileDataLine(true, true, null) === 'This waits for Wi-Fi.');
  check('builder: Wi-Fi only on Wi-Fi says nothing', mobileDataLine(false, true, 5 * GIB) === null);

  if (failed) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll share and mobile data checks passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
