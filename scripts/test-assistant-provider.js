#!/usr/bin/env node
// SM-40 Provider setup: every table row, the copy strings, and no-op behaviour for events outside the table.
// Needs Node 22.18+ (runs the TypeScript source directly via type stripping).

process.removeAllListeners('warning');

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}

const VALID_SAVE = { type: 'SAVE', preset: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-nano', key: 'sk-1' };

const S = {
  noKey: { kind: 'noKey' },
  editing: { kind: 'editing' },
  testing: { kind: 'testing' },
  ready: { kind: 'ready' },
  invalid: (reason) => ({ kind: 'invalid', reason }),
  awaitingCode: { kind: 'awaitingCode' },
  exchanging: { kind: 'exchanging' },
};

const effectTypes = (effects) => effects.map((e) => e.type).join(',');
const effectsJson = (effects) => JSON.stringify(effects);

async function main() {
  const { reduceProvider, COPY, validateSave, INITIAL_PROVIDER_STATE } = await import('../utils/assistant/providerMachine.ts');

  // ---- Copy strings exactly as written in SM-40 ----
  console.log('copy');
  check('Paste a key', COPY.pasteKey === 'Paste a key');
  check('That address must start with https://', COPY.httpsOnly === 'That address must start with https://');
  check('Pick a model', COPY.pickModel === 'Pick a model');
  check("This model can't use tools. Pick another.", COPY.cantUseTools === "This model can't use tools. Pick another.");
  check('Check your key.', COPY.checkKey === 'Check your key.');
  check('Out of credits.', COPY.outOfCredits === 'Out of credits.');
  check("Couldn't reach the provider. Try again.", COPY.cantReach === "Couldn't reach the provider. Try again.");
  check("Sign-in didn't finish. Try again.", COPY.signInFailed === "Sign-in didn't finish. Try again.");
  check('local caption', COPY.localCaption === 'Runs on your network. Nothing leaves it.');
  check('initial state is noKey', INITIAL_PROVIDER_STATE.kind === 'noKey');

  // ---- Field validation for SAVE ----
  console.log('save validation');
  check('empty key -> Paste a key', validateSave({ baseUrl: 'https://a.example/v1', model: 'm', key: '  ' }) === 'Paste a key');
  check('public http -> https message', validateSave({ baseUrl: 'http://a.example/v1', model: 'm', key: 'k' }) === COPY.httpsOnly);
  check('LAN http is valid', validateSave({ baseUrl: 'http://192.168.1.4:11434/v1', model: 'm', key: 'k' }) === null);
  check('empty model -> Pick a model', validateSave({ baseUrl: 'https://a.example/v1', model: '', key: 'k' }) === 'Pick a model');
  check('key error wins over the others', validateSave({ baseUrl: 'bad', model: '', key: '' }) === 'Paste a key');
  check('base URL error wins over model', validateSave({ baseUrl: 'bad', model: '', key: 'k' }) === COPY.httpsOnly);

  // ---- Table rows ----
  console.log('table rows');
  const rows = [
    // [from, event, expectedState JSON, expected effect types]
    ['noKey EDIT -> editing', S.noKey, { type: 'EDIT' }, S.editing, ''],
    ['ready EDIT -> editing', S.ready, { type: 'EDIT' }, S.editing, ''],
    ['invalid EDIT -> editing', S.invalid('x'), { type: 'EDIT' }, S.editing, ''],
    ['editing SAVE valid -> testing', S.editing, VALID_SAVE, S.testing, 'storeKey,probe'],
    ['editing SAVE empty key -> editing', S.editing, { ...VALID_SAVE, key: '' }, S.editing, 'showError'],
    ['editing SAVE bad URL -> editing', S.editing, { ...VALID_SAVE, baseUrl: 'http://example.com/v1' }, S.editing, 'showError'],
    ['editing SAVE empty model -> editing', S.editing, { ...VALID_SAVE, model: ' ' }, S.editing, 'showError'],
    ['testing PROBE_OK tools work -> ready', S.testing, { type: 'PROBE_OK', toolCallsWork: true }, S.ready, ''],
    ['testing PROBE_OK no tools -> invalid', S.testing, { type: 'PROBE_OK', toolCallsWork: false }, S.invalid(COPY.cantUseTools), ''],
    ['testing PROBE_ERR 401 -> invalid', S.testing, { type: 'PROBE_ERR', status: 401 }, S.invalid(COPY.checkKey), ''],
    ['testing PROBE_ERR 403 -> invalid', S.testing, { type: 'PROBE_ERR', status: 403 }, S.invalid(COPY.checkKey), ''],
    ['testing PROBE_ERR 402 -> invalid', S.testing, { type: 'PROBE_ERR', status: 402 }, S.invalid(COPY.outOfCredits), ''],
    ['testing PROBE_ERR net -> invalid', S.testing, { type: 'PROBE_ERR', status: 'net' }, S.invalid(COPY.cantReach), ''],
    ['testing PROBE_ERR timeout -> invalid', S.testing, { type: 'PROBE_ERR', status: 'timeout' }, S.invalid(COPY.cantReach), ''],
    ['testing PROBE_ERR 500 -> invalid', S.testing, { type: 'PROBE_ERR', status: 500 }, S.invalid(COPY.cantReach), ''],
    ['testing PROBE_ERR 503 -> invalid', S.testing, { type: 'PROBE_ERR', status: 503 }, S.invalid(COPY.cantReach), ''],
    ['noKey SIGN_IN_OPENROUTER -> awaitingCode', S.noKey, { type: 'SIGN_IN_OPENROUTER' }, S.awaitingCode, 'openAuth'],
    ['awaitingCode CODE -> exchanging', S.awaitingCode, { type: 'CODE', pasted: 'abc' }, S.exchanging, 'exchangeCode'],
    ['exchanging KEY -> testing', S.exchanging, { type: 'KEY', key: 'sk-or-1' }, S.testing, 'storeKey,probe'],
    ['exchanging ERR -> invalid', S.exchanging, { type: 'ERR' }, S.invalid(COPY.signInFailed), ''],
  ];
  for (const [name, from, event, to, fx] of rows) {
    const r = reduceProvider(from, event);
    check(name, JSON.stringify(r.state) === JSON.stringify(to), JSON.stringify(r.state));
    check(`${name} effects`, effectTypes(r.effects) === fx, effectTypes(r.effects));
  }

  // REMOVE_KEY is "any" state.
  for (const from of [S.noKey, S.editing, S.testing, S.ready, S.invalid('x'), S.awaitingCode, S.exchanging]) {
    const r = reduceProvider(from, { type: 'REMOVE_KEY' });
    check(`any -> REMOVE_KEY from ${from.kind} -> noKey`, JSON.stringify(r.state) === JSON.stringify(S.noKey));
    check(`REMOVE_KEY from ${from.kind} removes key and expires cards`, effectTypes(r.effects) === 'removeKey,expireCards');
  }

  // ---- Effect payloads ----
  console.log('effect payloads');
  {
    const r = reduceProvider(S.editing, { ...VALID_SAVE, key: '  sk-trim  ' });
    check('SAVE storeKey carries the trimmed key', effectsJson(r.effects) === JSON.stringify([{ type: 'storeKey', key: 'sk-trim' }, { type: 'probe' }]), effectsJson(r.effects));
    const e = reduceProvider(S.editing, { ...VALID_SAVE, key: '' });
    check('field error carries the exact message', effectsJson(e.effects) === JSON.stringify([{ type: 'showError', message: 'Paste a key' }]));
    const c = reduceProvider(S.awaitingCode, { type: 'CODE', pasted: '  code-9  ' });
    check('CODE passes the trimmed code', effectsJson(c.effects) === JSON.stringify([{ type: 'exchangeCode', code: 'code-9' }]));
  }

  // ---- PROBE_ERR never leaves the screen stuck in testing ----
  for (const [status, reason] of [[404, COPY.modelNotFound], [429, COPY.rateLimited], [400, COPY.rejected], [418, COPY.rejected]]) {
    const r = reduceProvider(S.testing, { type: 'PROBE_ERR', status });
    check(`PROBE_ERR ${status} -> invalid`, r.state.kind === 'invalid' && r.state.reason === reason, JSON.stringify(r));
  }

  // ---- Events outside the table are no-ops ----
  console.log('no-ops');
  const noops = [
    ['SAVE from noKey', S.noKey, VALID_SAVE],
    ['SAVE from ready', S.ready, VALID_SAVE],
    ['SAVE from testing', S.testing, VALID_SAVE],
    ['EDIT from testing', S.testing, { type: 'EDIT' }],
    ['EDIT from editing', S.editing, { type: 'EDIT' }],
    ['EDIT from exchanging', S.exchanging, { type: 'EDIT' }],
    ['EDIT from awaitingCode', S.awaitingCode, { type: 'EDIT' }],
    ['PROBE_OK from editing', S.editing, { type: 'PROBE_OK', toolCallsWork: true }],
    ['PROBE_OK from ready', S.ready, { type: 'PROBE_OK', toolCallsWork: true }],
    ['PROBE_ERR 401 from editing', S.editing, { type: 'PROBE_ERR', status: 401 }],
    ['SIGN_IN_OPENROUTER from ready', S.ready, { type: 'SIGN_IN_OPENROUTER' }],
    ['SIGN_IN_OPENROUTER from invalid', S.invalid('x'), { type: 'SIGN_IN_OPENROUTER' }],
    ['CODE from noKey', S.noKey, { type: 'CODE', pasted: 'a' }],
    ['KEY from testing', S.testing, { type: 'KEY', key: 'k' }],
    ['ERR from testing', S.testing, { type: 'ERR' }],
    ['ERR from editing', S.editing, { type: 'ERR' }],
  ];
  for (const [name, from, event] of noops) {
    const r = reduceProvider(from, event);
    check(`no-op: ${name}`, JSON.stringify(r.state) === JSON.stringify(from) && r.effects.length === 0, JSON.stringify(r));
  }

  // ---- Purity ----
  console.log('purity');
  {
    const from = { kind: 'testing' };
    const before = JSON.stringify(from);
    reduceProvider(from, { type: 'PROBE_OK', toolCallsWork: false });
    check('reducer does not mutate its input state', JSON.stringify(from) === before);
  }
  check('every table state is covered', ['noKey', 'editing', 'testing', 'ready', 'invalid', 'awaitingCode', 'exchanging'].length === 7);

  if (failed) {
    console.error(`\n${failed} failed`);
    process.exit(1);
  }
  console.log('\nassistant provider tests passed');
}

main();
