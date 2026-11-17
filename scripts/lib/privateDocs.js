// The design documents in docs/ live in a separate private repository (docs/ is gitignored), so a public
// checkout (CI or an outside contributor's clone) has no docs/ at all. Tests that compare code with a
// contract document read it through here: on a machine with docs/ the checks run as before; on a checkout
// without docs/ they are skipped with a note, and the code checks in the same test still run, as
// CONTRIBUTING.md describes. A checkout that has docs/ but is missing the document itself still fails
// loudly, so a partial checkout is never mistaken for a pass.
const fs = require('fs');
const path = require('path');

const DOCS = path.join(__dirname, '..', '..', 'docs');
let noted = false;

/** The document's text, or null when docs/ is not checked out on this machine. */
function readPrivateDoc(name) {
  const file = path.join(DOCS, name);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (process.env.CI || !fs.existsSync(DOCS)) {
      if (!noted) console.log(`  skip document checks: docs/ is private and not in this checkout`);
      noted = true;
      return null;
    }
    throw new Error(`docs/${name} is missing. Check out the private docs repository into docs/.`);
  }
}

module.exports = { readPrivateDoc };
