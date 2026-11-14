#!/usr/bin/env node
/**
 * Static checks for the self-updating lists (docs/NATIVE_CONTRACT.md section 31.7): the Kotlin signature check and its
 * embedded key, the conditional ad list requests and the 304 path, the module registration, the TS binding and the
 * pages.yml signing step. Kotlin is never compiled locally (CI is the compiler), so this reads the source.
 *
 *   node scripts/test-lists-native.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const KT = 'modules/maglev-engine/android/src/main/java/com/maglev/engine';
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripKotlinComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

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
const must = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const sig = stripKotlinComments(read(`${KT}/lists/ListSignature.kt`));
const keys = stripKotlinComments(read(`${KT}/lists/ListKeys.kt`));
const store = stripKotlinComments(read(`${KT}/browser/BlocklistStore.kt`));
const mod = stripKotlinComments(read(`${KT}/MaglevEngineModule.kt`));
const pages = read('.github/workflows/pages.yml');

check('ListSignature verifies SHA256withECDSA with an EC key from X509EncodedKeySpec', () => {
  must(/Signature\.getInstance\("SHA256withECDSA"\)/.test(sig), 'no SHA256withECDSA');
  must(/KeyFactory\.getInstance\("EC"\)/.test(sig), 'no EC KeyFactory');
  must(/X509EncodedKeySpec/.test(sig), 'no X509EncodedKeySpec');
  must(/initVerify/.test(sig) && /\.verify\(/.test(sig), 'no initVerify/verify');
});
check('verify never throws and uses the embedded key', () => {
  must(/fun verify\(body: String, sigB64: String\): Boolean/.test(sig), 'signature of verify');
  must(/catch \(_: Throwable\)\s*\{\s*false/.test(sig), 'does not return false on any Throwable');
  must(/ListKeys\.PUBLIC_KEY_SPKI_B64/.test(sig), 'does not use ListKeys');
});
check('the embedded key is the SPKI base64 of a P-256 key', () => {
  const m = keys.match(/PUBLIC_KEY_SPKI_B64 =\s*"([A-Za-z0-9+/=]+)"/);
  must(m, 'no key constant');
  const der = Buffer.from(m[1], 'base64');
  must(der.length === 91 && der[0] === 0x30, 'not a 91-byte P-256 SPKI');
  must(!/PRIVATE/i.test(keys), 'looks like it holds a private key');
});
check('the module registers verifyListSignature and a conditional updateBlocklist', () => {
  must(/AsyncFunction\("verifyListSignature"\)\s*\{\s*body: String, sigB64: String, promise: Promise/.test(mod), 'verifyListSignature');
  must(/ListSignature\.verify\(body, sigB64\)/.test(mod), 'does not call ListSignature.verify');
  must(/AsyncFunction\("updateBlocklist"\)\s*\{\s*urls: List<String>, options: Map<String, Any\?>, promise: Promise/.test(mod), 'updateBlocklist options');
  must(/options\["conditional"\] == true/.test(mod), 'conditional option not read');
  must(/"changed" to changed/.test(mod), 'changed is not in the result');
});
check('the ad list stores ETag and Last-Modified per address and sends them back', () => {
  must(/getHeaderField\("ETag"\)/.test(store) && /getHeaderField\("Last-Modified"\)/.test(store), 'validators not read from the response');
  must(/"If-None-Match"/.test(store) && /"If-Modified-Since"/.test(store), 'conditional headers not sent');
  must(/"validators"/.test(store) && /readValidators/.test(store), 'validators not stored per address');
});
check('304 for every address keeps the list and reports changed:false', () => {
  must(/code == 304/.test(store), 'no 304 handling');
  must(/all \{ it\.body == null \}/.test(store), 'no all-304 check');
  must(/copy\(changed = false\)/.test(store), 'does not return changed:false');
  const early = store.indexOf('copy(changed = false)');
  must(early > 0 && early < store.indexOf('writeAtomic(File(d, FILE)'), 'the all-304 return must come before any write');
});
check('a conditional request is skipped when the stored list is missing', () => {
  must(/conditional && File\(dir\(context\), FILE\)\.isFile/.test(store), 'no check for the stored list');
});
check('an unchanged address is fetched in full when another changed', () => {
  must(/fetch\(u, null\)/.test(store), 'no unconditional refetch');
});
check('the TS binding passes the options and types the result', () => {
  const b = read('modules/maglev-engine/src/MaglevBrowser.tsx');
  must(/updateBlocklist = \(urls: string\[\], options: \{ conditional: boolean \}/.test(b), 'updateBlocklist options');
  must(/changed\?: boolean/.test(b), 'changed type');
  const bridge = read('modules/maglev-engine/src/MaglevNativeBridge.ts');
  must(/'verifyListSignature'/.test(bridge), 'bridge call');
  const mock = read('modules/maglev-engine/src/MaglevMockEngine.ts');
  must(/verifyListSignature\(\): Promise<boolean> \{\s*return false;/.test(mock), 'the mock must verify nothing');
});
check('pages.yml signs only with the secret, and the key never lands under _site', () => {
  must(/LISTS_SIGNING_KEY: \$\{\{ secrets\.LISTS_SIGNING_KEY \}\}/.test(pages), 'secret not wired');
  must(/if: env\.LISTS_SIGNING_KEY != ''/.test(pages), 'step not gated on the secret');
  must(/umask 077/.test(pages), 'no umask 077');
  must(/KEY="\$RUNNER_TEMP\//.test(pages), 'key not in RUNNER_TEMP');
  must(/openssl dgst -sha256 -sign "\$KEY"/.test(pages), 'no openssl sign');
  must(/base64 /.test(pages) && /_site\/lists\/sources\.json\.sig/.test(pages), 'signature not base64-encoded into _site/lists');
  must(/cp lists\/sources\.json _site\/lists\/sources\.json/.test(pages), 'sources.json not copied');
  must(/rm -f "\$KEY"/.test(pages), 'key not deleted');
  const step = pages.slice(pages.indexOf('name: Sign source lists'), pages.indexOf('name: Build F-Droid repo'));
  must(!/>\s*_site[^\n]*\n/.test(step.replace(/base64 -w0[^\n]*/, '')), 'something other than the signature is written under _site');
  must(!/KEY=.*_site/.test(step), 'the key path is under _site');
  must(!/echo [^\n]*LISTS_SIGNING_KEY/.test(step), 'the secret is echoed');
  must(pages.indexOf('name: Sign source lists') > pages.indexOf('Stage site without build sources'), 'signing must come after staging');
  must(/paths: \[[^\]]*'lists\/\*\*'/.test(pages), "'lists/**' not in the push paths");
});
check('the source list ships in lists/ with a README', () => {
  must(fs.existsSync(path.join(ROOT, 'lists/sources.json')) && fs.existsSync(path.join(ROOT, 'lists/README.md')), 'missing files');
});

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll list native checks passed.');
