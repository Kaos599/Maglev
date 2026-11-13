#!/usr/bin/env node
// Transfers render storm and low-space banner: pure helpers only, no React.
// Needs Node 22.18+ (runs the TypeScript source directly via type stripping).

process.removeAllListeners('warning');

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

async function main() {
  const { sameFields, shareRows, steadyResolvingSecs } = await import('../components/transfers/snapshots.ts');
  const { lowSpaceWarning, usableFreeOf } = await import('../components/transfers/lowSpace.ts');
  const { ADMISSION_RESERVE_BYTES } = await import('../utils/admission.ts');
  const { smoothRate } = await import('../utils/rates.ts');

  // ---- sameFields
  check('sameFields: same values in new objects', sameFields({ id: 'a', n: 1, error: null }, { id: 'a', n: 1, error: null }));
  check('sameFields: nested error compared by value', sameFields({ error: { code: 'X', message: 'm' } }, { error: { code: 'X', message: 'm' } }));
  check('sameFields: nested error difference', !sameFields({ error: { code: 'X', message: 'm' } }, { error: { code: 'X', message: 'n' } }));
  check('sameFields: one changed number', !sameFields({ id: 'a', n: 1 }, { id: 'a', n: 2 }));
  check('sameFields: missing and undefined are equal', sameFields({ id: 'a' }, { id: 'a', health: undefined }));
  check('sameFields: missing and null differ', !sameFields({ id: 'a' }, { id: 'a', health: null }));
  check('sameFields: an added marker differs', !sameFields({ id: 'a' }, { id: 'a', lastKnown: true }));

  // ---- shareRows
  const a = { id: 'a', v: 1 };
  const b = { id: 'b', v: 2 };
  const prev = [a, b];
  check('shareRows: unchanged list returns the previous array', shareRows(prev, [{ id: 'a', v: 1 }, { id: 'b', v: 2 }]) === prev);
  const oneChanged = shareRows(prev, [{ id: 'a', v: 1 }, { id: 'b', v: 3 }]);
  check('shareRows: one change gives a new array', oneChanged !== prev);
  check('shareRows: the unchanged row keeps its object', oneChanged[0] === a);
  check('shareRows: the changed row is the new object', oneChanged[1] !== b && oneChanged[1].v === 3);
  const reordered = shareRows(prev, [{ id: 'b', v: 2 }, { id: 'a', v: 1 }]);
  check('shareRows: a new order is a change, rows reused', reordered !== prev && reordered[0] === b && reordered[1] === a);
  check('shareRows: a removed row is a change', shareRows(prev, [{ id: 'a', v: 1 }]) !== prev);
  check('shareRows: an added row is a change', shareRows(prev, [{ id: 'a', v: 1 }, { id: 'b', v: 2 }, { id: 'c', v: 0 }]).length === 3);
  const empty = [];
  check('shareRows: empty to empty returns the previous array', shareRows(empty, []) === empty);

  // ---- steadyResolvingSecs
  check('steady: null stays null', steadyResolvingSecs(null) === null && steadyResolvingSecs(undefined) === null);
  check('steady: 5 s steps in the first minute', steadyResolvingSecs(0) === 0 && steadyResolvingSecs(4) === 0 && steadyResolvingSecs(7) === 5 && steadyResolvingSecs(59) === 55);
  check('steady: 15 s steps to ten minutes', steadyResolvingSecs(60) === 60 && steadyResolvingSecs(74) === 60 && steadyResolvingSecs(599) === 585);
  check('steady: whole minutes after', steadyResolvingSecs(600) === 600 && steadyResolvingSecs(659) === 600 && steadyResolvingSecs(3725) === 3720);
  check('steady: never more than the real time', [0, 3, 59, 61, 333, 601, 9999].every((s) => steadyResolvingSecs(s) <= s));
  check('steady: bad input is 0', steadyResolvingSecs(-3) === 0 && steadyResolvingSecs(NaN) === 0);

  // ---- smoothRate settles to zero
  let r = 1_000_000;
  let ticks = 0;
  while (r !== 0 && ticks < 600) {
    r = smoothRate(r, 0, 1000);
    ticks++;
  }
  check('smoothRate: an idle rate reaches exactly 0', r === 0, `${ticks} ticks`);
  check('smoothRate: and stays at 0', smoothRate(0, 0, 1000) === 0);
  check('smoothRate: a live small rate is not snapped', smoothRate(10, 5, 1000) > 0);

  // ---- 10 s with one "Looking for peers" torrent and one paused torrent (1 tick per second).
  // Before: every tick was a new list (10 state updates) and the card's text changed every tick (10 card renders).
  const tickRows = (sec) => [
    { id: 'm', name: 'Magnet', state: 'INITIALIZING', resolvingSecs: 30 + sec, peersTotal: 0, downloadSpeedBytes: 0, error: null },
    { id: 'p', name: 'Paused', state: 'PAUSED', pausedBy: 'user', downloadSpeedBytes: 0, error: null },
  ];
  let list = tickRows(0);
  let stateUpdates = 0;
  let cardRenders = 0;
  let pausedRowRenders = 0;
  let lastCardSecs = steadyResolvingSecs(list[0].resolvingSecs);
  const pausedObj = list[1];
  for (let sec = 1; sec <= 10; sec++) {
    const next = shareRows(list, tickRows(sec));
    if (next !== list) stateUpdates++;
    if (next[1] !== pausedObj) pausedRowRenders++;
    const shown = steadyResolvingSecs(next[0].resolvingSecs);
    if (shown !== lastCardSecs) cardRenders++;
    lastCardSecs = shown;
    list = next;
  }
  check('storm: the elapsed time is real data, so the list still updates each second', stateUpdates === 10, String(stateUpdates));
  check('storm: the paused row keeps its object (its card never re-renders)', pausedRowRenders === 0, String(pausedRowRenders));
  check('storm: the looking-for-peers card renders 2 times in 10 s, not 10', cardRenders === 2, String(cardRenders));

  // An idle list (paused, done, waiting) makes no state updates at all. Before: 10 in 10 s.
  const idle = () => [
    { id: 'p', state: 'PAUSED', pausedBy: 'user', downloadSpeedBytes: 0, error: null },
    { id: 'd', state: 'COMPLETED', downloadSpeedBytes: 0, error: null },
  ];
  let idleList = idle();
  let idleUpdates = 0;
  for (let sec = 1; sec <= 10; sec++) {
    const next = shareRows(idleList, idle());
    if (next !== idleList) idleUpdates++;
    idleList = next;
  }
  check('storm: an idle list makes 0 updates in 10 s', idleUpdates === 0, String(idleUpdates));

  // ---- low-space banner
  const t = (included, downloaded, finished = false) => ({ includedBytes: included, downloadedBytes: downloaded, finished });
  const short = lowSpaceWarning(1.1 * GB, [t(3.1 * GB, 0)]);
  check('lowSpace: need over free shows the banner', !!short);
  check('lowSpace: title', short && short.title === 'Not enough space for your downloads');
  check('lowSpace: body names how much more and how much is free', short && short.body === 'Unfinished downloads need 2.0 GB more than the 1.1 GB free.', short && short.body);
  check('lowSpace: exactly the reserve left is fine', lowSpaceWarning(1 * GB + ADMISSION_RESERVE_BYTES, [t(1 * GB, 0)]) === null);
  const under = lowSpaceWarning(1 * GB + ADMISSION_RESERVE_BYTES - 1, [t(1 * GB, 0)]);
  check('lowSpace: one byte under the reserve shows the banner', !!under);
  check('lowSpace: under the reserve but not over free says so', under && /need 1\.0 GB of the 1\.2 GB free\. That leaves less than 200 MB for your phone\./.test(under.body), under && under.body);
  check('lowSpace: unknown free space shows nothing', lowSpaceWarning(null, [t(5 * GB, 0)]) === null && lowSpaceWarning(undefined, [t(5 * GB, 0)]) === null && lowSpaceWarning(NaN, [t(5 * GB, 0)]) === null);
  check('lowSpace: no unfinished downloads shows nothing', lowSpaceWarning(10 * MB, []) === null && lowSpaceWarning(10 * MB, [t(5 * GB, 0, true)]) === null);
  check('lowSpace: fully downloaded rows need nothing', lowSpaceWarning(10 * MB, [t(5 * GB, 5 * GB)]) === null);
  check('lowSpace: pending need uses what is left, not the size', lowSpaceWarning(2 * GB, [t(5 * GB, 4 * GB)]) === null);
  check('lowSpace: plenty of space shows nothing', lowSpaceWarning(50 * GB, [t(5 * GB, 0)]) === null);
  check('usableFree: smaller of folder and target', usableFreeOf({ freeBytes: 5 * GB, targetFreeBytes: 2 * GB }) === 2 * GB);
  check('usableFree: no target uses the folder', usableFreeOf({ freeBytes: 5 * GB, targetFreeBytes: null }) === 5 * GB && usableFreeOf({ freeBytes: 5 * GB }) === 5 * GB);
  check('usableFree: missing or bad is unknown', usableFreeOf(null) === null && usableFreeOf({ freeBytes: NaN }) === null && usableFreeOf({ freeBytes: -1 }) === null);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('test run crashed:', e);
  process.exit(1);
});
