#!/usr/bin/env node
// SM-40: a probe that finishes after Remove key must not save the key again. Pure helper test.
process.removeAllListeners('warning');
let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`); }
}
async function main() {
  const { probeMayStore } = await import('../utils/assistant/providerSave.ts');
  const { reduceProvider } = await import('../utils/assistant/providerMachine.ts');
  check('a live probe in testing may store', probeMayStore({ aborted: false, state: { kind: 'testing' } }) === true);
  check('an aborted probe never stores', probeMayStore({ aborted: true, state: { kind: 'testing' } }) === false);
  for (const kind of ['noKey', 'editing', 'ready', 'invalid', 'awaitingCode', 'exchanging']) {
    check(`a probe that finishes in ${kind} never stores`, probeMayStore({ aborted: false, state: { kind } }) === false);
  }
  // The real sequence: Save, then Remove key while testing. The machine leaves testing, so even without the abort flag nothing is stored.
  const start = reduceProvider({ kind: 'editing' }, { type: 'SAVE', preset: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt', key: 'sk-x' });
  check('setup: Save moves to testing', start.state.kind === 'testing', start.state.kind);
  const removed = reduceProvider(start.state, { type: 'REMOVE_KEY' });
  check('Remove key leaves testing', removed.state.kind === 'noKey' && removed.effects.some((e) => e.type === 'removeKey'));
  check('the late PROBE_OK is a no-op in the machine and the gate says do not store', reduceProvider(removed.state, { type: 'PROBE_OK', toolCallsWork: true }).effects.length === 0 && !probeMayStore({ aborted: true, state: removed.state }));
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
