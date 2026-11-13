#!/usr/bin/env node
/**
 * Add-flow wording and folder contract.
 *
 * Maglev adds torrents AND plain links, so the generic entry screen must not call itself
 * "Add torrent", the field must not hint a magnet only, add-download must let the user pick the
 * folder (DownloadOptions.folder defaults to the active target in EngineHost.addDownload), and the
 * empty Transfers screen and clipboard chip must speak about links too.
 */
const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

let failed = 0;
function check(name, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
}

const addTorrent = read('app', 'add-torrent.tsx');
const addDownload = read('app', 'add-download.tsx');
const empty = read('components', 'transfers', 'TeachingEmptyState.tsx');
const chip = read('components', 'transfers', 'ClipboardChip.tsx');
const copy = read('constants', 'copy.ts');
const fab = read('components', 'FloatingActionButton.tsx');

const inputStart = addTorrent.indexOf('// ---------- Input');
const inputBlock = inputStart >= 0 ? addTorrent.slice(inputStart) : addTorrent.slice(-2500);
check('entry screen is titled "Add a link or torrent"', /<Screen title="Add a link or torrent"/.test(inputBlock));
check('entry screen is not titled "Add torrent"', !/<Screen title="Add torrent"/.test(inputBlock));
check('input label is "Link, magnet or .torrent"', addTorrent.includes('Link, magnet or .torrent') && !addTorrent.includes('Magnet, torrent or file link'));
check('placeholder is not a magnet URI', !/placeholder="magnet:/.test(addTorrent) && /placeholder="Paste a link or magnet"/.test(addTorrent));
check('Open .torrent file is kept', addTorrent.includes('Open .torrent file'));

check('add-download has a Save to row', addDownload.includes('Save to'));
check('add-download can change the folder', /pickDownloadFolder/.test(addDownload) && /Change/.test(addDownload));
check('add-download keeps 44px row', /touch\.min/.test(addDownload));

check('empty state copy mentions links and torrents', /No downloads yet/.test(copy) && /link/i.test(copy.match(/none:\s*\{[^}]*\}/)[0]) && /torrent/i.test(copy.match(/none:\s*\{[^}]*\}/)[0]));
check('empty state offers optional Search and Browser actions', /onSearch\?/.test(empty) && /onBrowse\?/.test(empty) && /label="Search"/.test(empty) && /label="Browser"/.test(empty));
check('empty state renders them only when provided', /onSearch\s*\?/.test(empty) || /onSearch\s*&&/.test(empty) || /\(onSearch \|\| onBrowse\)/.test(empty));
check('clipboard copy works for any link', /Add the link you copied/.test(copy) && !/Magnet link in clipboard/.test(copy));
check('clipboard chip can show the link host', /link\?:\s*string/.test(chip) && /new URL|host/i.test(chip));
check('FAB label mentions link and torrent', /Add a link or torrent/.test(fab));

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nall add-flow checks passed');
