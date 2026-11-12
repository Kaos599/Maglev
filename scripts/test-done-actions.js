#!/usr/bin/env node
// Finished-download actions (SM-17): which file "Open" uses.
// Needs Node 22.18+ (runs the TypeScript source directly).

process.removeAllListeners('warning');

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}

async function main() {
  const { pickMainFile } = await import('../utils/mainFile.ts');
  const f = (index, path, length, included = true) => ({ index, path, length, included });

  const one = pickMainFile([f(0, 'a/readme.txt', 10), f(1, 'a/movie.mkv', 5000), f(2, 'a/sample.nfo', 3)]);
  check('single video wins over larger non-video', one.main?.index === 1 && one.videos.length === 1);

  const bigDoc = pickMainFile([f(0, 'x.mkv', 100), f(1, 'x.iso', 9000)]);
  check('video wins even if another file is larger', bigDoc.main?.index === 0);

  const skipped = pickMainFile([f(0, 'big.mkv', 9000, false), f(1, 'small.mp4', 100)]);
  check('excluded files are ignored', skipped.main?.index === 1 && skipped.videos.length === 1);

  const none = pickMainFile([f(0, 'a.pdf', 10), f(1, 'b.zip', 500), f(2, 'c.txt', 20)]);
  check('no video falls back to the largest file', none.main?.index === 1 && none.videos.length === 0);

  const season = pickMainFile([f(0, 'S01E01.mkv', 100), f(1, 'S01E02.mkv', 300), f(2, 'S01E03.mkv', 200)]);
  check('season pack returns no main and videos largest first', season.main === null && season.videos.map((v) => v.index).join() === '1,2,0');

  const empty = pickMainFile([]);
  check('no files gives nothing', empty.main === null && empty.videos.length === 0);

  const allSkipped = pickMainFile([f(0, 'a.mkv', 100, false)]);
  check('all skipped gives nothing', allSkipped.main === null);

  if (failed) {
    console.error(`\n${failed} failed`);
    process.exit(1);
  }
  console.log('\ndone-actions tests passed');
}
main();
