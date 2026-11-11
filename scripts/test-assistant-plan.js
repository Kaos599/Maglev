#!/usr/bin/env node
// SM-39 Plan card machine (with review round 1 R1-2). One assertion per row of the transition table, on {state.kind, effects}.
// Each step is revalidate(i), then execute(i) only after STEP_REVALIDATED ok. RETRY rechecks before it re-runs.
// Needs Node 22.18+ (runs the TypeScript sources directly via type stripping).
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

async function main() {
  const m = await import('../utils/assistant/planMachine.ts');
  const ok3 = { ok: true };
  // Compare only {kind, effects}, as the spec's tests require.
  const snap = (state, event) => {
    const r = m.planStep(state, event);
    return JSON.stringify({ kind: r.state.kind, effects: r.effects });
  };
  const expectStep = (name, state, event, kind, effects) => {
    const got = snap(state, event);
    check(name, got === JSON.stringify({ kind, effects }), got);
  };

  const proposed3 = m.planInitial(3);
  const at = (index, phase) => ({ kind: 'running', total: 3, index, phase });
  const halted1 = { kind: 'halted', total: 3, index: 1, reason: 'Storage full.' };

  // Rows of the SM-39 table.
  expectStep('proposed + CONFIRM (all steps valid) revalidates step 0 and does not execute it', proposed3, { type: 'CONFIRM', checks: [ok3, ok3, ok3] }, 'running', [
    { type: 'revalidate', step: 0 },
  ]);
  expectStep('proposed + CONFIRM (a step invalid) marks it and stays proposed', proposed3, { type: 'CONFIRM', checks: [ok3, { ok: false, reason: 'Gone' }, ok3] }, 'proposed', [
    { type: 'markInvalid', step: 1, reason: 'Gone' },
  ]);
  expectStep('running(0, revalidating) + STEP_REVALIDATED ok executes step 0', at(0, 'revalidating'), { type: 'STEP_REVALIDATED', ok: true }, 'running', [
    { type: 'execute', step: 0 },
  ]);
  {
    const reason = "Doesn't fit any more.";
    const r = m.planStep(at(1, 'revalidating'), { type: 'STEP_REVALIDATED', ok: false, reason });
    check(
      'running(1, revalidating) + STEP_REVALIDATED not ok halts with that reason and step 2 is not run',
      r.state.kind === 'halted' && r.state.index === 1 && r.state.reason === reason && JSON.stringify(r.effects) === JSON.stringify([{ type: 'halt', step: 1, message: reason, notRun: [2] }]),
      JSON.stringify(r),
    );
    check('a failed revalidation never emits execute', !r.effects.some((e) => e.type === 'execute'));
  }
  expectStep('running(0, executing) + STEP_OK revalidates step 1 (does not execute it yet)', at(0, 'executing'), { type: 'STEP_OK' }, 'running', [
    { type: 'revalidate', step: 1 },
  ]);
  expectStep('running(last, executing) + STEP_OK is done with the summary', at(2, 'executing'), { type: 'STEP_OK' }, 'done', [
    { type: 'summary', text: 'Done: 3 steps.' },
  ]);
  expectStep('running(1, executing) + STEP_ERR halts', at(1, 'executing'), { type: 'STEP_ERR', message: 'Storage full.' }, 'halted', [
    { type: 'halt', step: 1, message: 'Storage full.', notRun: [2] },
  ]);
  expectStep('halted(1) + RETRY rechecks step 1 and does not run it yet', halted1, { type: 'RETRY' }, 'running', [
    { type: 'recheck', step: 1 },
  ]);
  expectStep('rechecking(1) + STEP_STATE not done revalidates step 1', at(1, 'rechecking'), { type: 'STEP_STATE', alreadyDone: false }, 'running', [
    { type: 'revalidate', step: 1 },
  ]);
  expectStep('rechecking(1) + STEP_STATE already done moves on to revalidate step 2 (no re-run)', at(1, 'rechecking'), { type: 'STEP_STATE', alreadyDone: true }, 'running', [
    { type: 'revalidate', step: 2 },
  ]);
  expectStep('rechecking(last) + STEP_STATE already done finishes the plan', at(2, 'rechecking'), { type: 'STEP_STATE', alreadyDone: true }, 'done', [
    { type: 'summary', text: 'Done: 3 steps.' },
  ]);
  expectStep('proposed + DISMISS dismisses', proposed3, { type: 'DISMISS' }, 'dismissed', []);
  expectStep('halted + DISMISS dismisses', halted1, { type: 'DISMISS' }, 'dismissed', []);
  expectStep('proposed + EXPIRE expires', proposed3, { type: 'EXPIRE' }, 'expired', []);
  expectStep('halted + EXPIRE expires', halted1, { type: 'EXPIRE' }, 'expired', []);

  // A short or long checks array is rejected: a step would run unchecked.
  expectStep('CONFIRM with a short checks array is rejected (adversarial)', proposed3, { type: 'CONFIRM', checks: [ok3] }, 'proposed', []);
  expectStep('CONFIRM with an empty checks array is rejected', proposed3, { type: 'CONFIRM', checks: [] }, 'proposed', []);
  expectStep('CONFIRM with extra checks is rejected', proposed3, { type: 'CONFIRM', checks: [ok3, ok3, ok3, ok3] }, 'proposed', []);
  expectStep('CONFIRM with checks that are not an array is rejected', proposed3, { type: 'CONFIRM' }, 'proposed', []);

  // Events for the wrong phase are no-ops.
  expectStep('STEP_OK while revalidating is a no-op (the revalidation cannot be skipped)', at(0, 'revalidating'), { type: 'STEP_OK' }, 'running', []);
  expectStep('STEP_REVALIDATED while executing is a no-op', at(0, 'executing'), { type: 'STEP_REVALIDATED', ok: true }, 'running', []);
  expectStep('STEP_ERR while revalidating is a no-op', at(0, 'revalidating'), { type: 'STEP_ERR', message: 'x' }, 'running', []);
  expectStep('STEP_STATE while executing is a no-op', at(0, 'executing'), { type: 'STEP_STATE', alreadyDone: true }, 'running', []);
  expectStep('STEP_OK while rechecking is a no-op', at(1, 'rechecking'), { type: 'STEP_OK' }, 'running', []);
  expectStep('STEP_REVALIDATED on a proposed plan is a no-op', proposed3, { type: 'STEP_REVALIDATED', ok: true }, 'proposed', []);

  // Anything not in the table is a no-op.
  expectStep('running + CONFIRM is unchanged', at(0, 'executing'), { type: 'CONFIRM', checks: [ok3, ok3, ok3] }, 'running', []);
  expectStep('running + DISMISS is unchanged', at(0, 'executing'), { type: 'DISMISS' }, 'running', []);
  expectStep('running + EXPIRE is unchanged', at(0, 'executing'), { type: 'EXPIRE' }, 'running', []);
  expectStep('running + RETRY is unchanged', at(0, 'executing'), { type: 'RETRY' }, 'running', []);
  for (const kind of ['done', 'dismissed', 'expired']) {
    const state = { kind, total: 3 };
    expectStep(`${kind} + STEP_OK is unchanged`, state, { type: 'STEP_OK' }, kind, []);
    expectStep(`${kind} + RETRY is unchanged`, state, { type: 'RETRY' }, kind, []);
    expectStep(`${kind} + STEP_REVALIDATED is unchanged`, state, { type: 'STEP_REVALIDATED', ok: true }, kind, []);
  }

  // Extra tests from the spec.
  // A failure in step 2 of 3 halts, and step 3 is "Not run" (index 1, notRun lists step index 2).
  let st = m.planStep(proposed3, { type: 'CONFIRM', checks: [ok3, ok3, ok3] }).state;
  st = m.planStep(st, { type: 'STEP_REVALIDATED', ok: true }).state;
  st = m.planStep(st, { type: 'STEP_OK' }).state;
  st = m.planStep(st, { type: 'STEP_REVALIDATED', ok: true }).state;
  const failStep2 = m.planStep(st, { type: 'STEP_ERR', message: 'Gone.' });
  check('failure in step 2 of 3 halts at step 2', failStep2.state.kind === 'halted' && failStep2.state.index === 1, JSON.stringify(failStep2.state));
  check('failure in step 2 of 3 lists step 3 as not run', JSON.stringify(failStep2.effects[0].notRun) === '[2]', JSON.stringify(failStep2.effects));
  check('finished steps are not rolled back (no effect undoes them)', failStep2.effects.every((e) => e.type === 'halt'), JSON.stringify(failStep2.effects));

  // Full happy path: every execute is preceded by an ok revalidation of the same step.
  {
    const log = [];
    let cur = proposed3;
    const feed = (ev) => {
      const r = m.planStep(cur, ev);
      log.push(...r.effects.map((e) => `${e.type}${e.step ?? ''}`));
      cur = r.state;
    };
    feed({ type: 'CONFIRM', checks: [ok3, ok3, ok3] });
    for (let i = 0; i < 3; i++) {
      feed({ type: 'STEP_REVALIDATED', ok: true });
      feed({ type: 'STEP_OK' });
    }
    check('happy path order is revalidate, execute per step, then the summary', log.join() === 'revalidate0,execute0,revalidate1,execute1,revalidate2,execute2,summary' && cur.kind === 'done', log.join());
  }
  // Retry after a halt where step 1 already ran: it is skipped, not run twice.
  {
    let r = m.planStep(halted1, { type: 'RETRY' });
    r = m.planStep(r.state, { type: 'STEP_STATE', alreadyDone: true });
    check('retry of an already-done step never emits execute for it', !r.effects.some((e) => e.type === 'execute') && r.state.index === 2);
  }

  // Max 6 steps enforced.
  check('6 steps are allowed', m.planSizeOk(6) === true);
  check('7 steps are refused', m.planSizeOk(7) === false);
  check('0 steps are refused', m.planSizeOk(0) === false);
  const seven = { kind: 'proposed', total: 7 };
  const oks = Array.from({ length: 7 }, () => ok3);
  expectStep('7-step plan is never confirmed', seven, { type: 'CONFIRM', checks: oks }, 'proposed', []);

  check('MAX_PLAN_STEPS is 6', m.MAX_PLAN_STEPS === 6);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
