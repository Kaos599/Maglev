// What's new (0.25): the notes render as titled sections with one row per change, not one block of text.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let failed = 0;
const check = (name, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}`);
  if (!cond) failed++;
};

(async () => {
  const { parseReleaseNotes } = await import(path.join(root, 'utils/releaseNotesParse.ts'));
  const md = '## What\'s new\n- Search your **settings**. See [the site](https://x.y).\n- Second `thing`\n  continued line\n\n## What\'s fixed\n* One fix\n';
  const s = parseReleaseNotes(md);
  check('two sections', s.length === 2);
  check('section titles kept', s[0]?.title === "What's new" && s[1]?.title === "What's fixed");
  check('one item per bullet', s[0]?.items.length === 2 && s[1]?.items.length === 1);
  check('inline markdown stripped', s[0]?.items[0] === 'Search your settings. See the site.');
  check('wrapped line joins its bullet', s[0]?.items[1] === 'Second thing continued line');
  check('* bullets work', s[1]?.items[0] === 'One fix');
  const loose = parseReleaseNotes('- a\n- b');
  check('bullets before any heading go in an untitled section', loose.length === 1 && loose[0].title === '' && loose[0].items.length === 2);
  check('empty input gives no sections', parseReleaseNotes('').length === 0);
  const real = parseReleaseNotes(read('release-notes/0.25.md'));
  check('0.25 notes parse into 3 sections', real.length === 3 && real.every((x) => x.items.length > 0));

  const wn = read('app/settings/whats-new.tsx');
  check('page uses parseReleaseNotes', /parseReleaseNotes/.test(wn));
  check('page renders a SectionHeader per section', /SectionHeader/.test(wn));
  check('page no longer renders one plainNotes block', !/plainNotes\(/.test(wn));
  check('no hex colours in page', !/#[0-9a-fA-F]{3,6}\b/.test(wn));

  if (failed) { console.log(`${failed} failed`); process.exit(1); }
  console.log('whats-new layout: all passed');
})();
