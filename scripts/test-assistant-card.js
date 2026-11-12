#!/usr/bin/env node
// SM-38 Proposal card machine. One assertion per row of the transition table, on {state.kind, effects}.
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
  const m = await import('../utils/assistant/cardMachine.ts');
  const id = 'c1';
  const at = (kind, extra = {}) => ({ kind, cardId: id, ...extra });
  // Compare only {kind, effects}, as the spec's tests require.
  const snap = (state, event) => {
    const r = m.cardStep(state, event);
    return JSON.stringify({ kind: r.state.kind, effects: r.effects });
  };
  const expectStep = (name, state, event, kind, effects) => {
    const got = snap(state, event);
    check(name, got === JSON.stringify({ kind, effects }), got);
  };

  // Rows of the SM-38 table, in order.
  expectStep('proposed + CONFIRM revalidates the card', at('proposed'), { type: 'CONFIRM' }, 'confirming', [
    { type: 'revalidate', cardId: id },
  ]);
  expectStep('confirming + REVALIDATED ok executes the card', at('confirming'), { type: 'REVALIDATED', ok: true }, 'executing', [
    { type: 'execute', cardId: id },
  ]);
  expectStep('confirming + REVALIDATED not ok returns to proposed', at('confirming'), { type: 'REVALIDATED', ok: false, reason: 'x' }, 'proposed', []);
  expectStep('executing + EXEC_OK is done and appends the tool note', at('executing'), { type: 'EXEC_OK', summary: 'Added.' }, 'done', [
    { type: 'appendToolNote', cardId: id, payload: { executed: true } },
  ]);
  expectStep('executing + EXEC_ERR fails', at('executing'), { type: 'EXEC_ERR', code: 'DISK_FULL', message: 'Storage full.' }, 'failed', []);
  expectStep('failed + RETRY revalidates again', at('failed'), { type: 'RETRY' }, 'confirming', [{ type: 'revalidate', cardId: id }]);
  expectStep('proposed + DISMISS dismisses', at('proposed'), { type: 'DISMISS' }, 'dismissed', []);
  expectStep('failed + DISMISS dismisses', at('failed'), { type: 'DISMISS' }, 'dismissed', []);
  expectStep('proposed + EXPIRE expires', at('proposed'), { type: 'EXPIRE' }, 'expired', []);
  expectStep('failed + EXPIRE expires', at('failed'), { type: 'EXPIRE' }, 'expired', []);
  expectStep('confirming + EXPIRE is unchanged', at('confirming'), { type: 'EXPIRE' }, 'confirming', []);
  expectStep('executing + EXPIRE is unchanged', at('executing'), { type: 'EXPIRE' }, 'executing', []);
  for (const kind of ['done', 'dismissed', 'expired']) {
    for (const event of [
      { type: 'CONFIRM' },
      { type: 'DISMISS' },
      { type: 'REVALIDATED', ok: true },
      { type: 'EXEC_OK', summary: 's' },
      { type: 'EXEC_ERR', code: 'INTERNAL', message: 'm' },
      { type: 'EXPIRE' },
      { type: 'RETRY' },
    ]) {
      expectStep(`${kind} + ${event.type} is unchanged`, at(kind), event, kind, []);
    }
  }

  // Extra tests from the spec.
  // A card for a removed torrent expires (the caller sends EXPIRE when the torrent is gone).
  const gone = m.cardStep(at('proposed'), { type: 'EXPIRE' }).state;
  check('card for a removed torrent expires and shows the fixed caption', gone.kind === 'expired' && gone.caption === 'Expired. Ask again for a fresh plan.', JSON.stringify(gone));

  // Admission failure keeps the card proposed with the reason.
  const refused = m.cardStep(at('confirming'), { type: 'REVALIDATED', ok: false, reason: 'needs 4.1 GB, 2.2 GB free' }).state;
  check('admission failure keeps the card proposed with the reason', refused.kind === 'proposed' && refused.reason === 'needs 4.1 GB, 2.2 GB free', JSON.stringify(refused));

  // EXEC_OK keeps the summary, EXEC_ERR keeps the message.
  const ok = m.cardStep(at('executing'), { type: 'EXEC_OK', summary: 'Freed 1.9 GB.' }).state;
  check('done card carries the summary', ok.summary === 'Freed 1.9 GB.', JSON.stringify(ok));
  const err = m.cardStep(at('executing'), { type: 'EXEC_ERR', code: 'x', message: 'Storage full.' }).state;
  check('failed card carries the message', err.error === 'Storage full.', JSON.stringify(err));

  // A card stays confirmable after a failed revalidation (R1-3): the turn machine keeps it pending and the
  // card shows a live Confirm button, so CONFIRM must work again.
  {
    let st = m.cardStep(at('proposed'), { type: 'CONFIRM' }).state;
    st = m.cardStep(st, { type: 'REVALIDATED', ok: false, reason: 'Gone' }).state;
    const again = m.cardStep(st, { type: 'CONFIRM' });
    check('a card stays confirmable after a failed revalidation (adversarial)', st.kind === 'proposed' && again.state.kind === 'confirming' && again.effects[0].type === 'revalidate', JSON.stringify(again));
    const dismissed = m.cardStep(st, { type: 'DISMISS' }).state;
    check('a card with a failed revalidation can still be dismissed', dismissed.kind === 'dismissed');
  }
  {
    const r = m.cardStep(at('proposed'), { type: 'EXPIRE', caption: 'A newer card replaced this one.' });
    check('EXPIRE with a caption keeps it', r.state.kind === 'expired' && r.state.caption === 'A newer card replaced this one.', r.state);
    const f = m.cardStep(at('failed', { error: 'x' }), { type: 'EXPIRE', caption: 'A newer card replaced this one.' });
    check('failed + EXPIRE with a caption expires with it', f.state.kind === 'expired' && f.state.caption === 'A newer card replaced this one.', f.state);
    check('EXPIRE without a caption uses the default', m.cardStep(at('proposed'), { type: 'EXPIRE' }).state.caption === m.CARD_EXPIRED_CAPTION);
  }
  // cardSettledKind tells the runner what to report to the turn machine.
  for (const [kind, want] of [['proposed', null], ['confirming', null], ['executing', null], ['done', 'done'], ['dismissed', 'dismissed'], ['expired', 'expired'], ['failed', 'failed']]) {
    check(`cardSettledKind(${kind}) is ${want}`, m.cardSettledKind(at(kind)) === want);
  }

  // The card text keeps a stranger's name apart from the facts Maglev computed (source check; no RN renderer in Node).
  const src = (await import('node:fs')).readFileSync(new URL('../components/assistant/ProposalCard.tsx', import.meta.url), 'utf8');
  check('card shows sourceName under the label "Name from the source"', /view\.sourceName/.test(src) && src.includes('Name from the source'));
  check('card footer separates checked facts from the source name', src.includes('Sizes and space are checked by Maglev. The name comes from the source.') && !src.includes('Facts above come from Maglev.'));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
