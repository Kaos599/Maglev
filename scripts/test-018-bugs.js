#!/usr/bin/env node
/**
 * 0.18 bug contracts.
 *  1. Cold-start share: an engine call made while a start is in flight (or announced by expectStart) waits for it
 *     (up to MaglevEngineBridge.startWaitMs). A call made before any start still fails fast. No mock fallback in a
 *     release build.
 *  2. runPendingMuxes is covered by the JVM test (see scripts section at the end for the static link).
 *
 *   node scripts/test-018-bugs.js
 */
const fs = require('fs');
const path = require('path');
const { register } = require('node:module');

const root = path.join(__dirname, '..');
let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : '  ' + JSON.stringify(detail)}`);
  if (!ok) failed++;
}

// Fake native module: init settles when the test says so.
const calls = [];
let initGate = null;
let initResult = { ok: true };
const native = {
  addListener: () => ({ remove() {} }),
  init: async () => {
    calls.push('init');
    if (initGate) await initGate.promise;
    return initResult;
  },
  setGovernance: async () => ({ ok: true }),
  setGlobalLimits: async () => ({ ok: true }),
  resolveMetadata: async (src) => {
    calls.push('resolveMetadata');
    return { ok: true, infoHash: 'abc', src };
  },
};
const gate = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

register(
  'data:text/javascript,' +
    encodeURIComponent(
      `export async function resolve(s,c,n){ if(s==='expo-modules-core') return {url:'data:text/javascript,'+encodeURIComponent('export const Platform=globalThis.__fake.Platform;export const requireOptionalNativeModule=()=>globalThis.__fake.native;'),shortCircuit:true}; return n(s,c);}`
    )
);
globalThis.__DEV__ = false; // release: no simulator
globalThis.__fake = { Platform: { OS: 'android' }, native };

(async () => {
  const { MaglevEngineBridge } = await import('../modules/maglev-engine/src/MaglevNativeBridge.ts');
  const { DEFAULT_SETTINGS } = await import('../modules/maglev-engine/src/MaglevSettings.types.ts');
  MaglevEngineBridge.startWaitMs = 300;
  const reset = () => {
    calls.length = 0;
    initGate = null;
    initResult = { ok: true };
  };

  // A. before any start: fail fast
  reset();
  {
    const b = new MaglevEngineBridge();
    const t = Date.now();
    const r = await b.resolveMetadata('magnet:?xt=urn:btih:x', 1000);
    check('A: call before any start fails fast with NOT_INITIALIZED', !r.ok && r.code === 'NOT_INITIALIZED' && Date.now() - t < 100, r);
    check('A: the native method was not called', !calls.includes('resolveMetadata'));
  }

  // B. start in flight: the call waits and succeeds
  reset();
  {
    initGate = gate();
    const b = new MaglevEngineBridge();
    const starting = b.start(DEFAULT_SETTINGS);
    const pending = b.resolveMetadata('magnet:?xt=urn:btih:x', 1000);
    await sleep(30);
    check('B: the call has not run while init is in flight', !calls.includes('resolveMetadata'));
    initGate.resolve();
    const r = await pending;
    await starting;
    check('B: the call runs after start and succeeds', r.ok === true && calls.indexOf('resolveMetadata') > calls.indexOf('init'), r);
  }

  // C. expectStart() then a later start(): the call waits through the gap (cached boot defers the start one frame)
  reset();
  {
    const b = new MaglevEngineBridge();
    b.expectStart();
    const pending = b.resolveMetadata('magnet:?xt=urn:btih:x', 1000);
    await sleep(30);
    check('C: the call waits while the start is only announced', !calls.includes('resolveMetadata'));
    void b.start(DEFAULT_SETTINGS);
    const r = await pending;
    check('C: the call succeeds once start() ran', r.ok === true, r);
  }

  // D. start never settles: the call gives up after startWaitMs
  reset();
  {
    initGate = gate();
    const b = new MaglevEngineBridge();
    void b.start(DEFAULT_SETTINGS);
    const t = Date.now();
    const r = await b.resolveMetadata('magnet:?xt=urn:btih:x', 1000);
    const dt = Date.now() - t;
    check('D: a hung start times out the call instead of hanging', !r.ok && dt >= 250 && dt < 2000, { r, dt });
    initGate.resolve();
  }

  // E. announced but never started: times out
  reset();
  {
    const b = new MaglevEngineBridge();
    b.expectStart();
    const t = Date.now();
    const r = await b.resolveMetadata('x', 1000);
    check('E: an announced start that never comes times out', !r.ok && Date.now() - t >= 250, r);
  }

  // F. start fails (engine unavailable) in release: the call fails with the reason, no simulator data
  reset();
  {
    initResult = { ok: false, code: 'ENGINE_UNAVAILABLE', message: 'no lib' };
    initGate = gate();
    const b = new MaglevEngineBridge();
    const starting = b.start(DEFAULT_SETTINGS);
    const pending = b.resolveMetadata('x', 1000);
    initGate.resolve();
    const r = await pending;
    await starting;
    check('F: failed start in release: the call fails, no mock fallback', !r.ok && !b.isNativeMode() && b.engineStatus.kind === 'unavailable', r);
  }

  // G. already running: no extra wait
  reset();
  {
    const b = new MaglevEngineBridge();
    await b.start(DEFAULT_SETTINGS);
    const t = Date.now();
    const r = await b.resolveMetadata('x', 1000);
    check('G: a call on a running engine is immediate', r.ok === true && Date.now() - t < 100, r);
  }

  // H. wiring
  const ctx = fs.readFileSync(path.join(root, 'context/EngineContext.tsx'), 'utf8');
  check('H: EngineProvider announces the start on its first render', /maglevEngine\.expectStart\(\)/.test(ctx));

  if (failed) {
    console.log(`\n${failed} failed`);
    process.exit(1);
  }
  console.log('\nall 0.18 bug checks passed');
})();
