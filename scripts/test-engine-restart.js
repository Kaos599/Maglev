#!/usr/bin/env node
/**
 * Engine restart contract: after the native engine was stopped (notification "Shut down", auto-exit) the process
 * and the bridge survive. A call that returns NOT_INITIALIZED restarts the engine once with the last config
 * and retries once. Concurrent calls share one init. A failed restart surfaces its own error.
 *
 *   node scripts/test-engine-restart.js
 */
const { register } = require('node:module');

let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : '  ' + JSON.stringify(detail)}`);
  if (!ok) failed++;
}

const calls = [];
let running = true;
let initResult = { ok: true };
let initDelay = 0;
const native = {
  addListener: () => ({ remove() {} }),
  init: async (cfg) => {
    calls.push({ m: 'init', cfg });
    if (initDelay) await new Promise((r) => setTimeout(r, initDelay));
    if (initResult.ok) running = true;
    return initResult;
  },
  shutdown: async () => {
    calls.push({ m: 'shutdown' });
    return { ok: true };
  },
  setGovernance: async () => ({ ok: true }),
  setGlobalLimits: async () => ({ ok: true }),
  addTorrent: async () => {
    calls.push({ m: 'addTorrent' });
    return running ? { ok: true, id: 'a', info_hash: 'h' } : { ok: false, code: 'NOT_INITIALIZED', message: "The download engine isn't running yet." };
  },
  listTorrents: async () => {
    calls.push({ m: 'listTorrents' });
    return running ? { ok: true, torrents: [] } : { ok: false, code: 'NOT_INITIALIZED', message: 'stopped' };
  },
};
const inits = () => calls.filter((c) => c.m === 'init');
const count = (m) => calls.filter((c) => c.m === m).length;

register(
  'data:text/javascript,' +
    encodeURIComponent(
      `export async function resolve(s,c,n){ if(s==='expo-modules-core') return {url:'data:text/javascript,'+encodeURIComponent('export const Platform=globalThis.__fake.Platform;export const requireOptionalNativeModule=()=>globalThis.__fake.native;'),shortCircuit:true}; return n(s,c);}`
    )
);
globalThis.__DEV__ = false;
globalThis.__fake = { Platform: { OS: 'android' }, native };

(async () => {
  const { MaglevEngineBridge } = await import('../modules/maglev-engine/src/MaglevNativeBridge.ts');
  const { DEFAULT_SETTINGS } = await import('../modules/maglev-engine/src/MaglevSettings.types.ts');
  const { toNativeConfig } = await import('../modules/maglev-engine/src/toNativeConfig.ts');
  const { addErrorNotice, engineFailureAction } = await import('../utils/addErrorNotice.ts');
  const cfg = toNativeConfig(DEFAULT_SETTINGS);

  const fresh = async () => {
    calls.length = 0;
    running = true;
    initResult = { ok: true };
    initDelay = 0;
    const b = new MaglevEngineBridge();
    await b.start(DEFAULT_SETTINGS);
    calls.length = 0;
    return b;
  };

  // (a) stopped engine: add restarts with lastConfig and succeeds
  {
    const b = await fresh();
    running = false;
    const r = await b.addTorrent('magnet:?xt=urn:btih:x');
    check('a: add succeeds after a restart', r.ok === true, r);
    check('a: init ran once with the last config', inits().length === 1 && JSON.stringify(inits()[0].cfg) === JSON.stringify(cfg), inits());
    check('a: add was tried twice (original, retry)', count('addTorrent') === 2, count('addTorrent'));
    check('a: later calls do not restart again', (await b.listTorrents()).ok && inits().length === 1);
  }

  // (b) concurrent calls: one init
  {
    const b = await fresh();
    running = false;
    initDelay = 30;
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? b.listTorrents() : b.addTorrent('x'))));
    check('b: all ten calls succeed', rs.every((r) => r.ok), rs.map((r) => r.code));
    check('b: exactly one init', inits().length === 1, inits().length);
  }

  // (c) init fails: the call carries init's failure, no second retry
  {
    const b = await fresh();
    running = false;
    initResult = { ok: false, code: 'STORAGE_UNAVAILABLE', message: 'Pick the folder again.' };
    const r = await b.addTorrent('x');
    check('c: result is the init failure', !r.ok && r.code === 'STORAGE_UNAVAILABLE' && r.message === 'Pick the folder again.', r);
    check('c: one init, one add attempt', inits().length === 1 && count('addTorrent') === 1, { i: inits().length, a: count('addTorrent') });
    check('c: the failure is marked engineStopped for the UI', r.engineStopped === true, r);
    check('c: screens stay mounted (status unchanged)', b.engineStatus.kind === 'ready', b.engineStatus);
  }

  // (d) init and shutdown never trigger a restart
  {
    const b = await fresh();
    running = false;
    initResult = { ok: false, code: 'NOT_INITIALIZED', message: 'x' };
    const r = await b.init(cfg);
    check('d: a failing init is not retried', !r.ok && inits().length === 1, inits().length);
    calls.length = 0;
    const s = await b.shutdown();
    check('d: shutdown does not init', inits().length === 0 && count('shutdown') === 1 && s.ok === true);
  }

  // (e) copy and the button
  {
    const n = addErrorNotice({ code: 'NOT_INITIALIZED', message: "The download engine isn't running yet." });
    check('e: bare NOT_INITIALIZED gets the plain fallback body, no button without a handler',
      n.notice.title === 'The download engine stopped' && n.notice.body === "It couldn't be started again." && !n.notice.actionLabel && !n.duplicate, n);
    check('e: DUPLICATE still maps', addErrorNotice({ code: 'DUPLICATE' }).duplicate === true);
  }

  // (f) button path: restart fails -> notice with action -> press it -> restart works -> retry succeeds
  {
    const b = await fresh();
    running = false;
    initResult = { ok: false, code: 'STORAGE_UNAVAILABLE', message: 'The folder is not available.' };
    const failedAdd = await b.addTorrent('x');
    const err = Object.assign(new Error(failedAdd.message), { code: failedAdd.code, engineStopped: failedAdd.engineStopped });
    let retried = null;
    const { notice } = addErrorNotice(err, () => {
      retried = b.restart().then(async (r) => (r.ok ? b.addTorrent('x') : r));
    });
    check('f: notice shows the real reason with a Start engine button',
      notice.title === 'The download engine stopped' && notice.body === 'The folder is not available.' && notice.actionLabel === 'Start engine' && typeof notice.onAction === 'function', notice);
    initResult = { ok: true }; // the user fixed the cause
    notice.onAction();
    const r = await retried;
    check('f: pressing it restarts and the retried add succeeds', r.ok === true && b.engineStatus.kind === 'ready', r);
    check('f: two inits in total (automatic attempt, button)', inits().length === 2, inits().length);
    // restart() reports a failure with the reason
    running = false;
    initResult = { ok: false, code: 'INTERNAL', message: 'boom' };
    const bad = await b.restart();
    check('f: restart() failure carries the reason', !bad.ok && bad.message === 'boom', bad);
  }

  // (g) unavailable-screen action mapping
  {
    check('g: PERMISSION -> Pick folder again', engineFailureAction('PERMISSION').action === 'pickFolder' && engineFailureAction('PERMISSION').label === 'Pick folder again');
    check('g: DISK_FULL and STORAGE_UNAVAILABLE -> Pick folder again', engineFailureAction('DISK_FULL').action === 'pickFolder' && engineFailureAction('STORAGE_UNAVAILABLE').action === 'pickFolder');
    check('g: other and unknown codes -> Start engine', engineFailureAction('INTERNAL').label === 'Start engine' && engineFailureAction(undefined).action === 'startEngine' && engineFailureAction('ENGINE_UNAVAILABLE').action === 'startEngine');
  }

  // (h) boot failure: status carries the code; restart() starts the engine
  {
    calls.length = 0;
    running = false;
    initResult = { ok: false, code: 'PERMISSION', message: 'No access to the folder.' };
    const b = new MaglevEngineBridge();
    await b.start(DEFAULT_SETTINGS);
    check('h: unavailable status carries the init code', b.engineStatus.kind === 'unavailable' && b.engineStatus.code === 'PERMISSION', b.engineStatus);
    initResult = { ok: true };
    const r = await b.restart(DEFAULT_SETTINGS);
    check('h: restart() after a failed boot brings the engine up', r.ok === true && b.engineStatus.kind === 'ready', { r, s: b.engineStatus });
  }

  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();

// Notification and tile actions start the engine first when Android killed it (Pause all / Resume all).
{
  const host = require('fs').readFileSync(require('path').join(__dirname, '../modules/maglev-engine/android/src/main/java/com/maglev/engine/EngineHost.kt'), 'utf8');
  const body = (name) => { const i = host.indexOf(`fun ${name}()`); return i < 0 ? '' : host.slice(i, host.indexOf('\n    }\n', i)); };
  for (const fn of ['pauseAllFromNotification', 'resumeAllFromNotification']) {
    const b = body(fn);
    const guard = b.indexOf('engineReadyForAction(');
    const work = b.search(/pauseAll\(\)|resumeAll\(\)/);
    if (!(guard >= 0 && work > guard)) { console.error(`  FAIL ${fn} starts the engine before acting`); process.exitCode = 1; }
    else console.log(`  ok   ${fn} starts the engine before acting`);
  }
  if (!/private fun engineReadyForAction[\s\S]*?ensureStarted\(\)/.test(host)) { console.error('  FAIL engineReadyForAction uses ensureStarted (lifecycle lock)'); process.exitCode = 1; }
  else console.log('  ok   engineReadyForAction uses ensureStarted (lifecycle lock)');
}
