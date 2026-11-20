#!/usr/bin/env node
// LINK_REFUSED (NATIVE_CONTRACT 17, 2026-11-20): a 403 with no sign-in details is "the site refused this link", not a
// sign-in. Checks the TS mapping, the copy, the action, the auto-retry exclusion and the Rust source shape. The Rust
// behaviour itself runs under `cargo test` in CI (http_dl/driver.rs `link_refused_tests`).
// Needs Node 22.18+ (runs the TypeScript source directly).
process.removeAllListeners('warning');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const KT = 'modules/maglev-engine/android/src/main/java/com/maglev/engine/';

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}

async function main() {
  const copy = await import('../utils/downloadCopy.ts');

  const REFUSED = 'The site refused this link. Open its page again, then retry.';
  const PROBE = "The site refused this link. Open the page in Maglev's browser and start the download from there, or paste a fresh link.";
  const d = (over) => ({
    id: 'dl1', urlDisplay: 'https://x.test/a.bin', name: 'a.bin', state: 'needs_link', pausedBy: null, size: 100, downloaded: 10,
    downBps: 0, eta: -1, segmentsActive: 0, resumable: true, folder: '/d', addedAt: 1, error: null, ...over,
  });
  const refused = d({ error: { code: 'LINK_REFUSED', message: 'raw', httpStatus: 403 } });
  const auth = d({ error: { code: 'AUTH_REQUIRED', message: 'raw', httpStatus: 401 } });

  console.log('types');
  const types = read('modules/maglev-engine/src/MaglevEngine.types.ts');
  check('LINK_REFUSED is an engine error code', /\|\s*'LINK_REFUSED'/.test(types));
  check('LINK_REFUSED is a download error code', /Extract<[\s\S]{0,200}'LINK_REFUSED'/.test(types));

  console.log('card and sheet copy');
  check('card lead mirrors the sign-in lead', copy.downloadStatus(refused).lead === 'Site refused · Paste new link', copy.downloadStatus(refused).lead);
  check('sign-in lead is unchanged for a 401', copy.downloadStatus(auth).lead === 'Needs sign-in · Paste new link');
  check('card is danger', JSON.stringify(copy.downloadStatus(refused)).includes('danger'));
  check('caption is the refused body', copy.downloadCaption(refused) === REFUSED, copy.downloadCaption(refused));
  check('sign-in caption is unchanged', /sign in/.test(copy.downloadCaption(auth) || ''));
  check('why-it-stopped block', copy.linkProblem(refused).title === 'Site refused' && copy.linkProblem(refused).body === REFUSED);
  check('probe body is exact', copy.probeErrorView('LINK_REFUSED', 'x', 403).body === PROBE);
  check('probe offers a fresh link', copy.probeErrorView('LINK_REFUSED', 'x', 403).primary === 'pasteAnother');
  check('probe sign-in copy is unchanged', /wants you to sign in/.test(copy.probeErrorView('AUTH_REQUIRED', 'x', 401).body));

  console.log('action');
  const acts = copy.downloadActions(refused).map((a) => a.kind);
  check('needs_link offers Paste new link', acts.length === 1 && acts[0] === 'newLink', acts.join(','));
  check('Paste new link opens the page (refreshDownloadUrl path)', copy.downloadActions(refused)[0].label === 'Paste new link');
  const asError = d({ state: 'error', error: { code: 'LINK_REFUSED', message: 'raw', httpStatus: 403 } });
  check('an error-state refusal also asks for a new link', copy.downloadActions(asError)[0].kind === 'newLink' && copy.needsNewLink(asError));
  check('an error-state refusal reads as the refused text', copy.downloadStatus(asError).lead === REFUSED, copy.downloadStatus(asError).lead);

  console.log('assistant');
  const runner = read('utils/assistant/toolRunner.ts');
  check('plain error text', runner.includes("case 'LINK_REFUSED': return '" + REFUSED + "'"));
  check('explain_error gives a fix', /LINK_REFUSED' \? \['Open the page again/.test(runner));

  console.log('auto-retry');
  const w = read(KT + 'AutoRetryWorker.kt').replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '');
  check('worker never retries LINK_REFUSED', !/"LINK_REFUSED"/.test(w));
  check('worker retries only the listed codes', /"NETWORK"/.test(w) && /"STALLED"/.test(w) && /"HTTP_STATUS"/.test(w));
  check('worker documents it', /LINK_REFUSED/.test(read(KT + 'AutoRetryWorker.kt')));

  console.log('mock engine');
  const mock = read('modules/maglev-engine/src/MaglevMockDownloads.ts');
  check('mock: 401 is sign-in', /includes\('auth'\)\) return \{ code: 'AUTH_REQUIRED'[^}]*httpStatus: 401/.test(mock));
  check('mock: refused link is a 403 LINK_REFUSED', /includes\('refused'\)\) return \{ code: 'LINK_REFUSED'[^}]*httpStatus: 403/.test(mock));

  console.log('Rust');
  const err = read('native/maglev-core/src/error.rs');
  check('error code serialises to LINK_REFUSED', /LinkRefused/.test(err) && /ErrorCode::LinkRefused => "LINK_REFUSED"/.test(err));
  const rules = read('native/maglev-core/src/http_dl/rules.rs');
  check('probe: 401 is Auth, 403 is Refused', /401 => ProbeVerdict::Auth/.test(rules) && /403 => ProbeVerdict::Refused/.test(rules));
  const drv = read('native/maglev-core/src/http_dl/driver.rs');
  check('needs_link_info splits 401 / 403 by the login in the link', /fn needs_link_info\(status: Option<u16>, needs_login: bool, link_login: bool\)/.test(drv) && /"LINK_REFUSED"/.test(drv));
  check('browser cookies never set link_login', /rec\.link_login = auth\.is_some\(\);/.test(drv) && !/link_login = [^;]*cookie/.test(drv));
  check('probe error maps to LinkRefused', /ErrorCode::LinkRefused/.test(drv));
  check('direct files share one header set (probe, GET, segments)', /LinkHeaders::from_live/.test(drv) && /fn probe_request\([\s\S]{0,200}hdrs: &LinkHeaders/.test(drv) && /LinkHeaders::from_live/.test(read('native/maglev-core/src/http_dl/driver/segments.rs')));
  check('origin is sent', /b = b\.header\(ORIGIN, o\)/.test(drv));
  check('cookie picked by host with the stream rule', /pick_cookie\(&self\.host_cookies/.test(drv) && /pub\(crate\) fn pick_cookie/.test(read('native/maglev-core/src/http_dl/stream/fetch.rs')));
  const sr = read('native/maglev-core/src/http_dl/driver/stream_run.rs');
  check('streams: 401 Auth, 403 Refused', /Status\(401, _\) => ProbeFail::Auth\(401\)/.test(sr) && /Status\(403, _\) => ProbeFail::Refused\(403\)/.test(sr));
  check('Rust tests exist', /mod link_refused_tests/.test(drv) && /a_403_is_a_refused_link_unless_the_link_carried_a_login/.test(drv));

  if (failed) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall link-refused checks passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
