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
//
// Not flagged:
//   - .gitignore, and this script (it has to spell the pattern out);
//   - in handbook/, a match inside `backticks`, where a page quotes the pattern to explain it, and the
//     words "phone check", which the handbook uses for the practice rather than a dated event;
//   - links to other sites (a public "/docs/" URL is fine); links into this repository still count;
//   - a line marked `private-ref-ok`, for code that really reads a file from the private docs folder
//     and skips when it is missing. Say why on the same line.
// No dependencies, so it runs on a bare checkout.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const SELF = 'scripts/check-private-refs.js';

const PATTERN = new RegExp(
  [
    'docs/',
    'NATIVE_CONTRACT',
    'STATE_MACHINES',
    'ROADMAP',
    'ARCHITECTURE_AND_GOAL',
    'RELEASE_SIGNING',
    'LEDGER',
    '§ ?[0-9]', // section numbers
    '\\bP[0-2]-[0-9]', // task IDs
    '\\bW-[A-Z]\\b', // work-wave names
    '[Oo]wner[ ,:(]*20[0-9]{2}', // "owner, 2026-…"
    'phone check',
    'contract [0-9]',
    '\\(20[0-9]{2}-[0-9]{2}-[0-9]{2}\\)', // a bare date in brackets
  ].join('|'),
  'g',
);
const URL = /https?:\/\/[^\s)\]>'"`]+/g;
const OWN_REPO = /github\.com\/Kaos599\/Maglev\b/i;
const MARKER = 'private-ref-ok';

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function skipFile(file) {
  return file === '.gitignore' || file.endsWith('/.gitignore') || file === SELF;
}

/** The matches on one line that count, after the exceptions above. */
function matchesIn(file, line) {
  if (line.includes(MARKER)) return [];
  let text = line.replace(URL, (url) => (OWN_REPO.test(url) ? url : ' '.repeat(url.length)));
  const handbook = file.startsWith('handbook/');
  if (handbook) text = text.replace(/`[^`]*`/g, (span) => ' '.repeat(span.length));
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

function resolveBase(argv) {
  const i = argv.indexOf('--base');
  if (i !== -1) {
    if (!argv[i + 1]) fail('--base needs a branch or commit after it.');
    return argv[i + 1];
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
    'diff', '--unified=0', '--no-color', '--no-ext-diff', '--no-renames',
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
      file = raw === '+++ /dev/null' ? null : raw.slice(6); // strip "+++ b/"
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
  const untracked = git(['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean);
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
    for (const f of git(['ls-files']).split('\n').filter(Boolean)) scanWholeFile(f, hits);
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
