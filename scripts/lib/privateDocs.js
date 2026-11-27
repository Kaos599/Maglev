// Some tests compare the code with notes kept in a separate private repository, checked out into docs/
// (gitignored). A public checkout (CI or an outside contributor's clone) has no docs/ at all. Tests read those
// notes through here: on a machine with docs/ the checks run; without docs/ they are skipped with a note, and the
// code checks in the same test still run. A checkout that has docs/ but is missing the file itself still fails
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
      if (!noted) console.log(`  skip note checks: the private notes are not in this checkout`);
      noted = true;
      return null;
    }
    throw new Error(`docs/${name} is missing. Check out the private docs repository into docs/.`);
  }
}

module.exports = { readPrivateDoc };
