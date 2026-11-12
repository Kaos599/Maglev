#!/usr/bin/env node
// Optimistic pause / resume / remove (utils/optimistic.ts): pure helpers only, no React, no engine.
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

const row = (id, state, extra = {}) => ({
  id,
  name: id,
  state,
  pausedBy: null,
  downloadSpeedBytes: state === 'DOWNLOADING' ? 500_000 : 0,
  uploadSpeedBytes: state === 'SEEDING' || state === 'DOWNLOADING' ? 20_000 : 0,
  rawDownBps: state === 'DOWNLOADING' ? 480_000 : 0,
  rawUpBps: state === 'SEEDING' || state === 'DOWNLOADING' ? 21_000 : 0,
  etaSeconds: state === 'DOWNLOADING' ? 120 : -1,
  progressPercent: 40,
  downloadedBytes: 400,
  totalSizeBytes: 1000,
  ...extra,
});

async function main() {
  const {
    EMPTY_PENDING,
    beginPending,
    confirmGroup,
    failGroup,
    settlePending,
    nextExpiry,
    isSettled,
    applyPending,
  } = await import('../utils/optimistic.ts');

  const T = 5000;
  const a = row('a', 'DOWNLOADING');
  const b = row('b', 'PAUSED', { pausedBy: 'user' });
  const c = row('c', 'SEEDING');
  const rows = [a, b, c];

  // ---- apply
  {
    check('apply: no pending returns the same array', applyPending(rows, EMPTY_PENDING) === rows);
    const m = beginPending(EMPTY_PENDING, ['a'], 'pause', 1, 1000);
    check('begin: entry is recorded unconfirmed', m.a && m.a.kind === 'pause' && m.a.confirmed === false && m.a.group === 1 && m.a.since === 1000);
    check('begin: input map is not mutated', Object.keys(EMPTY_PENDING).length === 0);
    const out = applyPending(rows, m);
    const pa = out.find((r) => r.id === 'a');
    check('apply pause: state PAUSED by user', pa.state === 'PAUSED' && pa.pausedBy === 'user');
    check('apply pause: speeds are zero, time left unknown', pa.downloadSpeedBytes === 0 && pa.uploadSpeedBytes === 0 && pa.rawDownBps === 0 && pa.rawUpBps === 0 && pa.etaSeconds === -1);
    check('apply pause: pending flag and action', pa.pending === true && pa.pendingAction === 'pause');
    check('apply pause: progress and sizes untouched (no invented numbers)', pa.progressPercent === 40 && pa.downloadedBytes === 400 && pa.totalSizeBytes === 1000);
    check('apply: rows without an entry keep their object', out.find((r) => r.id === 'b') === b && out.find((r) => r.id === 'c') === c);
    check('apply: source row not mutated', a.state === 'DOWNLOADING' && a.pending === undefined);

    const r = applyPending(rows, beginPending(EMPTY_PENDING, ['b'], 'resume', 2, 1000)).find((x) => x.id === 'b');
    check('apply resume: state is NOT invented (stays as the engine said)', r.state === 'PAUSED' && r.pausedBy === 'user');
    check('apply resume: neutral pending flag only', r.pending === true && r.pendingAction === 'resume');
    check('apply resume: speeds untouched', r.downloadSpeedBytes === 0 && r.etaSeconds === -1);

    const gone = applyPending(rows, beginPending(EMPTY_PENDING, ['c'], 'remove', 3, 1000));
    check('apply remove: row hidden', gone.length === 2 && !gone.some((x) => x.id === 'c'));

    const hidden = applyPending(rows, EMPTY_PENDING, new Set(['a']));
    check('apply: extra hidden ids are hidden too', hidden.length === 2 && !hidden.some((x) => x.id === 'a'));
  }

  // ---- confirm: the engine said ok, but the hold stays until telemetry agrees
  {
    let m = beginPending(EMPTY_PENDING, ['a'], 'pause', 1, 1000);
    m = confirmGroup(m, 1);
    check('confirm: entry marked confirmed and kept', m.a && m.a.confirmed === true);
    check('confirm: unknown group returns the same map', confirmGroup(m, 99) === m);
    // Next tick from the engine still says DOWNLOADING (stale): the row must stay paused.
    const stale = settlePending(m, [a, b, c], 1500, T);
    check('stale tick (confirmed): hold kept, same map', stale === m);
    check('stale tick: row still shown paused', applyPending([a, b, c], stale).find((r) => r.id === 'a').state === 'PAUSED');
    // The engine now reports PAUSED: the override ends, telemetry takes over.
    const live = settlePending(m, [row('a', 'PAUSED', { pausedBy: 'user' }), b, c], 2000, T);
    check('confirmed by telemetry: entry dropped', live.a === undefined);
    const after = applyPending([row('a', 'PAUSED', { pausedBy: 'user' }), b, c], live).find((r) => r.id === 'a');
    check('after confirm: row is the engine row (no pending flag)', after.pending === undefined);
  }

  // ---- stale tick before the engine answered
  {
    const m = beginPending(EMPTY_PENDING, ['a'], 'pause', 1, 1000);
    check('stale tick (unconfirmed): hold kept', settlePending(m, [a, b, c], 1200, T) === m);
    const rm = beginPending(EMPTY_PENDING, ['c'], 'remove', 4, 1000);
    check('stale tick during remove: row stays hidden', settlePending(rm, [a, b, c], 1200, T) === rm);
    check('remove settled once the engine list lacks the row', settlePending(rm, [a, b], 1300, T).c === undefined);
    const rs = beginPending(EMPTY_PENDING, ['b'], 'resume', 5, 1000);
    check('resume held while the engine still says PAUSED', settlePending(rs, [a, b, c], 1200, T) === rs);
    check('resume settled once the engine leaves PAUSED (any state)', settlePending(rs, [a, row('b', 'QUEUED'), c], 1300, T).b === undefined);
    check('resume settled on ERROR too (the engine answered)', settlePending(rs, [a, row('b', 'ERROR'), c], 1300, T).b === undefined);
    check('pause/resume entry dropped when the torrent is gone', settlePending(m, [b, c], 1300, T).a === undefined);
  }

  // ---- fail -> rollback
  {
    let m = beginPending(EMPTY_PENDING, ['a', 'c'], 'pause', 7, 1000);
    m = beginPending(m, ['b'], 'resume', 8, 1000);
    const f = failGroup(m, 7);
    check('fail: only that group is removed', f.a === undefined && f.c === undefined && f.b && f.b.group === 8);
    const out = applyPending(rows, f);
    check('fail: rows roll back to the engine snapshot (same objects)', out.find((r) => r.id === 'a') === a && out.find((r) => r.id === 'c') === c);
    check('fail: unknown group returns the same map', failGroup(m, 99) === m);
    const rm = failGroup(beginPending(EMPTY_PENDING, ['c'], 'remove', 9, 1000), 9);
    check('fail remove: row comes back', applyPending(rows, rm).some((r) => r.id === 'c'));
  }

  // ---- timeout -> trust telemetry
  {
    let m = beginPending(EMPTY_PENDING, ['a'], 'pause', 1, 1000);
    m = beginPending(m, ['b'], 'resume', 2, 3000);
    check('nextExpiry: earliest since + timeout', nextExpiry(m, T) === 6000);
    check('nextExpiry: none when empty', nextExpiry(EMPTY_PENDING, T) === null);
    check('before timeout: kept', settlePending(m, [a, b, c], 5999, T) === m);
    const t = settlePending(m, [a, b, c], 6000, T);
    check('at timeout: entry dropped even though telemetry disagrees', t.a === undefined && t.b && t.b.kind === 'resume');
    check('after timeout: row is the engine row again', applyPending([a, b, c], t).find((r) => r.id === 'a') === a);
    check('later entry times out later', settlePending(m, [a, b, c], 8000, T).b === undefined);
  }

  // ---- re-begin replaces an entry, isSettled basics
  {
    const m = beginPending(beginPending(EMPTY_PENDING, ['a'], 'pause', 1, 1000), ['a'], 'resume', 2, 2000);
    check('begin again: newest entry wins', m.a.kind === 'resume' && m.a.group === 2);
    check('begin with no ids: same map', beginPending(m, [], 'pause', 3, 1) === m);
    check('isSettled pause', isSettled(row('x', 'PAUSED'), { kind: 'pause' }) && !isSettled(row('x', 'SEEDING'), { kind: 'pause' }));
    check('isSettled remove', isSettled(undefined, { kind: 'remove' }) && !isSettled(row('x', 'PAUSED'), { kind: 'remove' }));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
