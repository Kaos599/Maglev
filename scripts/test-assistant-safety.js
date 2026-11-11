#!/usr/bin/env node
// File-list safety check (docs/ASSISTANT_DESIGN.md §3.4, §3.6 item 7). No network.
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

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'assistant');
const LEVELS = ['red', 'amber', 'green'];

async function main() {
  const { checkFileSafety } = await import('../utils/assistant/fileSafety.ts');

  for (const level of LEVELS) {
    const cases = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `safety-${level}.json`), 'utf8'));
    for (const c of cases) {
      const out = checkFileSafety(c.input);
      check(`[${level}] ${c.name}: level ${c.expect.level}`, out.level === c.expect.level, `got ${out.level}`);
      if (c.expect.reasonMatch) {
        const re = new RegExp(c.expect.reasonMatch, 'i');
        check(`[${level}] ${c.name}: reason matches /${c.expect.reasonMatch}/`, out.reasons.some((r) => re.test(r)), out.reasons.join(' | '));
      }
      check(`[${level}] ${c.name}: reasons are plain strings`, out.reasons.length > 0 && out.reasons.every((r) => typeof r === 'string' && r.length > 0 && !/undefined|NaN/.test(r)));
    }
  }

  // Green always carries the "not a guarantee" wording, never "safe".
  const clean = checkFileSafety({
    name: 'Harbor.2023.1080p.WEB-DL.x265',
    category: 'movie',
    files: [{ path: 'Harbor/Harbor.2023.1080p.mkv', sizeBytes: 2147483648 }],
  });
  check('green reason is the fixed wording', clean.reasons[0] === 'I found nothing suspicious in the file list. That is not a guarantee.', clean.reasons[0]);
  check('green never says "safe"', !clean.reasons.some((r) => /\bsafe\b/i.test(r)));

  // Empty list cannot be green.
  const empty = checkFileSafety({ name: 'x', category: 'movie', files: [] });
  check('empty file list is amber', empty.level === 'amber', empty.level);

  // Level is the worst finding, and every finding is reported.
  const both = checkFileSafety({
    name: 'Harbor.2023.1080p.WEB-DL.x265',
    category: 'movie',
    parserWarnings: ['cam_source'],
    files: [{ path: 'Harbor/Setup.exe', sizeBytes: 1048576 }, { path: 'Harbor/Harbor.2023.1080p.mkv', sizeBytes: 2147483648 }],
  });
  check('worst level wins (red over amber)', both.level === 'red', both.level);
  check('all findings are reported', both.reasons.length === 2, String(both.reasons.length));

  // Exec rule does not apply to "other" torrents (software can ship an .exe).
  const software = checkFileSafety({ name: 'SomeTool 2.1', category: 'other', files: [{ path: 'SomeTool/setup.exe', sizeBytes: 5242880 }] });
  check('exe in an "other" torrent is not red', software.level !== 'red', software.level);

  // Size bands: an unknown codec uses the lenient HEVC band, so a 1 GB 1080p file is not too small.
  const unknownCodec = checkFileSafety({
    name: 'Harbor.2023.1080p.WEB',
    category: 'movie',
    files: [{ path: 'Harbor/Harbor.2023.1080p.mkv', sizeBytes: 1073741824 }],
  });
  check('unknown codec uses lenient band (1 GB 1080p is green)', unknownCodec.level === 'green', unknownCodec.reasons.join(' | '));

  // The module stays pure: no React, react-native or engine imports.
  const src = fs.readFileSync(path.join(__dirname, '..', 'utils', 'assistant', 'fileSafety.ts'), 'utf8');
  const imports = [...src.matchAll(/^\s*import[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  const forbidden = imports.filter((p) => /react|engine|maglev|modules\//i.test(p));
  check('fileSafety.ts imports no React or engine modules', forbidden.length === 0, forbidden.join(', '));

  if (failed) {
    console.error(`\n${failed} failed`);
    process.exit(1);
  }
  console.log('\nassistant safety tests passed');
}
main();
