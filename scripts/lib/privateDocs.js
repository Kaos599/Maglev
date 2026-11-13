// The design documents in docs/ live in a separate private repository, so a public checkout (CI) has no docs/.
// Tests that compare code with a contract document read it through here: on a machine with docs/ the checks run
// as before; in CI they are skipped with a note, and the code checks in the same test still run. A developer
// machine without docs/ fails loudly instead, so a missing checkout is never mistaken for a pass.
const fs = require('fs');
const path = require('path');

const DOCS = path.join(__dirname, '..', '..', 'docs');
let noted = false;

/** The document's text, or null in CI when docs/ is not checked out. */
function readPrivateDoc(name) {
  const file = path.join(DOCS, name);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (!process.env.CI) throw new Error(`docs/${name} is missing. Check out the private docs repository into docs/.`);
    if (!noted) console.log(`  skip document checks: docs/ is private and not in this checkout`);
    noted = true;
    return null;
  }
}

module.exports = { readPrivateDoc };
