#!/usr/bin/env node
// Provider setup helpers: the "Test model" probe (utils/assistantApp/probe.ts) and the pure parts of
// Sign in with OpenRouter (utils/assistantApp/openrouterAuth.ts), with a fake fetch.
// Needs Node 22.18+ (runs the TypeScript source directly via type stripping).

process.removeAllListeners('warning');
const crypto = require('node:crypto');

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}

const res = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const toolReply = (args = '{"ok":true}', name = 'ping') => ({
  choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: args } }] } }],
});
const INPUT = { baseUrl: 'https://api.openai.com/v1/', model: 'gpt-5-nano', key: 'sk-secret', preset: 'openai' };

async function main() {
  const { probeModel, buildProbeBody, hasWellFormedToolCall } = await import('../utils/assistantApp/probe.ts');
  const A = await import('../utils/assistantApp/openrouterAuth.ts');
  const { reduceProvider } = await import('../utils/assistant/providerMachine.ts');

  // ---- probe: request shape ----
  console.log('probe request');
  let seen = null;
  const spy = async (url, init) => {
    seen = { url, init };
    return res(200, toolReply());
  };
  const ok = await probeModel(INPUT, spy);
  check('PROBE_OK with tool calls working', ok && ok.type === 'PROBE_OK' && ok.toolCallsWork === true, JSON.stringify(ok));
  check('posts to /chat/completions without a doubled slash', seen.url === 'https://api.openai.com/v1/chat/completions', seen.url);
  check('POST method', seen.init.method === 'POST');
  check('bearer key in the header', seen.init.headers.Authorization === 'Bearer sk-secret');
  const body = JSON.parse(seen.init.body);
  check('model is sent', body.model === 'gpt-5-nano');
  check('non-streaming', body.stream === false);
  check('exactly one tool', Array.isArray(body.tools) && body.tools.length === 1 && body.tools[0].function.name === 'ping');
  check('tool_choice is auto, never forced', body.tool_choice === 'auto');
  check('the key is not in the body', !seen.init.body.includes('sk-secret'));
  check('buildProbeBody parses', JSON.parse(buildProbeBody('m')).model === 'm');

  await probeModel({ ...INPUT, preset: 'custom', key: '' }, async (u, init) => {
    seen = { url: u, init };
    return res(200, toolReply());
  });
  check('no Authorization header without a key', seen.init.headers.Authorization === undefined);

  // ---- probe: results ----
  console.log('probe results');
  const run = (r) => probeModel(INPUT, async () => r);
  check('no tool_calls -> toolCallsWork false', JSON.stringify(await run(res(200, { choices: [{ message: { content: 'hi' } }] }))) === '{"type":"PROBE_OK","toolCallsWork":false}');
  check('empty tool_calls -> false', (await run(res(200, { choices: [{ message: { tool_calls: [] } }] }))).toolCallsWork === false);
  check('arguments that are not JSON -> false', (await run(res(200, toolReply('{oops')))).toolCallsWork === false);
  check('arguments that are an array -> false', (await run(res(200, toolReply('[1]')))).toolCallsWork === false);
  check('missing tool name -> false', (await run(res(200, toolReply('{}', '')))).toolCallsWork === false);
  check('empty object arguments are fine', (await run(res(200, toolReply('{}')))).toolCallsWork === true);
  check('no choices -> false', (await run(res(200, { choices: [] }))).toolCallsWork === false);
  check('hasWellFormedToolCall(null) is false', hasWellFormedToolCall(null) === false);
  for (const s of [401, 402, 403, 404, 429, 500, 503]) {
    const r = await run(res(s, { error: { message: 'nope' } }));
    check(`HTTP ${s} -> PROBE_ERR ${s}`, r.type === 'PROBE_ERR' && r.status === s, JSON.stringify(r));
  }
  const tools400 = await run(res(400, { error: { message: 'This model does not support tools' } }));
  check('400 about tools -> toolCallsWork false', tools400.type === 'PROBE_OK' && tools400.toolCallsWork === false, JSON.stringify(tools400));
  const tools404 = await run(res(404, { error: { message: 'No endpoints found that support tool use' } }));
  check('404 about tool use -> toolCallsWork false', tools404.type === 'PROBE_OK' && tools404.toolCallsWork === false, JSON.stringify(tools404));
  const plain404 = await run(res(404, { error: { message: 'The model does not exist' } }));
  check('plain 404 stays a 404', plain404.type === 'PROBE_ERR' && plain404.status === 404);
  const err200 = await run(res(200, { error: { code: 402, message: 'Insufficient credits' } }));
  check('200 with error.code 402 -> PROBE_ERR 402', err200.type === 'PROBE_ERR' && err200.status === 402, JSON.stringify(err200));
  const err200b = await run(res(200, { error: { message: 'weird' } }));
  check('200 with an error and no code -> PROBE_ERR 400', err200b.type === 'PROBE_ERR' && err200b.status === 400);
  const html = await run(res(200, '<html>login</html>'));
  check('200 that is not JSON -> PROBE_ERR 400', html.type === 'PROBE_ERR' && html.status === 400);
  const net = await probeModel(INPUT, async () => {
    throw new TypeError('Network request failed');
  });
  check('fetch throws -> PROBE_ERR net', net.type === 'PROBE_ERR' && net.status === 'net');
  const slow = await probeModel(INPUT, (u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))), undefined, 20);
  check('too slow -> PROBE_ERR timeout', slow.type === 'PROBE_ERR' && slow.status === 'timeout', JSON.stringify(slow));
  const ctl = new AbortController();
  const pending = probeModel(INPUT, (u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))), ctl.signal, 5000);
  ctl.abort();
  check('caller abort -> null (nothing to report)', (await pending) === null);
  check('already aborted signal -> null without a request', (await probeModel(INPUT, async () => { throw new Error('should not run'); }, ctl.signal)) === null);

  // ---- probe results drive providerMachine 1:1 ----
  console.log('probe -> providerMachine');
  const testing = { kind: 'testing', preset: 'openai', key: 'sk-1' };
  const m1 = reduceProvider(testing, ok);
  check('PROBE_OK event is accepted by the machine (ready + storeKey)', m1.state.kind === 'ready' && m1.effects[0].type === 'storeKey');
  const m2 = reduceProvider(testing, await run(res(401, {})));
  check('401 event -> invalid with the bad-key copy', m2.state.kind === 'invalid' && /didn't accept this key/.test(m2.state.reason));
  const m3 = reduceProvider(testing, await run(res(200, { choices: [{ message: { content: 'x' } }] })));
  check('no tool support -> invalid', m3.state.kind === 'invalid' && /can't work with Maglev's actions/.test(m3.state.reason));

  // ---- PKCE ----
  console.log('pkce');
  const sha256Base64 = async (s) => crypto.createHash('sha256').update(s, 'utf8').digest('base64');
  // RFC 7636 appendix B test vector.
  const challenge = await A.challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', sha256Base64);
  check('challenge = base64url(SHA-256(verifier)) on the RFC 7636 vector', challenge === 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', challenge);
  check('toBase64Url swaps + and / and drops padding', A.toBase64Url('a+b/c==') === 'a-b_c');
  const bytes = crypto.randomBytes(32);
  check('base64UrlEncode matches Node base64url', A.base64UrlEncode(bytes) === bytes.toString('base64url'));
  for (const n of [1, 2, 3, 4, 31, 32]) {
    const b = crypto.randomBytes(n);
    check(`base64UrlEncode(${n} bytes) matches Node`, A.base64UrlEncode(b) === b.toString('base64url'));
  }
  check('a 32-byte verifier is 43 URL-safe characters', /^[A-Za-z0-9_-]{43}$/.test(A.verifierFromBytes(bytes)));
  const url = new URL(A.buildAuthUrl(challenge));
  check('auth URL host and path', url.origin === 'https://openrouter.ai' && url.pathname === '/auth');
  check('auth URL carries the challenge and S256', url.searchParams.get('code_challenge') === challenge && url.searchParams.get('code_challenge_method') === 'S256');
  check('auth URL has no callback_url (headless mode)', !url.searchParams.has('callback_url'));
  check('auth URL never carries a verifier', !/verifier/.test(url.search));

  console.log('code parsing');
  check('bare code', A.parseAuthCode('  abc123DEF456  ') === 'abc123DEF456');
  check('code from a redirect URL', A.parseAuthCode('https://example.com/cb?code=xyz789abc&state=1') === 'xyz789abc');
  check('code from a query string', A.parseAuthCode('code=xyz789abc') === 'xyz789abc');
  check('percent-encoded code is decoded', A.parseAuthCode('https://x.test/?code=ab%2Bcd1234') === 'ab+cd1234');
  check('empty -> null', A.parseAuthCode('   ') === null);
  check('text with spaces -> null', A.parseAuthCode('my code is abc123') === null);
  check('too short -> null', A.parseAuthCode('ab') === null);
  check('bad percent escape -> null', A.parseAuthCode('?code=%E0%A4%A') === null);

  console.log('exchange');
  const store = new Map();
  const secrets = { get: async (n) => store.get(n) ?? null, set: async (n, v) => void store.set(n, v), remove: async (n) => void store.delete(n) };
  let opened = null;
  let posted = null;
  const mkAuth = (fetchImpl) =>
    A.createOpenRouterAuth({
      randomBytes: async (n) => crypto.randomBytes(n),
      sha256Base64,
      secrets,
      openBrowser: async (u) => void (opened = u),
      fetch: fetchImpl,
    });
  const okFetch = async (u, init) => {
    posted = { u, init };
    return res(200, { key: ' sk-or-v1-abc ' });
  };
  let auth = mkAuth(okFetch);
  await auth.start();
  const verifier = store.get(A.VERIFIER_SECRET_NAME);
  check('start persists the verifier in secure storage', typeof verifier === 'string' && verifier.length === 43);
  const oUrl = new URL(opened);
  check('the page opened has the matching challenge', oUrl.searchParams.get('code_challenge') === (await A.challengeFor(verifier, sha256Base64)));
  check('the verifier is not in the opened URL', !opened.includes(verifier));
  const r = await auth.exchange('thecode123');
  check('exchange returns the trimmed key', r.ok === true && r.key === 'sk-or-v1-abc', JSON.stringify(r));
  check('exchange POSTs to /auth/keys', posted.u === 'https://openrouter.ai/api/v1/auth/keys' && posted.init.method === 'POST');
  const pb = JSON.parse(posted.init.body);
  check('exchange body: code, verifier, S256', pb.code === 'thecode123' && pb.code_verifier === verifier && pb.code_challenge_method === 'S256');
  check('verifier is dropped after a good exchange', !store.has(A.VERIFIER_SECRET_NAME));

  auth = mkAuth(okFetch);
  check('exchange without a start (no verifier) fails', (await auth.exchange('thecode123')).ok === false);
  await auth.start();
  auth = mkAuth(async () => res(403, { error: { message: 'Invalid code or code_verifier' } }));
  check('403 from OpenRouter -> failure', (await auth.exchange('bad-code-1')).ok === false);
  auth = mkAuth(async () => res(200, { nokey: true }));
  check('200 without a key -> failure', (await auth.exchange('thecode123')).ok === false);
  auth = mkAuth(async () => {
    throw new TypeError('offline');
  });
  check('network error -> failure, no throw', (await auth.exchange('thecode123')).ok === false);

  await mkAuth(okFetch).start();
  check('verifier stored again before cancel', store.has(A.VERIFIER_SECRET_NAME));
  auth = mkAuth((u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))));
  const inflight = auth.exchange('thecode123');
  await new Promise((r2) => setTimeout(r2, 10));
  await auth.cancel();
  check('cancel aborts an exchange in flight', (await inflight).ok === false);
  check('cancel drops the verifier', !store.has(A.VERIFIER_SECRET_NAME));

  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
