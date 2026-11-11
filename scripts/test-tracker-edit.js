#!/usr/bin/env node
// SM-28 Tracker edit machine (NATIVE_CONTRACT 15). Parse cases, then one assertion per row of the transition table.
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
  const m = await import('../components/detail/trackerEditMachine.ts');
  const parse = (text, existing = []) => m.parseTrackerLines(text, existing);
  const init = m.TRACKER_EDIT_INITIAL;
  const adding = (over = {}) => ({ ...init, kind: 'adding', ...over });
  const withText = (text, existing = []) => m.trackerEditStep(adding({ existing: existing.map((e) => e.toLowerCase()) }), { type: 'TEXT', value: text }).state;
  const snapStep = (state, event) => {
    const r = m.trackerEditStep(state, event);
    return JSON.stringify({ kind: r.state.kind, effects: r.effects });
  };
  const expectStep = (name, state, event, kind, effects) =>
    check(name, snapStep(state, event) === JSON.stringify({ kind, effects }), snapStep(state, event));

  // parseTrackerLines
  check('parse accepts http', parse('http://t.example.com/announce').valid.join() === 'http://t.example.com/announce');
  check('parse accepts https', parse('https://t.example.com/announce').valid.join() === 'https://t.example.com/announce');
  check('parse accepts udp with port', parse('udp://tracker.opentrackr.org:1337/announce').valid.join() === 'udp://tracker.opentrackr.org:1337/announce');
  check('parse rejects magnet links', parse('magnet:?xt=urn:btih:abc').invalid.join() === 'magnet:?xt=urn:btih:abc');
  check('parse rejects ftp', parse('ftp://t.example.com/a').invalid.join() === 'ftp://t.example.com/a');
  check('parse ignores blank lines', parse('\n  \nhttp://a.example.com/x\n\n').valid.length === 1 && parse('\n  \n').invalid.length === 0);
  check('parse flags duplicate against existing', parse('http://A.example.com/x', ['http://a.example.com/x']).duplicates.join() === 'http://A.example.com/x');
  check('parse flags duplicate within input', parse('http://a.example.com/x\nhttp://A.example.com/X').duplicates.join() === 'http://A.example.com/X');

  // idle
  expectStep('idle + OPEN_ADD opens the add sheet', init, { type: 'OPEN_ADD' }, 'adding', [{ type: 'openSheet' }]);
  expectStep('idle + ASK_REMOVE opens the confirm', init, { type: 'ASK_REMOVE', url: 'http://a.example.com/x' }, 'confirmRemove', [{ type: 'openSheet' }]);

  // adding
  expectStep('adding + TEXT stays adding', adding(), { type: 'TEXT', value: 'http://a.example.com/x' }, 'adding', []);
  expectStep('adding + SUBMIT with nothing valid asks for an address', adding(), { type: 'SUBMIT' }, 'adding', [
    { type: 'show', message: 'Paste at least one tracker address.' },
  ]);
  expectStep('adding + SUBMIT with an invalid line names it', withText('ftp://t.example.com/a'), { type: 'SUBMIT' }, 'adding', [
    { type: 'show', message: 'Not a tracker address: ftp://t.example.com/a' },
  ]);
  expectStep('adding + SUBMIT with valid and invalid lines blocks', withText('http://a.example.com/x\nnope'), { type: 'SUBMIT' }, 'adding', [
    { type: 'show', message: 'Not a tracker address: nope' },
  ]);
  expectStep('adding + SUBMIT with valid lines saves', withText('http://a.example.com/x'), { type: 'SUBMIT' }, 'saving', [
    { type: 'call', fn: 'addTrackers', urls: ['http://a.example.com/x'] },
  ]);
  expectStep('adding + CANCEL closes to idle', adding(), { type: 'CANCEL' }, 'idle', [{ type: 'closeSheet' }]);

  // saving
  const saving = withText('http://a.example.com/x\nhttp://b.example.com/y');
  expectStep('saving + OK notices the count', { ...saving, kind: 'saving' }, { type: 'OK' }, 'idle', [
    { type: 'closeSheet' },
    { type: 'notice', text: 'Added 2 trackers.', tone: 'info' },
  ]);
  expectStep('saving + OK notes skipped duplicates', { ...withText('http://a.example.com/x\nhttp://a.example.com/x'), kind: 'saving' }, { type: 'OK', addedCount: 1 }, 'idle', [
    { type: 'closeSheet' },
    { type: 'notice', text: 'Added 1 tracker. Skipped 1 already in the list.', tone: 'info' },
  ]);
  expectStep('saving + ERR returns to adding with the message', { ...withText('http://a.example.com/x'), kind: 'saving' }, { type: 'ERR', message: 'Engine says no' }, 'adding', [
    { type: 'show', message: 'Engine says no' },
  ]);

  // confirmRemove and removing
  const confirm = { ...init, kind: 'confirmRemove', url: 'http://a.example.com/x' };
  expectStep('confirmRemove + CANCEL closes to idle', confirm, { type: 'CANCEL' }, 'idle', [{ type: 'closeSheet' }]);
  expectStep('confirmRemove + CONFIRM_REMOVE calls removeTracker', confirm, { type: 'CONFIRM_REMOVE' }, 'removing', [
    { type: 'call', fn: 'removeTracker', url: 'http://a.example.com/x' },
  ]);
  const removing = { ...confirm, kind: 'removing' };
  expectStep('removing + OK notices removal', removing, { type: 'OK' }, 'idle', [
    { type: 'closeSheet' },
    { type: 'notice', text: 'Tracker removed.', tone: 'info' },
  ]);
  expectStep('removing + ERR shows the danger notice', removing, { type: 'ERR', message: 'Nope' }, 'idle', [
    { type: 'closeSheet' },
    { type: 'notice', text: 'Nope', tone: 'danger' },
  ]);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
