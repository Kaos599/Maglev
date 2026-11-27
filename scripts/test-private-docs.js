#!/usr/bin/env node
// Checks that compare code with the private notes read them through lib/privateDocs.
// A public checkout has no private notes (they are notes that aren't in this repository), and those checks skip with a
// note so `npm test` still passes. A checkout that has the notes folder but is missing the file itself fails
// loudly. Recreates both cases and checks each.

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
  check('a checkout without the notes folder skips a missing document', require('./lib/privateDocs').readPrivateDoc(MISSING) === null);
} else {
  console.log('  skip public-checkout case: this machine has the notes folder checked out');
}

if (!hadDocs) fs.mkdirSync(DOCS);
try {
  fs.writeFileSync(path.join(DOCS, TMP), 'contract text');
  check('an existing document is returned', require('./lib/privateDocs').readPrivateDoc(TMP) === 'contract text');
  if (process.env.CI) check('CI skips a missing document even when the notes folder is present', require('./lib/privateDocs').readPrivateDoc(MISSING) === null);
  else check('a checkout with the notes folder fails loudly on a missing document', throwsOnMissing());
} finally {
  fs.rmSync(path.join(DOCS, TMP), { force: true });
  if (!hadDocs) fs.rmdirSync(DOCS);
}

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll private docs checks passed.');
