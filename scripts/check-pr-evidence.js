#!/usr/bin/env node
'use strict';
// Warns when a pull request description leaves the evidence sections of the template empty.
//
// Input (all optional except the body):
//   PR_BODY env, or --body-file <path>   the pull request description
//   --files <path>                       changed files, one per line (default: git diff against the base branch)
//   PR_AUTHOR, PR_LABELS (comma list), PR_DRAFT ("true" skips the check)
//   --strict                             exit 1 when a section is missing (default: always exit 0)
// Output: a GitHub "::warning" line per missing section, plus a Markdown summary in $GITHUB_STEP_SUMMARY.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DOC_LINK = 'https://github.com/Kaos599/Maglev/blob/dev/handbook/verifying.md#11-post-the-evidence';
const SCREEN_DIRS = ['app/', 'components/', 'constants/', 'assets/', 'modules/maglev-engine/android/src/main/res/'];
const SECTIONS = {
  rules: 'rules this keeps',
  check: 'how a reviewer can check it',
  screens: 'screens',
};
const NO_CONTENT = /^(none|n\/a|na|nothing|no visible change|no visible changes|no screen change|tbd|todo|\.{3}|-+)\.?$/i;
const CODE_EXT = /\.(?:kt|ts|tsx|js|jsx|rs|java|json|tla|cfg)$/;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function stripComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, '');
}

// Splits the body into { heading-key: text } for the three evidence sections, matching headings by prefix.
function readSections(body) {
  const lines = stripComments(body).replace(/\r/g, '').split('\n');
  const out = {};
  let key = null;
  for (const line of lines) {
    const m = /^##\s+(.*?)\s*$/.exec(line);
    if (m) {
      const h = m[1].toLowerCase();
      key = Object.keys(SECTIONS).find((k) => h.startsWith(SECTIONS[k])) || null;
      if (key && !(key in out)) out[key] = [];
      else key = null;
      continue;
    }
    if (/^#{1,6}\s/.test(line) && !/^###/.test(line)) key = null;
    if (key) out[key].push(line);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join('\n')]));
}

// Text left once empty list markers, empty checkboxes, bare "Closes #" style stubs and blank lines are gone.
function realContent(text) {
  return (text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => !/^([-*+]|\d+[.)])?\s*(\[[ xX]?\])?\s*$/.test(l))
    .join(' ')
    .trim();
}

function isEmpty(text) {
  const c = realContent(text);
  return c === '' || NO_CONTENT.test(c);
}

function isBlank(text) {
  return realContent(text) === '';
}

