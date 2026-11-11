#!/usr/bin/env node
// Admission vectors (SM-35, docs/STATE_MACHINES_AND_SCREENS.md). The same fixture drives the Kotlin port.
// Needs Node 22.18+ (runs the TypeScript source directly via type stripping).

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

async function main() {
  const { admit } = await import('../utils/admission.ts');
  const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'admission-vectors.json'), 'utf8'));
  check('at least 10 vectors', vectors.length >= 10, String(vectors.length));
  for (const v of vectors) {
    const out = admit({
      freeBytes: v.freeBytes,
      pendingNeed: v.pendingNeed,
      stagingFactor: v.stagingFactor,
      selectionBytes: v.selectionBytes,
    });
    check(`${v.name} -> ${v.expect}`, out.result === v.expect, `got ${out.result}, need ${out.need}, budget ${out.budget}`);
  }
  const one = admit({ freeBytes: 10 * 1024 ** 3, pendingNeed: 0, stagingFactor: 1, selectionBytes: 1024 ** 3 });
  check('budget is free - pending - 200 MB', one.budget === 10 * 1024 ** 3 - 200 * 1024 ** 2, String(one.budget));
  check('leftAfter is budget - need', one.leftAfter === one.budget - one.need, String(one.leftAfter));

  // Add-preview caption: the numbers must add up for a reader.
  const { admissionCaption } = await import('../utils/admissionCopy.ts');
  const MB = 1024 ** 2;
  const tight = admit({ freeBytes: 2252 * MB, pendingNeed: 1400 * MB, stagingFactor: 1, selectionBytes: 11 * MB });
  const cap = admissionCaption(tight, 1400 * MB);
  check('tight with pending downloads says "after your other downloads finish"', /free after your other downloads finish/.test(cap || ''), String(cap));
  check('tight caption names the pending need and the 200 MB margin', /1\.4 GB still to come/.test(cap || '') && /200 MB kept spare/.test(cap || ''), String(cap));
  const tightAlone = admit({ freeBytes: 1000 * MB, pendingNeed: 0, stagingFactor: 1, selectionBytes: 100 * MB });
  check('tight without pending downloads does not mention them', !/other downloads/.test(admissionCaption(tightAlone, 0) || ''));
  const no = admit({ freeBytes: 500 * MB, pendingNeed: 100 * MB, stagingFactor: 1, selectionBytes: 900 * MB });
  check('doesnt fit with pending downloads explains the budget', /only .* free after your other downloads finish/.test(admissionCaption(no, 100 * MB) || ''));
  check('fits has no caption', admissionCaption(admit({ freeBytes: 50 * 1024 ** 3, pendingNeed: 0, stagingFactor: 1, selectionBytes: MB }), 0) === null);

  if (failed) {
    console.error(`\n${failed} failed`);
    process.exit(1);
  }
  console.log('\nadmission tests passed');
}
main();
