#!/usr/bin/env node
// Feature 5: parts per link download. The pref (1, 2, 4 or 8, default 4) lives in utils/prefs/linkDownloads.ts,
// PartsSection renders it on Settings > Downloads, and add-download passes `segments` with every plain-file add.
// Streams (HLS/DASH) go through StreamSheet and get no parts control.
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

async function main() {
  console.log('pref');
  const P = await import('../utils/prefs/linkDownloads.ts');
  check('allowed values are 1, 2, 4, 8', JSON.stringify([...P.PART_CHOICES]) === '[1,2,4,8]', JSON.stringify(P.PART_CHOICES));
  check('default is 4', P.DEFAULT_DOWNLOAD_PARTS === 4);
  check('fresh install reads 4', P.getLinkDownloadPrefs().downloadParts === 4);
  check('normalize keeps 1, 2, 4 and 8', [1, 2, 4, 8].every((n) => P.normalizeDownloadParts(n) === n));
  check('normalize rejects 3 and falls back to 4', P.normalizeDownloadParts(3) === 4);
  check('normalize rejects 16 and falls back to 4', P.normalizeDownloadParts(16) === 4);
  check('normalize rejects a string and falls back to 4', P.normalizeDownloadParts('8') === 4);
  check('normalize rejects null and falls back to 4', P.normalizeDownloadParts(null) === 4);
  check('normalize rejects 0 and falls back to 4', P.normalizeDownloadParts(0) === 4);
  check('update stores an allowed value', (P.updateLinkDownloadPrefs({ downloadParts: 8 }), P.getLinkDownloadPrefs().downloadParts === 8));
  check('update with a bad value is coerced to 4', (P.updateLinkDownloadPrefs({ downloadParts: 5 }), P.getLinkDownloadPrefs().downloadParts === 4));
  check('useLinkDownloadPrefs is exported', typeof P.useLinkDownloadPrefs === 'function');
  P.updateLinkDownloadPrefs({ downloadParts: 4 });

  console.log('PartsSection');
  const parts = read('components/settings/PartsSection.tsx');
  check('exports PartsSection', /export function PartsSection\(\s*\)/.test(parts));
  check('takes no props', /PartsSection\(\s*\)\s*\{/.test(parts));
  check('uses the Parts per download label', parts.includes('label="Parts per download"'));
  check('uses ChipGroup from SettingsParts', /ChipGroup/.test(parts) && /from '\.\/SettingsParts'/.test(parts));
  check('offers the PART_CHOICES values (1, 2, 4, 8)', /PART_CHOICES\.map/.test(parts) && /PART_CHOICES/.test(read('utils/prefs/linkDownloads.ts')));
  check(
    'caption is the agreed copy',
    parts.includes("More parts can be faster. Sites that don't allow it get one part automatically.") ||
      parts.includes('More parts can be faster. Sites that don\'t allow it get one part automatically.'),
  );
  check('caption is passed to ChipGroup', /caption=/.test(parts));
  check('writes through the pref hook updater', /useLinkDownloadPrefs\(\)/.test(parts) && /update\(\{ downloadParts: v \}\)/.test(parts));
  check('no hex colours outside constants', !/#[0-9a-fA-F]{3,8}\b/.test(parts));

  console.log('add-download');
  const add = read('app/add-download.tsx');
  check('imports the parts pref', /from '\.\.\/utils\/prefs\/linkDownloads'/.test(add));
  check('passes segments to startDownload', /startDownload\([\s\S]*?segments:/.test(add));
  check('segments comes from the effective parts value', /segments:\s*parts\b/.test(add) || /segments:\s*effectiveParts\b/.test(add));
  check('has a Parts label near the destination', /label="Parts"/.test(add));
  check('override chips are 1, 2, 4 and 8', /\[1, 2, 4, 8\]|value: 1[\s\S]*value: 8/.test(add) || add.includes('PART_CHOICES'));
  check('stream path does not get a parts control', (() => {
    const streamStart = add.indexOf('<StreamSheet');
    const streamPart = streamStart >= 0 ? add.slice(streamStart, add.indexOf('/>', streamStart) + 2) : '';
    return streamStart >= 0 && !/segments|Parts/.test(streamPart);
  })());
  check('parts override defaults to the pref', /useLinkDownloadPrefs\(\)/.test(add));

  // 0.26: the engine splits downloads (#70), so Parts is shown and an add sends the chosen count (reality rule 6).
  console.log('parts reach the engine');
  check('no PARTS_ENABLED flag left', !('PARTS_ENABLED' in P) && !/PARTS_ENABLED/.test(add));
  check('default is 4 parts', P.DEFAULT_DOWNLOAD_PARTS === 4);
  check('add-download sends the override or the pref', /const parts: DownloadParts = partsOverride \?\? linkPrefs\.downloadParts;/.test(add) && /segments: parts/.test(add));
  check('add-download shows the Parts chips', /<ChipGroup label="Parts"/.test(add));
  check('Settings > Downloads shows PartsSection', /<PartsSection \/>/.test(read('app/settings/downloads.tsx')));
  check('main list row shows the parts count', /downloadParts === 1 \? '1 part'/.test(read('app/(tabs)/settings.tsx')));
  const idx = await import('../utils/settingsIndex.ts');
  check('settings search has the Parts entry', idx.SETTINGS_INDEX.some((e) => e.id === 'speed-parts'));

  if (failed) {
    console.log(`\n${failed} failed`);
    process.exit(1);
  }
  console.log('\nall download-parts checks passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
