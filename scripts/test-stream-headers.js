/**
 * Source-level checks for the headers of stream downloads (docs/NATIVE_CONTRACT.md section 24.8, "Request headers").
 * Rust is never compiled locally (CI is the compiler, and runs the #[cfg(test)] tests in fetch.rs), so this reads the
 * sources: the app sends Referer, Origin, the user agent and per-host cookies; the Rust side parses them, keeps them
 * for the life of the download and applies them to every request through one function.
 *
 *   node scripts/test-stream-headers.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n     ${e.message}`);
  }
}

const found = read('components/browser/FoundDownload.tsx');
const types = read('modules/maglev-engine/src/MaglevEngine.types.ts');
const fetchRs = read('native/maglev-core/src/http_dl/stream/fetch.rs');
const driver = read('native/maglev-core/src/http_dl/driver.rs');
const run = read('native/maglev-core/src/http_dl/driver/stream_run.rs');
const sidecar = read('native/maglev-core/src/http_dl/sidecar.rs');
const contract = require('./lib/privateDocs').readPrivateDoc('NATIVE_CONTRACT.md');

check('the app sends Referer, Origin, User-Agent and per-host cookies', () => {
  const fn = found.slice(found.indexOf('export async function downloadHeaders'), found.indexOf('export function FoundDownloadSheet'));
  for (const k of ['headers.Referer', 'headers.Origin', "headers['User-Agent']", 'headers.Cookies', 'headers.Cookie ']) {
    assert(fn.includes(k), `downloadHeaders does not set ${k.trim()}`);
  }
  assert(/getCookies\(u\)/.test(fn), 'the page host cookie is not read');
});

check('the TS options type carries Origin and Cookies', () => {
  assert(/Origin\?: string/.test(types) && /Cookies\?: \{ host: string; cookie: string \}\[\]/.test(types));
});

check('Rust parses Origin and Cookies and keeps them in memory per download', () => {
  assert(/rename = "Origin"/.test(driver) && /rename = "Cookies"/.test(driver));
  assert(/host_cookies: Vec<\(String, String\)>/.test(driver), 'Live has no host_cookies');
  assert(!/host_cookies|origin/.test(sidecar), 'the sidecar must never store them');
});

check('every ReqCtx is built with origin and host_cookies (probe, stored download, refresh)', () => {
  const n = (run.match(/ReqCtx \{/g) || []).length;
  assert.strictEqual(n, 3, `expected 3 ReqCtx builds, found ${n}`);
  assert((run.match(/origin: /g) || []).length >= 3, 'origin missing in a ReqCtx');
  assert((run.match(/host_cookies/g) || []).length >= 6, 'host_cookies missing in a ReqCtx');
  assert(/live\.host_cookies = host_cookies/.test(run) && /live\.origin = h\.origin/.test(run), 'refresh does not update the headers');
});

check('one function picks the cookie by host; the origin-host-only gate is gone', () => {
  assert(/pub fn cookie_for\(/.test(fetchRs));
  assert(/self\.cookie_for\(&host\)/.test(fetchRs));
  assert(/ORIGIN/.test(fetchRs));
  assert(/#\[test\]\s*fn each_host_gets_its_own_cookie/.test(fetchRs));
});

check('cookies are never sent to look-alike hosts (domain boundary)', () => {
  assert(/ends_with\(&format!\("\.\{domain\}"\)\)/.test(fetchRs));
});

check('the contract documents the request headers', () => {
  if (contract === null) return;
  assert(/\*\*Request headers \(2026-11-20\):\*\*/.test(contract));
});

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nall stream header checks passed');
