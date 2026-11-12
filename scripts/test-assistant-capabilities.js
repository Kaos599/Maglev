#!/usr/bin/env node
// "What the Assistant can do" copy helpers (pure TS, no network). Needs Node 22.18+.
process.removeAllListeners('warning');
let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}${extra !== undefined ? ` (${JSON.stringify(extra)})` : ''}`);
  }
}

async function main() {
  const v = await import('../utils/assistant/chatView.ts');
  console.log('capabilities: copy');
  check('title', v.CAPABILITIES_TITLE === 'What the Assistant can do');
  check('6 can, 4 cannot', v.CAN_DO.length === 6 && v.CANT_DO.length === 4);
  check('no hashes or jargon words', ![...v.CAN_DO, ...v.CANT_DO].some((t) => /infohash|pipeline|JSON/i.test(t)));

  console.log('capabilities: facts');
  const a = v.capabilitiesFacts({ modelName: 'Llama 3.3 70B (free)', providerName: 'Groq' });
  check('model line', a[0] === 'Model: Llama 3.3 70B (free) on Groq.', a[0]);
  check('7 lines', a.length === 7);
  check('no model name falls back to Auto', v.capabilitiesFacts({ providerName: 'OpenRouter' })[0] === 'Model: Auto (any free model) on OpenRouter.');
  check('blank model name falls back', v.capabilitiesFacts({ modelName: '  ', providerName: 'OpenRouter' })[0].startsWith('Model: Auto'));
  check('other providers say default model, not Auto', v.capabilitiesFacts({ providerName: 'Groq' })[0] === "Model: the provider's default model on Groq.");
  check('context only when known', v.capabilitiesFacts({ providerName: 'X', contextLabel: '128K' })[0].endsWith('Context 128K.') && !a[0].includes('Context'));
  check('limits line', a[1] === 'Each message can use up to 6 model requests, 8 tool calls and 2 cards, only 1 of which can delete.');

  console.log('capabilities: auto open');
  check('opens when ready and unseen', v.shouldAutoOpenCapabilities('ready', null) === true);
  check('not when seen', v.shouldAutoOpenCapabilities('ready', 5) === false);
  check('not when gated', v.shouldAutoOpenCapabilities('noKey', null) === false);

  if (failed) {
    console.error(`${failed} failed`);
    process.exit(1);
  }
  console.log('all passed');
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
