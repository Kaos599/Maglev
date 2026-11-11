#!/usr/bin/env node
// SM-39 Plan card machine. One assertion per row of the transition table, on {state.kind, effects}.
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
  const running0 = { kind: 'running', total: 3, index: 0 };
  const running2 = { kind: 'running', total: 3, index: 2 };
  const halted1 = { kind: 'halted', total: 3, index: 1, reason: 'Storage full.' };

  // Rows of the SM-39 table, in order.
  expectStep('proposed + CONFIRM (all steps valid) runs step 0', proposed3, { type: 'CONFIRM', checks: [ok3, ok3, ok3] }, 'running', [
    { type: 'execute', step: 0 },
  ]);
  expectStep('proposed + CONFIRM (a step invalid) marks it and stays proposed', proposed3, { type: 'CONFIRM', checks: [ok3, { ok: false, reason: 'Gone' }, ok3] }, 'proposed', [
    { type: 'markInvalid', step: 1, reason: 'Gone' },
  ]);
  expectStep('running(0) + STEP_OK runs step 1 after revalidating it', running0, { type: 'STEP_OK' }, 'running', [
    { type: 'revalidate', step: 1 },
    { type: 'execute', step: 1 },
  ]);
  expectStep('running(last) + STEP_OK is done with the summary', running2, { type: 'STEP_OK' }, 'done', [
    { type: 'summary', text: 'Done: 3 steps.' },
  ]);
  expectStep('running(1) + STEP_ERR halts', { kind: 'running', total: 3, index: 1 }, { type: 'STEP_ERR', message: 'Storage full.' }, 'halted', [
    { type: 'halt', step: 1, message: 'Storage full.', notRun: [2] },
  ]);
  expectStep('halted(1) + RETRY re-runs from the failed step', halted1, { type: 'RETRY' }, 'running', [
    { type: 'revalidate', step: 1 },
    { type: 'execute', step: 1 },
  ]);
  expectStep('proposed + DISMISS dismisses', proposed3, { type: 'DISMISS' }, 'dismissed', []);
  expectStep('halted + DISMISS dismisses', halted1, { type: 'DISMISS' }, 'dismissed', []);
  expectStep('proposed + EXPIRE expires', proposed3, { type: 'EXPIRE' }, 'expired', []);
  expectStep('halted + EXPIRE expires', halted1, { type: 'EXPIRE' }, 'expired', []);

  // Anything not in the table is a no-op.
  expectStep('running + CONFIRM is unchanged', running0, { type: 'CONFIRM', checks: [ok3, ok3, ok3] }, 'running', []);
  expectStep('running + DISMISS is unchanged', running0, { type: 'DISMISS' }, 'running', []);
  expectStep('running + EXPIRE is unchanged', running0, { type: 'EXPIRE' }, 'running', []);
  for (const kind of ['done', 'dismissed', 'expired']) {
    const state = { kind, total: 3 };
    expectStep(`${kind} + STEP_OK is unchanged`, state, { type: 'STEP_OK' }, kind, []);
    expectStep(`${kind} + RETRY is unchanged`, state, { type: 'RETRY' }, kind, []);
  }

  // Extra tests from the spec.
  // A failure in step 2 of 3 halts, and step 3 is "Not run" (index 2, notRun lists it).
  const s1 = m.planStep(running0, { type: 'STEP_OK' }).state;
  const failStep2 = m.planStep(s1, { type: 'STEP_ERR', message: 'Gone.' });
  check('failure in step 2 of 3 halts at step 2', failStep2.state.kind === 'halted' && failStep2.state.index === 1, JSON.stringify(failStep2.state));
  check('failure in step 2 of 3 lists step 3 as not run', JSON.stringify(failStep2.effects[0].notRun) === '[2]', JSON.stringify(failStep2.effects));
  check('finished steps are not rolled back (no effect undoes them)', failStep2.effects.every((e) => e.type === 'halt'), JSON.stringify(failStep2.effects));

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
