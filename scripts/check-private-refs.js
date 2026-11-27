#!/usr/bin/env node
// Flags new lines that point at the maintainer's private planning documents instead of saying the rule.
// Those documents are not in this repository, so "see the contract, section 3.2" tells a reader nothing.
// A comment, doc or test label should state the rule itself in a sentence or two; git history keeps
// the link to where it came from.
//
//   node scripts/check-private-refs.js               check lines added since the branch left its base
//   node scripts/check-private-refs.js --base <ref>  same, against another base (a branch or a commit)
//   node scripts/check-private-refs.js --all         list every match in tracked files (report only, exits 0)
//
// The base is --base, else origin/$GITHUB_BASE_REF (set on pull request runs), else origin/dev.
// Diff mode compares the merge base with the working tree and also reads untracked files, so it
// gives the same answer before and after you commit. In CI the tree is clean, so that is base...HEAD.
// Renames are detected, so moving a file adds no lines; only lines that changed are read.
//
// Not flagged:
//   - .gitignore, and this script (it has to spell the pattern out);
//   - in handbook/, the folder name on its own in `backticks` (`docs/`, `docs/ folder`), where a page
//     explains that the folder is private. A quoted file name inside it still counts. Also the words
//     "phone check", which the handbook uses for the practice rather than a dated event;
//   - links and URIs to other places (a public "/docs/" URL is fine); links into this repository still count;
//   - a line marked `private-ref-ok`, for code that really reads a file from the private docs folder
//     and skips when it is missing. Say why on the same line.
// No dependencies, so it runs on a bare checkout.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const SELF = 'scripts/check-private-refs.js';

// Each pattern is narrow on purpose: a public RFC or spec citation ("section 4.2 of RFC 9110") must not trip it,
// so there is no general "section N" pattern.
const PATTERN = new RegExp(
  [
    '[Dd][Oo][Cc][Ss][/\\\\]', // the private notes folder, with either slash
    '[Nn][Aa][Tt][Ii][Vv][Ee][_ -][Cc][Oo][Nn][Tt][Rr][Aa][Cc][Tt]',
    'STATE[_ -]MACHINES',
    'ROADMAP',
    '[Aa][Rr][Cc][Hh][Ii][Tt][Ee][Cc][Tt][Uu][Rr][Ee][_ -][Aa][Nn][Dd][_ -][Gg][Oo][Aa][Ll]',
    'RELEASE_SIGNING',
    'LEDGER',
    '[Ll][Ee][Dd][Gg][Ee][Rr]\\.[Mm][Dd]',
    '§ ?[0-9]', // section numbers
    '\\bP[0-2]-[0-9]', // task IDs
    '\\bSM-?[0-9]', // state-machine IDs
    '\\bUX-[0-9]{3}', // UX task IDs
    '\\bW-[A-Z]\\b', // work-wave names
    '(?<![\\w-])[Ww]ave ?[0-9]', // "wave 3", but not a file name such as test-wave2-edge
    '[Rr]eview round ?[0-9]',
    '[Oo]wner[ ,:(]*20[0-9]{2}', // "owner, 2026-…"
    '[Oo]wner (?:decision|pick|rule|asked)',
    'phone check',
    '[Cc]ontract [0-9]',
    '\\b[Cc]ontract [A-Z]-[A-Z0-9]', // "contract C-ENG-1"
    '\\(20[0-9]{2}-[0-9]{2}-[0-9]{2}\\)', // a bare date in brackets
  ].join('|'),
  'g',
);
// In handbook/, a backtick span that is only the folder name, maybe with a plain word after it.
const FOLDER_SPAN = /^`docs\/?(?: (?:folder|directory))?`$/;
// Any scheme, so a content:// or file:// test value is treated like a web link.
const URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s)\]>'"`]+/gi;
const OWN_REPO = /github\.com\/Kaos599\/Maglev\b/i;
const MARKER = 'private-ref-ok';

