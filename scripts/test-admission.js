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
  const { admit, pendingNeedOf } = await import('../utils/admission.ts');
  const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'admission-vectors.json'), 'utf8'));
  check('at least 10 vectors', vectors.length >= 10, String(vectors.length));
  for (const v of vectors) {
    // A vector gives either a ready pendingNeed or the torrents and link downloads it is computed from.
    let pendingNeed = v.pendingNeed;
    if (pendingNeed === undefined) {
      const downloads = v.downloads.map((d) => ({
        state: d.state,
        size: d.size,
        downloaded: d.downloaded,
        error: d.errorCode ? { code: d.errorCode, httpStatus: d.httpStatus } : null,
        stream: d.stream ? {} : null,
      }));
      pendingNeed = pendingNeedOf(v.torrents, downloads);
      check(`${v.name}: pendingNeed is ${v.expectPendingNeed}`, pendingNeed === v.expectPendingNeed, String(pendingNeed));
    }
    const out = admit({
      freeBytes: v.freeBytes,
      pendingNeed,
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
  // SM-35 on the link sheets: the "Not enough space" banner gives the figures and the reason (2026-11-20 phone test:
  // a 1.5 GB file refused with 2.7 GB free because a paused torrent still needed its space).
  const { noSpaceBody } = await import('../utils/admissionCopy.ts');
  const held = admit({ freeBytes: 2765 * MB, pendingNeed: 1400 * MB, stagingFactor: 1, selectionBytes: 1500 * MB });
  const heldBody = noSpaceBody(held, 1400 * MB);
  check('no-space body names the size and what is left after other downloads', /^Needs 1\.5 GB, only 1\.1 GB free after your other downloads finish\./.test(heldBody), heldBody);
  check('no-space body with other downloads offers removing one', /remove a download you don't need/.test(heldBody), heldBody);
  const alone = admit({ freeBytes: 1000 * MB, pendingNeed: 0, stagingFactor: 1, selectionBytes: 900 * MB });
  const aloneBody = noSpaceBody(alone, 0);
  check('no-space body alone: figures, then free up storage', /^Needs 900 MB, .* free\. Free up some storage, then try again\.$/.test(aloneBody) && !/other downloads/.test(aloneBody), aloneBody);
  const hook = fs.readFileSync(path.join(__dirname, '..', 'utils', 'useDownloadAdmission.ts'), 'utf8');
  check('the admission hook returns the no-space body', /noSpaceBody\(/.test(hook));
  for (const f of ['app/add-download.tsx', 'components/browser/FoundDownload.tsx', 'components/browser/StreamSheet.tsx', 'components/browser/BatchSheet.tsx']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    check(`${f}: the space banner uses the hook's body, not the generic line`, /body=\{noSpace\}/.test(src) && !/notEnoughSpace\.body/.test(src));
  }
  // SM-35 counts link downloads: every caller must hand pendingNeedOf the downloads as well as the torrents.
  for (const f of ['app/add-torrent.tsx', 'app/(tabs)/search.tsx', 'components/transfers/lowSpace.ts', 'utils/useDownloadAdmission.ts', 'utils/assistant/toolRunner.ts']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    const calls = [...src.matchAll(/pendingNeedOf\(([\s\S]*?)\)\s*;?\s*$/gm)];
    const real = src.split('\n').filter((l) => /pendingNeedOf\(/.test(l) && !/^\s*(import|\/\/|\*)/.test(l));
    check(`${f}: calls pendingNeedOf`, real.length > 0 && calls.length > 0);
    check(`${f}: pendingNeedOf gets the downloads`, /pendingNeedOf\([^;]*downloads[^;]*\)/.test(src.replace(/\n/g, ' ')), f);
  }
  const lowSpaceSrc = fs.readFileSync(path.join(__dirname, '..', 'components', 'transfers', 'lowSpace.ts'), 'utf8');
  check('lowSpaceWarning takes the downloads', /lowSpaceWarning\([^)]*downloads/.test(lowSpaceSrc.replace(/\n/g, ' ')));
  const idxSrc = fs.readFileSync(path.join(__dirname, '..', 'app', '(tabs)', 'index.tsx'), 'utf8');
  check('Transfers tab passes the downloads to lowSpaceWarning', /lowSpaceWarning\([^;]*downloads[^;]*\)/.test(idxSrc.replace(/\n/g, ' ')));
  check('fits has no caption', admissionCaption(admit({ freeBytes: 50 * 1024 ** 3, pendingNeed: 0, stagingFactor: 1, selectionBytes: MB }), 0) === null);

  if (failed) {
    console.error(`\n${failed} failed`);
    process.exit(1);
  }
  console.log('\nadmission tests passed');
}
main();
