#!/usr/bin/env node
// OpenRouter model list: parse, filter to free + tools, sort, cache for a day, offline fallback, display names.
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

const m = (id, name, ctx, prompt, completion, params = ['tools', 'temperature']) => ({
  id, name, context_length: ctx, pricing: { prompt, completion }, supported_parameters: params,
});
const LIST = {
  data: [
    m('a/small:free', 'A: Small', 32000, '0', '0'),
    m('b/big:free', 'B: Big', 262144, '0', '0'),
    m('c/notools:free', 'C: No tools', 128000, '0', '0', ['temperature']),
    m('d/zero', 'D: Zero priced', 128000, '0', '0'),
    m('e/paid', 'E: Paid', 400000, '0.0000001', '0.0000004'),
    m('f/halfpaid', 'F: Half paid', 100000, '0', '0.000001'),
    m('b/alpha:free', 'A Alpha', 262144, '0', '0'),
    { name: 'no id' },
    null,
    m('openrouter/free', 'Free Models Router', 200000, '0', '0'),
    m('g/negative', 'G: Router', 100000, '-1', '-1'),
  ],
};

const fakeKv = () => {
  const o = {};
  return { getItem: (k) => (k in o ? o[k] : null), setItem: (k, v) => { o[k] = v; }, o };
};
const jsonRes = (body, status = 200) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });

async function main() {
  const M = await import('../utils/assistant/models.ts');
  const { PRESETS } = await import('../utils/prefs/assistant.ts');

  console.log('parse and filter');
  const all = M.parseModels(LIST);
  check('malformed entries are dropped', all.every((e) => typeof e.id === 'string') && all.length === 9);
  check('endpoint is the documented one', M.OPENROUTER_MODELS_URL === 'https://openrouter.ai/api/v1/models');
  const free = M.freeToolModels(all).map((e) => e.id);
  check('free = price 0 or :free id, and tools', free.includes('a/small:free') && free.includes('b/big:free') && free.includes('d/zero'), free.join());
  check('no tools -> out', !free.includes('c/notools:free'));
  check('paid -> out of free', !free.includes('e/paid') && !free.includes('f/halfpaid'));
  check('the router is not repeated in the list', !free.includes('openrouter/free'));
  check('negative (dynamic) pricing is not free', !free.includes('g/negative'));
  const paid = M.paidToolModels(all).map((e) => e.id);
  check('paid list has priced tool models', paid.includes('e/paid') && paid.includes('f/halfpaid') && !paid.includes('a/small:free') && !paid.includes('openrouter/free'));
  check('sorted by context desc, then name', free[0] === 'b/alpha:free' && free[1] === 'b/big:free' && free[free.length - 1] === 'a/small:free', free.join());

  console.log('words');
  check('128K', M.contextLabel(128000) === '128K' && M.contextLabel(131072) === '131K');
  check('long memory from 200K', M.contextLabel(262144) === 'Long memory · 262K');
  check('1M', M.contextLabel(1048576) === 'Long memory · 1M');
  check('unknown context', M.contextLabel(null) === '');

  console.log('cache and fallback');
  const NOW = 1_700_000_000_000;
  let kv = fakeKv();
  let calls = 0;
  const live = async (url, init) => { calls++; live.url = url; live.init = init; return jsonRes(LIST); };
  let r = await M.loadModels({ fetch: live, kv, now: () => NOW });
  check('first load is live', r.source === 'live' && r.free.length === free.length && calls === 1);
  check('no auth header needed', !live.init?.headers?.Authorization);
  r = await M.loadModels({ fetch: live, kv, now: () => NOW + 3600_000 });
  check('fresh cache within a day, no fetch', r.source === 'cache' && calls === 1);
  r = await M.loadModels({ fetch: live, kv, now: () => NOW + 25 * 3600_000 });
  check('refresh after a day', r.source === 'live' && calls === 2);
  r = await M.loadModels({ fetch: live, kv, now: () => NOW + 26 * 3600_000, force: true });
  check('force refreshes', calls === 3);
  const down = async () => { throw new Error('offline'); };
  r = await M.loadModels({ fetch: down, kv, now: () => NOW + 80 * 3600_000 });
  check('offline with a stale cache uses it', r.source === 'cache' && r.free.length > 0);
  r = await M.loadModels({ fetch: down, kv: fakeKv(), now: () => NOW });
  check('offline with nothing falls back to the static list', r.source === 'static' && r.free.some((e) => e.id === 'google/gemma-4-31b-it:free'));
  r = await M.loadModels({ fetch: async () => jsonRes({ nope: 1 }), kv: fakeKv(), now: () => NOW });
  check('a reply with no models is a failure', r.source === 'static');
  r = await M.loadModels({ fetch: async () => jsonRes({}, 500), kv: fakeKv(), now: () => NOW });
  check('HTTP error falls back', r.source === 'static');
  const bad = fakeKv();
  bad.setItem(M.MODELS_CACHE_KEY, '{garbage');
  r = await M.loadModels({ fetch: live, kv: bad, now: () => NOW });
  check('corrupt cache is ignored', r.source === 'live');
  const empty = await M.loadModels({ fetch: async () => jsonRes({ data: [] }), kv: fakeKv(), now: () => NOW });
  check('an empty list is not cached over a good one', empty.source === 'static');

  console.log('Auto and display names');
  check('Auto is first and labelled', M.AUTO_MODEL.id === 'openrouter/free' && M.AUTO_MODEL.name === 'Auto (any free model)');
  check('Auto matches the preset default', PRESETS.find((p) => p.id === 'openrouter').defaultModel === M.AUTO_MODEL.id);
  const P = (o) => ({ presetId: 'openrouter', model: 'openrouter/free', ...o });
  check('Auto shows its label', M.modelDisplayName(P({})) === 'Auto (any free model)');
  check('saved modelName wins', M.modelDisplayName(P({ model: 'b/big:free', modelName: 'B: Big' })) === 'B: Big');
  check('static list name without modelName', M.modelDisplayName(P({ model: 'openai/gpt-5-nano' })) === 'GPT-5 Nano');
  check('unknown id is tidied', M.modelDisplayName(P({ model: 'google/gemma-9-it:free' })) === 'gemma-9-it');
  check('other providers show the preset label or id', M.modelDisplayName({ presetId: 'openai', model: 'gpt-5-nano' }) === 'GPT-5 Nano' && M.modelDisplayName({ presetId: 'custom', model: 'llama3.1' }) === 'llama3.1');
  check('shortName drops the vendor prefix of a name', M.shortModelName('Google: Gemma 4 31B (free)') === 'Gemma 4 31B');

  console.log('attribution');
  const h = M.attributionHeaders('openrouter');
  check('OpenRouter gets the referer and title', h['HTTP-Referer'] === 'https://github.com/Kaos599/Maglev' && h['X-Title'] === 'Maglev');
  for (const id of ['openai', 'anthropic', 'groq', 'gemini', 'custom']) check(`${id} gets nothing`, Object.keys(M.attributionHeaders(id)).length === 0);

  if (failed) {
    console.error(`\n${failed} failed`);
    process.exit(1);
  }
  console.log('\nall passed');
}
main().catch((e) => { console.error(e); process.exit(1); });