function git(args) {
  // quotepath=off keeps non-ASCII file names as they are instead of octal escapes.
  return execFileSync('git', ['-c', 'core.quotepath=off', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function skipFile(file) {
  return file === '.gitignore' || file.endsWith('/.gitignore') || file === SELF;
}

/** The matches on one line that count, after the exceptions above. */
function matchesIn(file, line) {
  if (line.includes(MARKER)) return [];
  let text = line.replace(URL, (url) => (OWN_REPO.test(url) ? url : ' '.repeat(url.length)));
  const handbook = file.startsWith('handbook/');
  if (handbook) text = text.replace(/`[^`]*`/g, (span) => (FOLDER_SPAN.test(span) ? ' '.repeat(span.length) : span));
  return [...text.matchAll(PATTERN)].map((m) => m[0]).filter((m) => !(handbook && m === 'phone check'));
}

function isBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

function readText(file) {
  const abs = path.join(root, file);
  let buf;
  try {
    if (!fs.statSync(abs).isFile()) return null;
    buf = fs.readFileSync(abs);
  } catch {
    return null; // deleted in the working tree, or a submodule
  }
  return isBinary(buf) ? null : buf.toString('utf8');
}

function scanWholeFile(file, hits) {
  if (skipFile(file)) return;
  const text = readText(file);
  if (text == null) return;
  text.split('\n').forEach((line, i) => {
    const found = matchesIn(file, line);
    if (found.length) hits.push({ file, line: i + 1, text: line.trim(), found });
  });
}

/** NUL-separated output from `git ... -z`, so a file name with a space or newline stays one name. */
function gitFiles(args) {
  return git([...args, '-z']).split('\0').filter(Boolean);
}

/** A path from a "+++ b/..." diff header. Git wraps one in quotes, C-style, when it has a quote or control character. */
function headerPath(raw) {
  let p = raw.slice(4);
  if (p.startsWith('"')) {
    try {
      p = JSON.parse(p);
    } catch {
      p = p.slice(1, -1);
    }
  }
  return p.slice(2); // strip "b/"
}

function resolveBase(argv) {
  const i = argv.indexOf('--base');
  if (i !== -1) {
    const ref = argv[i + 1];
    if (!ref || ref.startsWith('-')) fail('--base needs a branch or commit after it, for example --base origin/dev.');
    return ref;
  }
  if (process.env.GITHUB_BASE_REF) return `origin/${process.env.GITHUB_BASE_REF}`;
  return 'origin/dev';
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

/** Lines added between the merge base and the working tree, plus every line of untracked files. */
function addedLines(base) {
  let mergeBase;
  try {
    mergeBase = git(['merge-base', base, 'HEAD']).trim();
  } catch {
    fail(
      `Can't find where this branch left ${base}. Fetch it first (git fetch origin), or pass --base <branch>.\n` +
        'In GitHub Actions, check out with fetch-depth: 0.',
    );
  }
  const diff = git([
    'diff', '--unified=0', '--no-color', '--no-ext-diff', '-M',
    '--src-prefix=a/', '--dst-prefix=b/', mergeBase,
  ]);
  const hits = [];
  let file = null;
  let inHeader = false; // an added line can itself start with "++", so only read "+++" in a file header
  let lineNo = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      inHeader = true;
      file = null;
      continue;
    }
    if (inHeader && raw.startsWith('+++ ')) {
      file = raw === '+++ /dev/null' ? null : headerPath(raw);
      continue;
    }
    if (raw.startsWith('@@')) {
      inHeader = false;
      const m = /\+(\d+)/.exec(raw);
      lineNo = m ? Number(m[1]) : 0;
      continue;
    }
    if (!file || !raw.startsWith('+') || skipFile(file)) continue;
    const line = raw.slice(1);
    const found = matchesIn(file, line);
    if (found.length) hits.push({ file, line: lineNo, text: line.trim(), found });
    lineNo++;
  }
  const untracked = gitFiles(['ls-files', '--others', '--exclude-standard']);
  for (const f of untracked) scanWholeFile(f, hits);
  return { hits, mergeBase };
}

function print(hits) {
  for (const h of hits) {
    const shown = h.text.length > 140 ? `${h.text.slice(0, 137)}...` : h.text;
    console.log(`${h.file}:${h.line}  [${[...new Set(h.found)].join(', ')}]  ${shown}`);
  }
}

function main(argv) {
  if (argv.includes('--all')) {
    const hits = [];
    for (const f of gitFiles(['ls-files'])) scanWholeFile(f, hits);
    print(hits);
    const files = new Set(hits.map((h) => h.file)).size;
    console.log(`\n${hits.length} line(s) in ${files} file(s) point at private documents. Report only.`);
    return 0;
  }

  const base = resolveBase(argv);
  const { hits, mergeBase } = addedLines(base);
  if (hits.length) {
    print(hits);
    console.error(
      `\n${hits.length} added line(s) point at private planning documents that aren't in this repository.\n` +
        'Write the rule itself in a sentence instead, for example:\n' +
        '  before: // Pause on metered networks (see the contract, section 4.2)\n' +
        "  after:  // Pause on metered networks: people on a capped plan shouldn't lose data to seeding.\n" +
        `If the line really reads a file from the private docs folder, add "${MARKER}" and the reason on that line.`,
    );
    return 1;
  }
  console.log(`No private references in lines added since ${base} (${mergeBase.slice(0, 7)}).`);
  return 0;
}

// exitCode rather than process.exit(), so a long report piped to another program isn't cut off.
process.exitCode = main(process.argv.slice(2));
