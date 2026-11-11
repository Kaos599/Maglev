#!/usr/bin/env node
// Assistant provider prefs: presets, LAN-only http rule, tolerant migration, store round-trip, key never persisted.
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

function memoryKv(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, v),
  };
}

function memorySecrets() {
  const data = new Map();
  return {
    data,
    async get(n) {
      return data.has(n) ? data.get(n) : null;
    },
    async set(n, v) {
      data.set(n, v);
    },
    async remove(n) {
      data.delete(n);
    },
  };
}

async function main() {
  const m = await import('../utils/prefs/assistant.ts');

  // ---- Presets ----
  console.log('presets');
  const ids = m.PRESETS.map((p) => p.id);
  check('six presets in order', JSON.stringify(ids) === JSON.stringify(['openrouter', 'openai', 'anthropic', 'groq', 'gemini', 'custom']), ids.join(','));
  check('every preset has a label, model and notes', m.PRESETS.every((p) => p.label && p.defaultModel && p.notes));
  check('every preset base URL passes checkBaseUrl', m.PRESETS.every((p) => m.checkBaseUrl(p.baseUrl).ok), m.PRESETS.map((p) => p.baseUrl).join(' '));
  check('verified presets cite an https source', m.PRESETS.filter((p) => p.verified).every((p) => p.sourceUrl.startsWith('https://')));
  check('all six base URLs verified against a docs page', m.PRESETS.every((p) => p.verified === true));
  check('only custom is local', m.PRESETS.filter((p) => p.local).map((p) => p.id).join() === 'custom');
  check('presetById finds groq', m.presetById('groq').baseUrl === 'https://api.groq.com/openai/v1');
  let threw = false;
  try {
    m.presetById('nope');
  } catch {
    threw = true;
  }
  check('presetById throws on unknown id', threw);

  // ---- keyNameFor ----
  console.log('key names');
  check('keyNameFor uses SecureStore-safe characters', m.PRESETS.every((p) => /^[A-Za-z0-9._-]+$/.test(m.keyNameFor(p.id))));
  check('keyNameFor openai', m.keyNameFor('openai') === 'assistant.openai');

  // ---- LAN rule ----
  console.log('private hosts');
  const privateHosts = [
    '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.254', '192.168.1.20', '127.0.0.1', '127.9.9.9',
    '::1', '[::1]', 'fc00::1', 'fd12:3456::1', '[fdab::2]', 'localhost', 'nas.local', 'PRINTER.LOCAL',
  ];
  for (const h of privateHosts) check(`private: ${h}`, m.isPrivateHost(h) === true);
  const publicHosts = [
    '8.8.8.8', '172.15.0.1', '172.32.0.1', '192.169.0.1', '11.0.0.1', '1.2.3.4', 'example.com', 'api.openai.com',
    'fe80::1', '2001:db8::1', 'fe::1', '::', '999.1.1.1', 'localnet', 'local.example.com',
  ];
  for (const h of publicHosts) check(`public: ${h}`, m.isPrivateHost(h) === false);

  console.log('base URL check');
  check('https public allowed', m.checkBaseUrl('https://api.openai.com/v1').ok === true);
  check('http public refused', m.checkBaseUrl('http://api.openai.com/v1').ok === false);
  check('http LAN allowed', m.checkBaseUrl('http://192.168.1.50:11434/v1/').ok === true);
  check('http localhost allowed', m.checkBaseUrl('http://localhost:11434/v1/').ok === true);
  check('http IPv6 loopback allowed', m.checkBaseUrl('http://[::1]:11434/v1').ok === true);
  check('ftp refused', m.checkBaseUrl('ftp://192.168.1.5/v1').ok === false);
  check('garbage refused', m.checkBaseUrl('not a url').ok === false);
  check('empty refused', m.checkBaseUrl('').ok === false);
  check('credentials refused', m.checkBaseUrl('https://user:pw@api.openai.com/v1').ok === false);
  check('refusal copy exact', (() => {
    const r = m.checkBaseUrl('http://example.com');
    return !r.ok && r.reason === 'That address must start with https://';
  })());
  check('trims whitespace and keeps the URL', (() => {
    const r = m.checkBaseUrl('  https://api.groq.com/openai/v1  ');
    return r.ok && r.url === 'https://api.groq.com/openai/v1';
  })());
  check('chatCompletionsUrl strips trailing slashes once', m.chatCompletionsUrl('https://api.anthropic.com/v1/') === 'https://api.anthropic.com/v1/chat/completions');
  check('chatCompletionsUrl no doubled slash', m.chatCompletionsUrl('https://openrouter.ai/api/v1') === 'https://openrouter.ai/api/v1/chat/completions');

  // ---- Defaults and migration ----
  console.log('migration');
  const d = m.defaultAssistantPrefs();
  check('defaults: openrouter, default model, no key, zero tokens', d.presetId === 'openrouter' && d.model === 'openai/gpt-5-nano' && d.keyRef === null && d.tokensUsed.input === 0 && d.tokensUsed.output === 0);
  check('null raw gives defaults', JSON.stringify(m.normalizeAssistantPrefs(null)) === JSON.stringify(d));
  check('array raw gives defaults', JSON.stringify(m.normalizeAssistantPrefs([1, 2])) === JSON.stringify(d));
  check('string raw gives defaults', JSON.stringify(m.normalizeAssistantPrefs('x')) === JSON.stringify(d));
  check('unknown preset falls back to openrouter', m.normalizeAssistantPrefs({ presetId: 'mystery' }).presetId === 'openrouter');
  check('unknown preset keeps defaults for url and model', (() => {
    const p = m.normalizeAssistantPrefs({ presetId: 'mystery' });
    return p.baseUrl === 'https://openrouter.ai/api/v1' && p.model === 'openai/gpt-5-nano';
  })());
  check('valid saved fields kept', (() => {
    const p = m.normalizeAssistantPrefs({ presetId: 'groq', baseUrl: 'https://api.groq.com/openai/v1', model: ' llama-3.1-8b-instant ' });
    return p.presetId === 'groq' && p.model === 'llama-3.1-8b-instant';
  })());
  check('unsafe saved baseUrl replaced by preset URL', (() => {
    const p = m.normalizeAssistantPrefs({ presetId: 'openai', baseUrl: 'http://evil.example.com/v1' });
    return p.baseUrl === 'https://api.openai.com/v1';
  })());
  check('LAN baseUrl kept for custom', m.normalizeAssistantPrefs({ presetId: 'custom', baseUrl: 'http://192.168.1.9:11434/v1' }).baseUrl === 'http://192.168.1.9:11434/v1');
  check('empty model replaced by default', m.normalizeAssistantPrefs({ model: '   ' }).model === 'openai/gpt-5-nano');
  check('over-long model replaced by default', m.normalizeAssistantPrefs({ model: 'x'.repeat(121) }).model === 'openai/gpt-5-nano');
  check('keyRef with bad characters dropped', m.normalizeAssistantPrefs({ keyRef: 'sk-abc/def' }).keyRef === null);
  check('keyRef with spaces dropped', m.normalizeAssistantPrefs({ keyRef: 'my key' }).keyRef === null);
  check('valid keyRef kept', m.normalizeAssistantPrefs({ keyRef: 'assistant.openai' }).keyRef === 'assistant.openai');
  check('negative and fractional counters clamp to 0 or floor', (() => {
    const t = m.normalizeAssistantPrefs({ tokensUsed: { input: -5, output: 12.9 } }).tokensUsed;
    return t.input === 0 && t.output === 12;
  })());
  check('NaN and string counters become 0', (() => {
    const t = m.normalizeAssistantPrefs({ tokensUsed: { input: NaN, output: '7' } }).tokensUsed;
    return t.input === 0 && t.output === 0;
  })());
  check('extra unknown fields ignored', !('apiKey' in m.normalizeAssistantPrefs({ apiKey: 'sk-123' })));
  check('legacy record without version still parses', m.normalizeAssistantPrefs({ presetId: 'anthropic' }).presetId === 'anthropic');

  // ---- Pure helpers ----
  console.log('helpers');
  check('selectPreset resets url, model and keyRef', (() => {
    const p = m.selectPreset({ ...d, keyRef: 'assistant.openrouter', model: 'x' }, 'gemini');
    return p.presetId === 'gemini' && p.baseUrl === m.presetById('gemini').baseUrl && p.model === m.presetById('gemini').defaultModel && p.keyRef === null;
  })());
  check('addTokensUsed adds and sanitises', (() => {
    const p = m.addTokensUsed(d, { input: 100, output: 20 });
    const q = m.addTokensUsed(p, { input: -1, output: 5.7 });
    return p.tokensUsed.input === 100 && q.tokensUsed.input === 100 && q.tokensUsed.output === 25;
  })());
  check('addTokensUsed does not mutate input', (() => {
    const before = JSON.stringify(d);
    m.addTokensUsed(d, { input: 3 });
    return JSON.stringify(d) === before;
  })());

  // ---- Store ----
  console.log('store');
  {
    const kv = memoryKv();
    const secrets = memorySecrets();
    const store = m.createAssistantPrefsStore(kv, secrets);
    check('store starts at defaults', store.get().presetId === 'openrouter');

    let notified = 0;
    const off = store.subscribe(() => notified++);
    store.update({ presetId: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-nano' });
    check('update notifies subscribers once', notified === 1, String(notified));
    off();
    store.update({ model: 'gpt-5-mini' });
    check('unsubscribe stops notifications', notified === 1);

    const persisted = kv.data.get(m.ASSISTANT_PREFS_KEY);
    check('persisted under versioned key', typeof persisted === 'string' && persisted.includes('"version":1'));

    const reloaded = m.createAssistantPrefsStore(kv, secrets).get();
    check('round-trip: fresh store reads what was saved', reloaded.presetId === 'openai' && reloaded.model === 'gpt-5-mini');

    store.update((p) => ({ tokensUsed: { input: p.tokensUsed.input + 50, output: 9 } }));
    check('function-form update sees previous value', store.get().tokensUsed.input === 50 && store.get().tokensUsed.output === 9);

    const keyName = await store.saveKey('openai', '  sk-test-123  ');
    check('saveKey returns the key name', keyName === 'assistant.openai');
    check('saveKey sets keyRef', store.get().keyRef === 'assistant.openai');
    check('saveKey writes the trimmed key to the secret store', secrets.data.get('assistant.openai') === 'sk-test-123');
    check('key never reaches the kv store', !kv.data.get(m.ASSISTANT_PREFS_KEY).includes('sk-test-123'));
    check('readKey returns the stored key', (await store.readKey('openai')) === 'sk-test-123');
    check('readKey for another preset is null', (await store.readKey('groq')) === null);

    await store.removeKey();
    check('removeKey deletes the secret', !secrets.data.has('assistant.openai'));
    check('removeKey clears keyRef', store.get().keyRef === null);
    await store.removeKey();
    check('removeKey with no key is harmless', store.get().keyRef === null);
  }

  {
    const throwingKv = {
      getItem() {
        throw new Error('storage gone');
      },
      setItem() {
        throw new Error('storage gone');
      },
    };
    const store = m.createAssistantPrefsStore(throwingKv, memorySecrets());
    check('unreadable storage falls back to defaults', store.get().presetId === 'openrouter');
    let survived = true;
    try {
      store.update({ model: 'x' });
    } catch {
      survived = false;
    }
    check('unwritable storage keeps the change in memory', survived && store.get().model === 'x');
  }

  {
    const kv = memoryKv({ [m.ASSISTANT_PREFS_KEY]: '{not json' });
    const store = m.createAssistantPrefsStore(kv, memorySecrets());
    check('corrupt JSON gives defaults', store.get().presetId === 'openrouter');
  }

  {
    const failingSecrets = {
      async get() {
        throw new Error('keystore locked');
      },
      async set() {},
      async remove() {
        throw new Error('keystore locked');
      },
    };
    const store = m.createAssistantPrefsStore(memoryKv(), failingSecrets);
    check('readKey returns null when the keystore throws', (await store.readKey('openai')) === null);
    let ok = true;
    try {
      await store.removeKey();
    } catch {
      ok = false;
    }
    check('removeKey survives a keystore error', ok);
  }

  if (failed) {
    console.error(`\n${failed} failed`);
    process.exit(1);
  }
  console.log('\nassistant prefs tests passed');
}

main();
