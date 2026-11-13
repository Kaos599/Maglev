#!/usr/bin/env node
/** Release notes: sections are optional and ordered, the current version has notes, and the release uses them. */
const fs = require('fs');
const path = require('path');
const { parse, build, SECTIONS } = require('./release-notes.js');

const root = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const t = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? '  ok  ' : 'FAIL  '} ${name}`); };

t('three sections, in order', SECTIONS.join('|') === "What's new|What's changed|What's fixed");
t('a fixes-only file is valid', parse("## What's fixed\n- A crash on start.\n").errors.length === 0);
t('a new-only file is valid', parse("## What's new\n- App icons.\n").errors.length === 0);
t('empty file fails', parse('').errors.length > 0);
t('unknown heading fails', parse("## Bug fixes\n- x\n").errors.length > 0);
t('empty section fails', parse("## What's new\n\n## What's fixed\n- x\n").errors.length > 0);
t('wrong order fails', parse("## What's fixed\n- x\n## What's new\n- y\n").errors.length > 0);
t('duplicate section fails', parse("## What's new\n- x\n## What's new\n- y\n").errors.length > 0);
t('text outside a list fails', parse("## What's new\nSome prose.\n").errors.length > 0);

const version = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8')).expo.version;
t(`notes exist and parse for app.json version ${version}`, (() => {
  const p = path.join(root, 'release-notes', `${version}.md`);
  return fs.existsSync(p) && parse(fs.readFileSync(p, 'utf8')).errors.length === 0;
})());
for (const f of fs.readdirSync(path.join(root, 'release-notes')).filter((f) => /^\d+\.\d+\.md$/.test(f))) {
  t(`release-notes/${f} parses`, parse(fs.readFileSync(path.join(root, 'release-notes', f), 'utf8')).errors.length === 0);
}

const body = build(`v${version}-beta`);
t('release text has the title and tagline', body.startsWith(`# Maglev v${version}-beta`) && body.includes('Beta build.'));
t('release text has install steps', body.includes('## Which APK?') && body.includes('## Install'));
t('no old torrent-client tagline', !/minimal[^\n]{0,20}torrent client/i.test(body));
t('only sections the file has', (() => {
  const notes = parse(fs.readFileSync(path.join(root, 'release-notes', `${version}.md`), 'utf8')).sections.map((s) => s.title);
  return SECTIONS.every((s) => body.includes(`## ${s}`) === notes.includes(s));
})());

const wf = fs.readFileSync(path.join(root, '.github/workflows/release-apk.yml'), 'utf8');
t('release workflow checks notes before building', /release-notes\.js build "\$\{\{ github\.ref_name \}\}" > \/dev\/null/.test(wf));
t('release body comes from the notes file', wf.includes('body_path: release-body.md') && !/^\s+body: \|/m.test(wf));
t('publish job checks out the notes', /sparse-checkout: \|[\s\S]*release-notes[\s\S]*scripts\/release-notes\.js/.test(wf));
t('old tagline gone from the workflow', !/Minimal Android torrent client/i.test(wf));

console.log(`\nRelease notes: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
