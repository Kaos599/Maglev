#!/usr/bin/env node
// 0.27 Failed sources: a 503 maintenance page is an outage, not a bot check; the results line says how many
// sources did not respond; tapping it lists them with a plain reason. Needs Node 22.18+ (runs TypeScript directly).
process.removeAllListeners('warning');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}

(async () => {
  const http = await import('../utils/search/http.ts');
  const ans = await import('../utils/search/answered.ts');
  const maintenance = fs.readFileSync(path.join(root, 'scripts/fixtures/search/gutenberg_maintenance_503.html'), 'utf8');
  const cfBody = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/h/b"></script></body></html>';
  const ddosBody = '<!DOCTYPE html><html><head><title>DDOS-GUARD</title></head><body>Checking your browser</body></html>';
  const opts = { signal: new AbortController().signal, accept: 'text/html' };
  const attempt = async (status, body, headers) => {
    globalThis.fetch = async () => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
    try {
      await http.httpText('https://www.gutenberg.org/', opts);
    } catch (e) {
      return e;
    }
    return null;
  };

  // 1. Outage vs bot check.
  let e = await attempt(503, maintenance, { 'retry-after': '3600' });
  check('503 maintenance page is an outage (http), not blocked', e && e.kind === 'http' && e.status === 503, e && e.kind);
  check('503 maintenance is retryable', e && e.retryable === true);
  check('503 maintenance says "Down for maintenance"', e && e.message === 'Down for maintenance', e && e.message);
  e = await attempt(502, '<html><body>Bad gateway</body></html>');
  check('502 is an outage: "Not answering right now"', e && e.kind === 'http' && e.status === 502 && e.message === 'Not answering right now' && e.retryable);
  e = await attempt(504, '<html><body>Gateway timeout</body></html>');
  check('504 is an outage', e && e.kind === 'http' && e.status === 504 && e.retryable);
  e = await attempt(503, cfBody, { server: 'cloudflare' });
  check('503 with Cloudflare challenge markers stays a challenge', e && e.kind === 'challenge', e && e.kind);
  e = await attempt(503, ddosBody, { server: 'ddos-guard' });
  check('503 with DDoS-Guard markers stays a bot check', e && e.kind === 'blocked', e && e.kind);
  e = await attempt(403, '<html><body>Forbidden</body></html>');
  check('plain 403 HTML is still a bot check', e && e.kind === 'blocked');

  // 2. Reasons.
  const st = (state, message) => ({ providerId: state, state, count: 0, ms: 0, message });
  const why = ans.unansweredReason;
  check('reason: timeout', why(st('timeout', 'No answer in 8s')) === "Didn't answer in time");
  check('reason: blocked', why(st('blocked', 'Blocked by a bot check')) === 'Blocked by a bot check');
  check('reason: challenge', why(st('challenge', 'Needs a quick check')) === 'Needs a quick check');
  check('reason: maintenance', why(st('error', 'Down for maintenance')) === 'Down for maintenance');
  check('reason: 502/504', why(st('error', 'Not answering right now')) === 'Not answering right now');
  check('reason: network', why(st('error', 'Network request failed')) === 'No connection');
  check('reason: unknown error', why(st('error', 'Unexpected response')) === "Didn't respond");

  // 3. Summary line.
  const tally = (...states) => ans.tallySources(states.map((s, i) => ({ ...st(s), providerId: `p${i}` })));
  check('summary: all answered, nothing extra', ans.resultsSummary(84, tally('done', 'empty'), false) === '84 results');
  check('summary: one result', ans.resultsSummary(1, tally('done'), false) === '1 result');
  check('summary: one unanswered', ans.resultsSummary(84, tally('done', 'error'), false) === "84 results · 1 didn't respond");
  check('summary: several unanswered', ans.resultsSummary(5, tally('done', 'error', 'timeout', 'blocked'), false) === "5 results · 3 didn't respond");
  check('summary: stopped prefix', ans.resultsSummary(2, tally('done'), true) === 'Stopped · 2 results');
  // The line under the count (owner pick 2026-11-20): how many sources answered, or "No source answered".
  // Nothing when all answered; a quick check counts as not answered (its own hint offers the check).
  const line = (...states) => ans.sourcesLine(tally(...states));
  check('sources line: all answered, none', line('done', 'empty') === null);
  check('sources line: some missing', JSON.stringify(line('done', 'empty', 'error')) === JSON.stringify({ text: '2 of 3 sources', bad: false }));
  check('sources line: a check counts as missing', line('done', 'challenge').text === '1 of 2 sources');
  check('sources line: none answered is red', JSON.stringify(line('error', 'timeout')) === JSON.stringify({ text: 'No source answered', bad: true }));
  check('sources line: no sources, none', line() === null);
  check('allFailed: only when nobody answered', ans.allFailed(tally('error', 'timeout')) && !ans.allFailed(tally('error', 'done')) && !ans.allFailed(tally()));

  // 4. Tap lists the names.
  const list = ans.unansweredSources(
    [
      { ...st('done'), providerId: 'tpb' },
      { ...st('error', 'Down for maintenance'), providerId: 'gutenberg' },
      { ...st('timeout', 'x'), providerId: 'nyaa' },
    ],
    (id) => ({ gutenberg: 'Project Gutenberg', nyaa: 'Nyaa' })[id] ?? id,
  );
  check('list: only sources that did not answer, with names and reasons',
    list.length === 2 && list[0].name === 'Project Gutenberg' && list[0].reason === 'Down for maintenance' && list[1].name === 'Nyaa' && list[1].reason === "Didn't answer in time", JSON.stringify(list));

  // 5. Wiring.
  const screen = read('app/(tabs)/search.tsx');
  check('search screen uses resultsSummary', /resultsSummary\(/.test(screen));
  check('search screen shows sourcesLine under the count, not the long note', /sourcesLine\(tally\)/.test(screen) && /srcLine\.text/.test(screen) && !/`· \$\{unansweredNote\(tally\)\}`/.test(screen));
  check('search screen opens the sheet from the note', /UnansweredSheet/.test(screen) && fs.existsSync(path.join(root, 'components/search/UnansweredSheet.tsx')));
  const sheet = read('components/search/UnansweredSheet.tsx');
  check('sheet reuses Sheet and shows name + reason', /<Sheet\b/.test(sheet) && /\.name/.test(sheet) && /\.reason/.test(sheet));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
