#!/usr/bin/env node
// SM-40 Provider setup (with review round 1 R1-14): every table row, the copy strings, and no-op behaviour
// for events outside the table.
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
  testing: (preset = 'openai', key = 'sk-1') => ({ kind: 'testing', preset, key }),
  ready: { kind: 'ready' },
  invalid: (reason) => ({ kind: 'invalid', reason }),
  awaitingCode: (from = { kind: 'noKey' }) => ({ kind: 'awaitingCode', from }),
  exchanging: (from = { kind: 'noKey' }) => ({ kind: 'exchanging', from }),
};

const effectTypes = (effects) => effects.map((e) => e.type).join(',');
const effectsJson = (effects) => JSON.stringify(effects);

async function main() {
  const { reduceProvider, COPY, validateSave, INITIAL_PROVIDER_STATE, fillProvider, providerName, PROVIDER_TIMEOUT_MS } = await import('../utils/assistant/providerMachine.ts');

  // ---- Copy strings ----
  console.log('copy');
  check('Paste a key', COPY.pasteKey === 'Paste a key');
  check('That address must start with https://', COPY.httpsOnly === 'That address must start with https://');
  check('Pick a model', COPY.pickModel === 'Pick a model');
  check("This model can't work with Maglev's actions. Pick another.", COPY.cantUseTools === "This model can't work with Maglev's actions. Pick another.");
  check('bad key copy has a {provider} placeholder', COPY.badKey === "{provider} didn't accept this key. Paste it again or make a new one.");
  check('out of credit copy has a {provider} placeholder', COPY.outOfCredits === 'Your {provider} account is out of credit. Top up on their site or pick another model.');
  check("Couldn't reach the provider. Try again.", COPY.cantReach === "Couldn't reach the provider. Try again.");
  check("Sign-in didn't finish. Try again.", COPY.signInFailed === "Sign-in didn't finish. Try again.");
  check('local caption', COPY.localCaption === 'Runs on your network. Nothing leaves it.');
  check('initial state is noKey', INITIAL_PROVIDER_STATE.kind === 'noKey');
  check('fillProvider fills the name', fillProvider(COPY.badKey, 'openai') === "OpenAI didn't accept this key. Paste it again or make a new one.", fillProvider(COPY.badKey, 'openai'));
  check('providerName falls back for an unknown preset', providerName('nope') === 'The provider');
  check('the sign-in timeout is 10 minutes', PROVIDER_TIMEOUT_MS === 600000);

  // ---- Field validation for SAVE ----
  console.log('save validation');
  check('empty key -> Paste a key', validateSave({ baseUrl: 'https://a.example/v1', model: 'm', key: '  ' }) === 'Paste a key');
  check('public http -> https message', validateSave({ baseUrl: 'http://a.example/v1', model: 'm', key: 'k' }) === COPY.httpsOnly);
  check('LAN http is valid', validateSave({ baseUrl: 'http://192.168.1.4:11434/v1', model: 'm', key: 'k' }) === null);
  check('empty model -> Pick a model', validateSave({ baseUrl: 'https://a.example/v1', model: '', key: 'k' }) === 'Pick a model');
  check('key error wins over the others', validateSave({ baseUrl: 'bad', model: '', key: '' }) === 'Paste a key');
  check('base URL error wins over model', validateSave({ baseUrl: 'bad', model: '', key: 'k' }) === COPY.httpsOnly);
  check('custom (Ollama) preset needs no key', validateSave({ preset: 'custom', baseUrl: 'http://192.168.1.4:11434/v1', model: 'm', key: '' }) === null);
  check('custom preset still needs a valid address', validateSave({ preset: 'custom', baseUrl: 'bad', model: 'm', key: '' }) === COPY.httpsOnly);
  check('other presets still need a key', validateSave({ preset: 'openai', baseUrl: 'https://a.example/v1', model: 'm', key: '' }) === 'Paste a key');

  // ---- Table rows ----
  console.log('table rows');
  const probeOpenAI = [{ type: 'probe', preset: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-nano', key: 'sk-1' }];
  const rows = [
    // [name, from, event, expectedState, expected effects JSON]
    ['noKey EDIT -> editing', S.noKey, { type: 'EDIT' }, S.editing, []],
    ['ready EDIT -> editing', S.ready, { type: 'EDIT' }, S.editing, []],
    ['invalid EDIT -> editing', S.invalid('x'), { type: 'EDIT' }, S.editing, []],
    ['editing SAVE valid -> testing, probe only (the key is not stored yet)', S.editing, VALID_SAVE, S.testing(), probeOpenAI],
    ['editing SAVE empty key -> editing', S.editing, { ...VALID_SAVE, key: '' }, S.editing, [{ type: 'showError', message: 'Paste a key' }]],
    ['editing SAVE bad URL -> editing', S.editing, { ...VALID_SAVE, baseUrl: 'http://example.com/v1' }, S.editing, [{ type: 'showError', message: COPY.httpsOnly }]],
    ['editing SAVE empty model -> editing', S.editing, { ...VALID_SAVE, model: ' ' }, S.editing, [{ type: 'showError', message: COPY.pickModel }]],
    ['editing SAVE custom preset without a key -> testing, probe with empty key', S.editing, { type: 'SAVE', preset: 'custom', baseUrl: 'http://192.168.1.4:11434/v1', model: 'llama3', key: '' }, S.testing('custom', ''), [{ type: 'probe', preset: 'custom', baseUrl: 'http://192.168.1.4:11434/v1', model: 'llama3', key: '' }]],
    ['testing PROBE_OK tools work -> ready, storeKey now', S.testing(), { type: 'PROBE_OK', toolCallsWork: true }, S.ready, [{ type: 'storeKey', key: 'sk-1' }]],
    ['testing (custom, no key) PROBE_OK -> ready, nothing to store', S.testing('custom', ''), { type: 'PROBE_OK', toolCallsWork: true }, S.ready, []],
    ['testing PROBE_OK no tools -> invalid, key never stored', S.testing(), { type: 'PROBE_OK', toolCallsWork: false }, S.invalid(COPY.cantUseTools), []],
    ['testing PROBE_ERR 401 -> invalid with the provider name', S.testing('openai'), { type: 'PROBE_ERR', status: 401 }, S.invalid("OpenAI didn't accept this key. Paste it again or make a new one."), []],
    ['testing PROBE_ERR 403 -> invalid with the provider name', S.testing('groq'), { type: 'PROBE_ERR', status: 403 }, S.invalid("Groq didn't accept this key. Paste it again or make a new one."), []],
    ['testing PROBE_ERR 402 -> invalid with the provider name', S.testing('openrouter'), { type: 'PROBE_ERR', status: 402 }, S.invalid('Your OpenRouter account is out of credit. Top up on their site or pick another model.'), []],
    ['testing PROBE_ERR net -> invalid', S.testing(), { type: 'PROBE_ERR', status: 'net' }, S.invalid(COPY.cantReach), []],
    ['testing PROBE_ERR timeout -> invalid', S.testing(), { type: 'PROBE_ERR', status: 'timeout' }, S.invalid(COPY.cantReach), []],
    ['testing PROBE_ERR 500 -> invalid', S.testing(), { type: 'PROBE_ERR', status: 500 }, S.invalid(COPY.cantReach), []],
    ['testing PROBE_ERR 503 -> invalid', S.testing(), { type: 'PROBE_ERR', status: 503 }, S.invalid(COPY.cantReach), []],
    ['noKey SIGN_IN_OPENROUTER -> awaitingCode', S.noKey, { type: 'SIGN_IN_OPENROUTER' }, S.awaitingCode(S.noKey), [{ type: 'openAuth' }]],
    ['invalid SIGN_IN_OPENROUTER -> awaitingCode (remembers invalid)', S.invalid('x'), { type: 'SIGN_IN_OPENROUTER' }, S.awaitingCode(S.invalid('x')), [{ type: 'openAuth' }]],
    ['editing SIGN_IN_OPENROUTER -> awaitingCode (remembers editing)', S.editing, { type: 'SIGN_IN_OPENROUTER' }, S.awaitingCode(S.editing), [{ type: 'openAuth' }]],
    ['awaitingCode CODE -> exchanging', S.awaitingCode(), { type: 'CODE', pasted: 'abc' }, S.exchanging(), [{ type: 'exchangeCode', code: 'abc' }]],
    ['exchanging KEY -> testing, probe (key not stored yet)', S.exchanging(), { type: 'KEY', key: 'sk-or-1', baseUrl: 'https://openrouter.ai/api/v1', model: 'm1' }, S.testing('openrouter', 'sk-or-1'), [{ type: 'probe', preset: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'm1', key: 'sk-or-1' }]],
    ['exchanging ERR -> invalid', S.exchanging(), { type: 'ERR' }, S.invalid(COPY.signInFailed), []],
    ['awaitingCode CANCEL -> back to noKey', S.awaitingCode(S.noKey), { type: 'CANCEL' }, S.noKey, [{ type: 'cancelAuth' }]],
    ['awaitingCode CANCEL -> back to editing', S.awaitingCode(S.editing), { type: 'CANCEL' }, S.editing, [{ type: 'cancelAuth' }]],
    ['exchanging CANCEL -> back to invalid', S.exchanging(S.invalid('x')), { type: 'CANCEL' }, S.invalid('x'), [{ type: 'cancelAuth' }]],
    ['awaitingCode TIMEOUT -> invalid', S.awaitingCode(), { type: 'TIMEOUT' }, S.invalid(COPY.signInTimedOut), [{ type: 'cancelAuth' }]],
    ['exchanging TIMEOUT -> invalid', S.exchanging(), { type: 'TIMEOUT' }, S.invalid(COPY.signInTimedOut), [{ type: 'cancelAuth' }]],
  ];
  for (const [name, from, event, to, fx] of rows) {
    const r = reduceProvider(from, event);
    check(name, JSON.stringify(r.state) === JSON.stringify(to), JSON.stringify(r.state));
    check(`${name} effects`, effectsJson(r.effects) === JSON.stringify(fx), effectsJson(r.effects));
  }

  // REMOVE_KEY is "any" state.
  const anyStates = [S.noKey, S.editing, S.testing(), S.ready, S.invalid('x'), S.awaitingCode(), S.exchanging()];
  for (const from of anyStates) {
    const r = reduceProvider(from, { type: 'REMOVE_KEY' });
    const auth = from.kind === 'awaitingCode' || from.kind === 'exchanging';
    check(`any -> REMOVE_KEY from ${from.kind} -> noKey`, JSON.stringify(r.state) === JSON.stringify(S.noKey));
    check(`REMOVE_KEY from ${from.kind} removes key and expires cards${auth ? ' (and cancels sign-in)' : ''}`, effectTypes(r.effects) === (auth ? 'cancelAuth,removeKey,expireCards' : 'removeKey,expireCards'), effectTypes(r.effects));
  }

  // ---- The key is stored only after PROBE_OK ----
  console.log('key storage');
  {
    const save = reduceProvider(S.editing, { ...VALID_SAVE, key: '  sk-trim  ' });
    check('SAVE does not emit storeKey (adversarial)', !save.effects.some((e) => e.type === 'storeKey'), effectsJson(save.effects));
    check('SAVE probe carries preset, base URL, model and the trimmed key', effectsJson(save.effects) === JSON.stringify([{ type: 'probe', preset: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-nano', key: 'sk-trim' }]));
    const ok = reduceProvider(save.state, { type: 'PROBE_OK', toolCallsWork: true });
    check('PROBE_OK stores the trimmed key', effectsJson(ok.effects) === JSON.stringify([{ type: 'storeKey', key: 'sk-trim' }]));
    for (const status of [401, 402, 404, 429, 500, 'net', 'timeout']) {
      const r = reduceProvider(save.state, { type: 'PROBE_ERR', status });
      check(`PROBE_ERR ${status} never stores the key`, !r.effects.some((e) => e.type === 'storeKey') && JSON.stringify(r.state).indexOf('sk-trim') === -1);
    }
    const nt = reduceProvider(save.state, { type: 'PROBE_OK', toolCallsWork: false });
    check('PROBE_OK without tool calls never stores the key and drops it from the state', nt.effects.length === 0 && JSON.stringify(nt.state).indexOf('sk-trim') === -1);
    const keyFlow = reduceProvider(S.exchanging(), { type: 'KEY', key: ' sk-or-9 ', baseUrl: 'https://openrouter.ai/api/v1', model: 'm' });
    check('OpenRouter KEY does not store either; it probes first', !keyFlow.effects.some((e) => e.type === 'storeKey'));
    const e = reduceProvider(S.editing, { ...VALID_SAVE, key: '' });
    check('field error carries the exact message', effectsJson(e.effects) === JSON.stringify([{ type: 'showError', message: 'Paste a key' }]));
    const c = reduceProvider(S.awaitingCode(), { type: 'CODE', pasted: '  code-9  ' });
    check('CODE passes the trimmed code', effectsJson(c.effects) === JSON.stringify([{ type: 'exchangeCode', code: 'code-9' }]));
  }

  // ---- PROBE_ERR never leaves the screen stuck in testing ----
  for (const [status, reason] of [[404, COPY.modelNotFound], [429, COPY.rateLimited], [400, COPY.rejected], [418, COPY.rejected]]) {
    const r = reduceProvider(S.testing(), { type: 'PROBE_ERR', status });
    check(`PROBE_ERR ${status} -> invalid`, r.state.kind === 'invalid' && r.state.reason === reason, JSON.stringify(r));
  }
  {
    const r = reduceProvider(S.testing('custom', ''), { type: 'PROBE_ERR', status: 401 });
    check('the {provider} placeholder is always filled', r.state.kind === 'invalid' && !r.state.reason.includes('{'), r.state.reason);
  }

  // ---- Events outside the table are no-ops ----
  console.log('no-ops');
  const noops = [
    ['SAVE from noKey', S.noKey, VALID_SAVE],
    ['SAVE from ready', S.ready, VALID_SAVE],
    ['SAVE from testing', S.testing(), VALID_SAVE],
    ['EDIT from testing', S.testing(), { type: 'EDIT' }],
    ['EDIT from editing', S.editing, { type: 'EDIT' }],
    ['EDIT from exchanging', S.exchanging(), { type: 'EDIT' }],
    ['EDIT from awaitingCode', S.awaitingCode(), { type: 'EDIT' }],
    ['PROBE_OK from editing', S.editing, { type: 'PROBE_OK', toolCallsWork: true }],
    ['PROBE_OK from ready', S.ready, { type: 'PROBE_OK', toolCallsWork: true }],
    ['PROBE_ERR 401 from editing', S.editing, { type: 'PROBE_ERR', status: 401 }],
    ['SIGN_IN_OPENROUTER from ready', S.ready, { type: 'SIGN_IN_OPENROUTER' }],
    ['SIGN_IN_OPENROUTER from testing', S.testing(), { type: 'SIGN_IN_OPENROUTER' }],
    ['SIGN_IN_OPENROUTER from awaitingCode', S.awaitingCode(), { type: 'SIGN_IN_OPENROUTER' }],
    ['CODE from noKey', S.noKey, { type: 'CODE', pasted: 'a' }],
    ['KEY from testing', S.testing(), { type: 'KEY', key: 'k', baseUrl: 'https://a.example/v1', model: 'm' }],
    ['ERR from testing', S.testing(), { type: 'ERR' }],
    ['ERR from editing', S.editing, { type: 'ERR' }],
    ['CANCEL from noKey', S.noKey, { type: 'CANCEL' }],
    ['CANCEL from testing', S.testing(), { type: 'CANCEL' }],
    ['CANCEL from ready', S.ready, { type: 'CANCEL' }],
    ['TIMEOUT from testing', S.testing(), { type: 'TIMEOUT' }],
    ['TIMEOUT from ready', S.ready, { type: 'TIMEOUT' }],
    ['TIMEOUT from noKey', S.noKey, { type: 'TIMEOUT' }],
  ];
  for (const [name, from, event] of noops) {
    const r = reduceProvider(from, event);
    check(`no-op: ${name}`, JSON.stringify(r.state) === JSON.stringify(from) && r.effects.length === 0, JSON.stringify(r));
  }

  // ---- Purity ----
  console.log('purity');
  {
    const from = S.testing();
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
