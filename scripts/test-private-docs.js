#!/usr/bin/env node
// Document checks read the private design documents in docs/ through lib/privateDocs.
// A public checkout has no docs/ at all (docs/ is gitignored and lives in a private repository), and the
// document checks skip with a note so `npm test` still passes, as CONTRIBUTING.md describes. A checkout
// that has docs/ but is missing the document itself fails loudly. Recreates both cases and checks each.

const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const DOCS = path.join(root, 'docs');
const TMP = '.private-docs-test.tmp.md';
const MISSING = 'NO_SUCH_DOCUMENT.md';

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}

function throwsOnMissing() {
  try {
    require('./lib/privateDocs').readPrivateDoc(MISSING);
    return false;
  } catch (e) {
    return true;
  }
}

const hadDocs = fs.existsSync(DOCS);
if (!hadDocs) {
  check('a checkout without docs/ skips a missing document', require('./lib/privateDocs').readPrivateDoc(MISSING) === null);
} else {
  console.log('  skip public-checkout case: this machine has docs/ checked out');
}

if (!hadDocs) fs.mkdirSync(DOCS);
try {
  fs.writeFileSync(path.join(DOCS, TMP), 'contract text');
  check('an existing document is returned', require('./lib/privateDocs').readPrivateDoc(TMP) === 'contract text');
  if (process.env.CI) check('CI skips a missing document even when docs/ is present', require('./lib/privateDocs').readPrivateDoc(MISSING) === null);
  else check('a checkout with docs/ fails loudly on a missing document', throwsOnMissing());
} finally {
  fs.rmSync(path.join(DOCS, TMP), { force: true });
  if (!hadDocs) fs.rmdirSync(DOCS);
}

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll private docs checks passed.');
