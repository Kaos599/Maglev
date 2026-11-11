#!/usr/bin/env node
// SM-42 Chat session machine. One assertion per row of the transition table, on {state.kind, effects}.
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
  const m = await import('../utils/assistant/session.ts');
  // Compare only {kind, effects}, as the spec's tests require.
  const snap = (state, event) => {
    const r = m.sessionStep(state, event);
    return JSON.stringify({ kind: r.state.kind, effects: r.effects });
  };
  const expectStep = (name, state, event, kind, effects) => {
    const got = snap(state, event);
    check(name, got === JSON.stringify({ kind, effects }), got);
  };
  const clearEffects = [{ type: 'expireAllCards' }, { type: 'dropHistory' }];

  // Rows of the SM-42 table, in order.
  expectStep('empty + SEND sends and becomes active', m.SESSION_INITIAL, { type: 'SEND', text: 'hi' }, 'active', [
    { type: 'send', text: 'hi' },
  ]);
  expectStep('active + APP_BACKGROUND aborts and becomes backgrounded', { kind: 'active' }, { type: 'APP_BACKGROUND' }, 'backgrounded', [
    { type: 'abort' },
  ]);
  expectStep('backgrounded + APP_FOREGROUND becomes active', { kind: 'backgrounded' }, { type: 'APP_FOREGROUND' }, 'active', []);
  expectStep('active + CLEAR expires cards and drops history, ends empty', { kind: 'active' }, { type: 'CLEAR' }, 'empty', clearEffects);
  expectStep('empty + KEY_REMOVED ends empty like CLEAR', { kind: 'empty' }, { type: 'KEY_REMOVED' }, 'empty', clearEffects);
  expectStep('active + KEY_REMOVED ends empty like CLEAR', { kind: 'active' }, { type: 'KEY_REMOVED' }, 'empty', clearEffects);
  expectStep('backgrounded + KEY_REMOVED ends empty like CLEAR', { kind: 'backgrounded' }, { type: 'KEY_REMOVED' }, 'empty', clearEffects);

  // Anything not in the table is a no-op.
  expectStep('active + SEND is unchanged', { kind: 'active' }, { type: 'SEND', text: 'x' }, 'active', []);
  expectStep('backgrounded + SEND is unchanged', { kind: 'backgrounded' }, { type: 'SEND', text: 'x' }, 'backgrounded', []);
  expectStep('empty + CLEAR is unchanged', { kind: 'empty' }, { type: 'CLEAR' }, 'empty', []);
  expectStep('backgrounded + CLEAR is unchanged', { kind: 'backgrounded' }, { type: 'CLEAR' }, 'backgrounded', []);
  expectStep('empty + APP_FOREGROUND is unchanged', { kind: 'empty' }, { type: 'APP_FOREGROUND' }, 'empty', []);
  expectStep('active + APP_FOREGROUND is unchanged', { kind: 'active' }, { type: 'APP_FOREGROUND' }, 'active', []);
  expectStep('empty + APP_BACKGROUND is unchanged', { kind: 'empty' }, { type: 'APP_BACKGROUND' }, 'empty', []);

  check('caption under the input is exact', m.SESSION_NOT_SAVED_CAPTION === "Chats aren't saved.");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
