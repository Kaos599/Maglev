#!/usr/bin/env node
/**
 * Release notes: one file per version in release-notes/<version>.md (see release-notes/README.md).
 *
 *   node scripts/release-notes.js check [version]   validate the notes for app.json's version (or the one given)
 *   node scripts/release-notes.js build <tag>        print the GitHub release text for a tag such as v0.14-beta
 *   node scripts/release-notes.js draft              list commits since the last tag, sorted into the sections
 *
 * A release shows only the sections its file has: What's new, What's changed, What's fixed.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const NOTES_DIR = path.join(root, 'release-notes');
const SECTIONS = ["What's new", "What's changed", "What's fixed"];
const TAGLINE = 'Download anything on Android: videos from web pages, ordinary links and torrents.';

const appVersion = () => JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8')).expo.version;
const notesPath = (version) => path.join(NOTES_DIR, `${version}.md`);

/** Parses a notes file into [{ title, items }]. Returns { sections, errors }. */
function parse(text) {
  const errors = [];
  const sections = [];
  let current = null;
  text.split('\n').forEach((raw, i) => {
    const line = raw.trimEnd();
    if (!line.trim()) return;
    const n = i + 1;
    const h = line.match(/^(#+)\s+(.*)$/);
    if (h) {
      if (h[1] !== '##') return errors.push(`line ${n}: use "## " headings only`);
      if (!SECTIONS.includes(h[2])) return errors.push(`line ${n}: unknown section "${h[2]}" (use ${SECTIONS.join(', ')})`);
      if (sections.some((s) => s.title === h[2])) return errors.push(`line ${n}: "${h[2]}" appears twice`);
      current = { title: h[2], items: [] };
      sections.push(current);
      return;
    }
    if (!current) return errors.push(`line ${n}: text before the first section`);
    if (line.startsWith('- ')) current.items.push(line.slice(2).trim());
    else if (/^\s+\S/.test(raw) && current.items.length) current.items[current.items.length - 1] += ' ' + line.trim();
    else errors.push(`line ${n}: each entry is a "- " line`);
  });
  if (!sections.length) errors.push('no sections: add at least one of ' + SECTIONS.join(', '));
  sections.forEach((s) => { if (!s.items.length) errors.push(`"${s.title}" has no entries; leave the section out instead`); });
  const order = sections.map((s) => SECTIONS.indexOf(s.title));
  if (order.some((v, i) => i > 0 && v < order[i - 1])) errors.push(`sections must be in this order: ${SECTIONS.join(', ')}`);
  return { sections, errors };
}

function load(version) {
  const p = notesPath(version);
  if (!fs.existsSync(p)) return { sections: [], errors: [`missing ${path.relative(root, p)}`] };
  return parse(fs.readFileSync(p, 'utf8'));
}

/** The full release text for a tag like v0.14-beta. */
function build(tag) {
  const version = tag.replace(/^v/, '').replace(/-beta$/, '');
  const { sections, errors } = load(version);
  if (errors.length) throw new Error(`release-notes/${version}.md: ${errors.join('; ')}`);
  const beta = /-beta$/.test(tag) ? ' Beta build.' : '';
  const body = sections.map((s) => `## ${s.title}\n${s.items.map((x) => `- ${x}`).join('\n')}`).join('\n\n');
  return [
    `# Maglev ${tag}`,
    '',
    `${TAGLINE}${beta}`,
    '',
    body,
    '',
    '## Which APK?',
    '- Most phones: `arm64-v8a`.',
    '- Older 32-bit phones: `armeabi-v7a`.',
    '- Not sure: `universal` (larger, works everywhere).',
    '- `x86_64` is for emulators and Chromebooks.',
    '',
    '## Install',
    '1. Download one APK from the Assets list below.',
    '2. Open it on your Android device to install. Installing over an older Maglev keeps your downloads and settings.',
    '3. Allow notifications so downloads keep running in the background.',
    '',
  ].join('\n');
}

function draft() {
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
  let since = '';
  try { since = git('describe', '--tags', '--abbrev=0', '--match', 'v*'); } catch { /* no tags yet */ }
  const log = git('log', '--no-merges', '--format=%s', since ? `${since}..HEAD` : 'HEAD');
  const buckets = { "What's new": [], "What's changed": [], "What's fixed": [] };
  for (const s of log.split('\n').filter(Boolean)) {
    const m = s.match(/^(\w+)(\([^)]*\))?!?:\s*(.*)$/);
    const kind = m ? m[1] : '';
    if (['test', 'ci', 'chore', 'docs', 'build'].includes(kind)) continue;
    const text = m ? m[3] : s;
    const key = kind === 'feat' ? "What's new" : kind === 'fix' ? "What's fixed" : "What's changed";
    buckets[key].push(text);
  }
  const out = Object.entries(buckets).filter(([, v]) => v.length)
    .map(([k, v]) => `## ${k}\n${v.map((x) => `- ${x}`).join('\n')}`).join('\n\n');
  console.log(`<!-- Draft from commits since ${since || 'the first commit'}. Rewrite each line for people who use the app. -->\n\n${out}`);
}

if (require.main === module) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'check') {
    const version = arg || appVersion();
    const { errors } = load(version);
    if (errors.length) {
      console.error(`FAIL release-notes/${version}.md\n  ` + errors.join('\n  '));
      process.exit(1);
    }
    console.log(`release notes: ${version} ok`);
  } else if (cmd === 'build') {
    if (!arg) { console.error('usage: release-notes.js build <tag>'); process.exit(2); }
    try { process.stdout.write(build(arg)); } catch (e) { console.error(e.message); process.exit(1); }
  } else if (cmd === 'draft') {
    draft();
  } else {
    console.error('usage: release-notes.js check [version] | build <tag> | draft');
    process.exit(2);
  }
}

module.exports = { parse, build, SECTIONS };