// Paths named in the "Actions and the code they stand for" table of every specs/*/README.md.
function modelCodePaths(root) {
  const paths = new Set();
  const specs = path.join(root, 'specs');
  let dirs = [];
  try { dirs = fs.readdirSync(specs, { withFileTypes: true }); } catch { return paths; }
  for (const d of dirs) {
    if (!d.isDirectory() || d.name.startsWith('_')) continue;
    let md;
    try { md = fs.readFileSync(path.join(specs, d.name, 'README.md'), 'utf8'); } catch { continue; }
    const at = md.search(/^##\s+Actions and the code/im);
    if (at === -1) continue;
    const rest = md.slice(at).split('\n').slice(1);
    for (const line of rest) {
      if (/^##\s/.test(line)) break;
      if (!line.startsWith('|')) continue;
      const cells = line.split('|');
      const codeCell = cells.slice(2).join('|');
      for (const m of codeCell.matchAll(/`([^`]+)`/g)) {
        const tok = m[1].trim();
        if (CODE_EXT.test(tok) && !/\s/.test(tok)) paths.add(tok);
      }
    }
  }
  return paths;
}

function touchesModelCode(files, codePaths) {
  return files.some((f) => {
    for (const p of codePaths) {
      if (p.includes('/') ? f === p || f.startsWith(p) : path.posix.basename(f) === p) return true;
    }
    return false;
  });
}

function changedFiles(root) {
  const file = arg('--files');
  if (file) return fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  const base = process.env.GITHUB_BASE_REF || 'dev';
  try {
    return execFileSync('git', ['diff', '--name-only', `origin/${base}...HEAD`], { cwd: root, encoding: 'utf8' })
      .split('\n').map((l) => l.trim()).filter(Boolean);
  } catch (e) {
    console.log(`::notice title=PR evidence::Could not list changed files (${String(e.message).split('\n')[0]}), so the check only looked at the description.`);
    return [];
  }
}

function evaluate({ body, files, author, labels, draft, codePaths }) {
  if (draft) return { skipped: 'This is a draft pull request.', missing: [] };
  if (/\[bot\]$/i.test(author || '')) return { skipped: `${author} is a bot.`, missing: [] };

  const sections = readSections(body);
  const missing = [];
  const uiFiles = files.filter((f) => SCREEN_DIRS.some((d) => f.startsWith(d)));
  const specFiles = files.filter((f) => f.startsWith('specs/'));
  const modelCode = touchesModelCode(files, codePaths);
  const needsModel = labels.includes('needs-model');

  if (isEmpty(sections.check)) {
    missing.push('"How a reviewer can check it" is empty. Add the commands you ran with the lines of output that matter, and phone steps someone else can repeat.');
  }
  if (uiFiles.length && isEmpty(sections.screens)) {
    missing.push(`"Screens" is empty, but this change touches ${uiFiles.length} file(s) that show on screen (for example ${uiFiles[0]}). Add before and after screenshots or a short recording. "none" is only right when nothing on screen changed.`);
  }
  if ((specFiles.length || modelCode || needsModel) && isBlank(sections.rules)) {
    const why = specFiles.length ? 'changes specs/' : modelCode ? 'changes code that a state-machine model covers' : 'has the needs-model label';
    missing.push(`"Rules this keeps" is empty, but this change ${why}. List what must stay true after it, or link the model and name its invariants.`);
  }
  return { skipped: null, missing, sections: { screensNeeded: uiFiles.length > 0 } };
}

function main() {
  const root = process.cwd();
  const bodyFile = arg('--body-file');
  const body = bodyFile ? fs.readFileSync(bodyFile, 'utf8') : process.env.PR_BODY || '';
  const strict = process.argv.includes('--strict');
  const labels = (process.env.PR_LABELS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const draft = String(process.env.PR_DRAFT || '').toLowerCase() === 'true';
  const author = process.env.PR_AUTHOR || '';
  const skipEarly = draft || /\[bot\]$/i.test(author);
  const files = skipEarly ? [] : changedFiles(root);

  const result = evaluate({ body, files, author, labels, draft, codePaths: modelCodePaths(root) });

  const summary = [];
  if (result.skipped) {
    console.log(`PR evidence check skipped: ${result.skipped}`);
    summary.push('### PR evidence', '', `Skipped: ${result.skipped}`);
  } else if (!result.missing.length) {
    console.log('PR evidence check passed.');
    summary.push('### PR evidence', '', 'The evidence sections are filled in.');
  } else {
    for (const m of result.missing) {
      const msg = `${m} How to fill it in: ${DOC_LINK}`.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
      console.log(`::warning title=PR evidence::${msg}`);
    }
    summary.push('### PR evidence', '', 'Reviewers will ask for these before they look at the code:', '');
    for (const m of result.missing) summary.push(`- ${m}`);
    summary.push('', `How to fill them in: [Post the evidence](${DOC_LINK}). This check only warns; it does not block the merge.`);
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join('\n') + '\n'); } catch { /* summary is optional */ }
  }
  process.exit(strict && result.missing.length ? 1 : 0);
}

if (require.main === module) main();
module.exports = { readSections, realContent, isEmpty, evaluate, modelCodePaths };
