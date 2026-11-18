#!/usr/bin/env node
// Speed limit for one link download: wrapper, down-only sheet mode, download page row, shared handler.
process.removeAllListeners('warning');
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
let failed = 0;
function check(name, cond) {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.error(`  FAIL ${name}`); }
}

const ctx = read('context/EngineContext.tsx');
check('EngineContext type declares setDownloadLimits', /setDownloadLimits: \(id: string, downLimitBps: number\) => Promise<boolean>/.test(ctx));
check('wrapper goes through downloadCall', /setDownloadLimits = useCallback\([\s\S]{0,200}downloadCall\([\s\S]{0,120}maglevEngine\.setDownloadLimits\(id, \{ downLimitBps/.test(ctx));
check('wrapper is provided', /^\s+setDownloadLimits,$/m.test(ctx));

const sheet = read('components/detail/SpeedLimitSheet.tsx');
check('SpeedLimitSheet has a mode prop', /mode\?: 'both' \| 'download'/.test(sheet));
check('upload group hidden in download mode', /mode !== 'download'|mode === 'both'/.test(sheet));
check('download mode says link, torrent copy kept', /Only for this download/.test(sheet) && /Only for this torrent/.test(sheet));

const ds = read('app/download/[id].tsx');
check('download page imports SpeedLimitSheet', /SpeedLimitSheet/.test(ds));
check('download page has Speed limit row', /title="Speed limit"/.test(ds));
check('row shows No limit or formatted limit', /No limit/.test(ds) && /formatLimit\(/.test(ds));
check('row reads downLimitBps', /downLimitBps/.test(ds));
check('page sets the limit through the shared handler', /actions\.setLimit\(d\.id, l\.downBps\)/.test(ds));
check('limit sheet opened in download mode', /mode="download"/.test(ds));

const hook = read('components/transfers/useDownloadActions.ts');
check('shared hook pulls setDownloadLimits', /setDownloadLimits,/.test(hook));
check('shared hook passes the limit on', /void setDownloadLimits\(id, bps\)/.test(hook));
if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
