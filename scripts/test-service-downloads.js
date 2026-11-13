#!/usr/bin/env node
/**
 * Service keeps running for link downloads (static contract).
 *
 * Bug: the download notification vanished when only link (HTTP) downloads were active after a restart or
 * an app open. headlessStart counted torrents only, summarize ignored the "offline" pause tag, and
 * downloads restored as needs_link were dropped without a word.
 *
 * Checks the Kotlin sources and docs/NATIVE_CONTRACT.md section 8.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const kt = path.join(root, 'modules/maglev-engine/android/src/main/java/com/maglev/engine');
const read = (p) => fs.readFileSync(p, 'utf8');
const host = read(path.join(kt, 'EngineHost.kt'));
const notif = read(path.join(kt, 'service/Notifications.kt'));
const entry = read(path.join(kt, 'RestartEntry.kt'));
const policy = read(path.join(kt, 'RestartPolicy.kt'));
const contract = read(path.join(root, 'docs/NATIVE_CONTRACT.md'));

let failed = 0;
function check(name, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
}

function body(src, re) {
  const m = re.exec(src);
  if (!m) return '';
  let i = src.indexOf('{', m.index + m[0].length - 1);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(i, j + 1);
  }
  return '';
}

const headless = body(host, /fun headlessStart\([^)]*\)\s*\{/);
const poll = body(host, /private fun pollLocked\(\)\s*\{/);
const summarize = body(host, /private fun summarize\([^)]*\)[^{]*\{/);

check('headlessStart is found', headless.length > 0);
check('headlessStart reads the downloads list', /\["downloads"\]/.test(headless));
check(
  'headlessStart counts downloads (shared helper or downloadsAsTransfers)',
  /allTransfers\(|downloadsAsTransfers\(/.test(headless),
);
check('pollLocked uses the same shared helper', /allTransfers\(/.test(poll) && /allTransfers\(/.test(headless));
check('summarize handles the offline pause tag', /(?:"offline"|TAG_OFFLINE)\s*->/.test(summarize));
check('offline counts as a rule pause', /(?:"offline"|TAG_OFFLINE)\s*->\s*\{[^}]*byRules\+\+/.test(summarize));

check('a needs-link notification exists', /fun notifyNeedsLink\(/.test(notif));
check('it says "need(s) a new link"', /new link/.test(notif));
check('EngineHost posts it for needs_link downloads', /"needs_link"/.test(host) && /notifyNeedsLink\(/.test(host));
check('headlessStart posts it too', /needsLink|NeedsLink/.test(headless));

check('app open checks historical exit reasons', /getHistoricalProcessExitReasons/.test(entry));
check('that check is guarded by an SDK version', /SDK_INT\s*(?:>=|<)\s*(?:Build\.VERSION_CODES\.R|30)/.test(entry));
check('it looks for REASON_USER_REQUESTED', /REASON_USER_REQUESTED/.test(entry));

check('RestartPolicy doc covers link downloads', /link download/i.test(policy));
const sec8 = (contract.match(/## 8\. Background survival[\s\S]*?(?=\n## 9\.)/) || [''])[0];
check('NATIVE_CONTRACT section 8 mentions link downloads', /link download/i.test(sec8));
check('section 8 mentions offline', /offline/i.test(sec8));

process.exit(failed ? 1 : 0);
