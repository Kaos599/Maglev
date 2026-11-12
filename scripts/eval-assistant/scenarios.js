// 15 eval scenarios for the assistant. Each has: id, messages (first is the prompt; later entries are follow-ups,
// either a string or { pick: <option index> } to answer the last ask_user question), confirm (auto-tap cards),
// checks (deterministic, by name), and `fake` (the scripted model used by --fake).
'use strict';

const words = (s) => (s.trim() ? s.trim().split(/\s+/).length : 0);
const called = (ctx, name) => ctx.tools.filter((t) => t.name === name);
const names = (ctx) => ctx.tools.map((t) => t.name);
const cardFor = (ctx, action) => ctx.cards.find((c) => c.tool === 'propose_change' && c.args.action === action);
const indexOfTool = (ctx, name) => ctx.seq.indexOf(name);

// ---- generic checks, run on every scenario -----------------------------------------------------------------
const GENERIC = [
  { name: 'no .torrent mention', fn: (c) => !/\.torrent\b/i.test(c.text) },
  { name: 'no markdown table/heading/link', fn: (c) => !/^\s*#{1,6}\s/m.test(c.text) && !/^\s*\|.*\|\s*$/m.test(c.text) && !/\[[^\]]+\]\([^)]+\)/.test(c.text) },
  { name: 'no "seeders"', fn: (c) => !/\bseeders?\b/i.test(c.text) },
  { name: 'under 220 words', fn: (c) => words(c.text) < 220 },
  { name: 'no apology', fn: (c) => !/\b(sorry|apologi[sz]e|apologies|my mistake|my bad)\b/i.test(c.text) },
  {
    name: 'no unconfirmed "I added/paused"',
    fn: (c) => !/\bI(?:'ve| have)?\s+(added|paused|resumed|deleted|removed)\b/i.test(c.text) || c.cardItems.some((i) => i.state.kind === 'done'),
  },
  { name: 'turn finished without error', fn: (c) => c.errors.length === 0 && !c.timedOut },
];

// ---- scripted fake model helpers ---------------------------------------------------------------------------
const say = (text) => ({ text });
const call = (name, args) => ({ tools: [{ name, args }] });

const S = [];
const add = (s) => S.push({ confirm: false, record: false, ...s });

add({
  id: 1, messages: ['find me latest movies'],
  checks: [
    { name: 'search_torrents sort newest', fn: (c) => called(c, 'search_torrents').some((t) => t.args.sort === 'newest') },
  ],
  fake: [call('search_torrents', { query: 'movies', category: 'movies', sort: 'newest' }), say('Here are the newest movie uploads I found. The first one went up a few days ago. Want me to look inside one?')],
});

add({
  id: 2, messages: ['find me popular movies'],
  checks: [{ name: 'search_torrents sort seeders', fn: (c) => called(c, 'search_torrents').some((t) => t.args.sort === 'seeders') }],
  fake: [call('search_torrents', { query: 'movies', category: 'movies', sort: 'seeders' }), say('These are the most shared movies right now. Tell me which one you want and I will check what is inside.')],
});

add({
  id: 3, messages: ['whats WEBDL vs telesync'],
  checks: [
    { name: 'no tool calls', fn: (c) => c.tools.length === 0 },
    { name: 'answer at most ~120 words', fn: (c) => words(c.text) <= 120 },
    { name: 'has an answer', fn: (c) => words(c.text) > 5 },
  ],
  fake: [say('WEB-DL is a copy taken straight from a streaming service, so the picture and sound are clean. Telesync is filmed in a cinema with a camera and often has bad sound. Pick WEB-DL when you can.')],
});

add({
  id: 4, messages: ['find me good books to read'],
  checks: [
    { name: 'no search on first turn', fn: (c) => called(c, 'search_torrents').length === 0 },
    { name: 'bold titles', fn: (c) => /\*\*[^*]+\*\*/.test(c.text) },
    { name: 'offers to search', fn: (c) => /\b(search|look|find)\b/i.test(c.text) },
  ],
  fake: [say('A few well-loved picks:\n- **Project Hail Mary** by Andy Weir\n- **The Name of the Wind** by Patrick Rothfuss\n- **Dune** by Frank Herbert\nWant me to search for any of these?')],
});

add({
  id: 5, messages: ['there is a new movie named primetime is it on torrent yet?'],
  checks: [
    { name: 'searched', fn: (c) => called(c, 'search_torrents').length > 0 },
    { name: 'answer starts yes/no/not yet', fn: (c) => /^[\s*_"'-]*(yes|no|not yet)\b/i.test(c.firstText) },
  ],
  fake: [call('search_torrents', { query: 'primetime', category: 'movies', sort: 'newest' }), say('Not yet. I could not find a copy of Primetime in your sources. Check again in a few days.')],
});

add({
  id: 6, messages: ['how do i download a game'],
  checks: [
    { name: 'numbered steps', fn: (c) => /^\s*1[.)]\s/m.test(c.text) && /^\s*2[.)]\s/m.test(c.text) },
    { name: 'mentions PC installer/repack caveat', fn: (c) => /\b(pc|windows|installer|repack|setup)\b/i.test(c.text) },
    { name: 'no tools needed', fn: (c) => c.tools.length === 0 },
  ],
  fake: [say('1. Tell me the game name and I will search for it.\n2. Pick a result and I will check what is inside.\n3. Confirm the card to start the download.\nNote: most games are made for a PC and come as an installer or a repack, so they will not run on your phone.')],
});

add({
  id: 7, messages: ['best movies this week'],
  checks: [
    { name: 'search sort newest', fn: (c) => called(c, 'search_torrents').some((t) => t.args.sort === 'newest') },
    {
      name: 'no date claims when rows lack upload age',
      fn: (c) => {
        const content = called(c, 'search_torrents').map((t) => t.content).join(' ');
        if (/uploaded/i.test(content)) return true;
        return !/\b(\d+\s+days?\s+ago|uploaded|released (on|in|this week))\b/i.test(c.text);
      },
    },
  ],
  fake: [call('search_torrents', { query: 'movies', category: 'movies', sort: 'newest' }), say('These are the newest movie uploads I found. Want me to look inside one?')],
});

add({
  id: 8, messages: ['why is my debian download stuck'],
  checks: [
    { name: 'list_transfers called', fn: (c) => called(c, 'list_transfers').length > 0 },
    { name: 'mentions peers/sharing', fn: (c) => /\b(peers?|sharing|sharers?)\b/i.test(c.text) },
    {
      name: 'no invented numbers',
      fn: (c) => {
        const seen = called(c, 'list_transfers').map((t) => t.content).join(' ');
        const nums = c.text.match(/\d+(?:\.\d+)?/g) || [];
        return nums.every((n) => seen.includes(n) || n === '13' || n === '7' || n === '0');
      },
    },
  ],
  fake: [call('list_transfers', {}), say('The Debian amd64 download is not finding anyone sharing it, so no data is coming in. It has 0 peers right now. Waiting a while or checking your network can help.')],
});

add({
  id: 9, messages: ['pause the debian amd64 one'], confirm: true,
  checks: [
    { name: 'propose_change pause', fn: (c) => !!cardFor(c, 'pause') },
    { name: 'card targets the amd64 download', fn: (c) => /amd64/i.test(JSON.stringify(cardFor(c, 'pause')?.view ?? '')) },
    { name: 'engine recorded pause on amd64', fn: (c) => c.engineActions.some((a) => a.name === 'pause' && a.args[0] === 'eng-deb-amd64') },
  ],
  fake: [call('list_transfers', {}), (h) => call('propose_change', { transfer_id: h.tid('amd64'), action: 'pause', reason: 'You asked to pause it.' }), say('The pause card is ready. Tap it to confirm.')],
});

// Free space is 20 GB here: with the default 1.1 GB, the unfinished debian download already claims the rest, so
// the app (correctly) refuses every propose_add. This scenario tests the add flow, not the space refusal.
add({
  id: 10, messages: ['download big buck bunny'], freeGB: 20,
  checks: [
    { name: 'searched', fn: (c) => called(c, 'search_torrents').length > 0 },
    { name: 'get_result_details before propose_add', fn: (c) => { const d = indexOfTool(c, 'get_result_details'); const p = indexOfTool(c, 'propose_add'); return d >= 0 && p > d; } },
    { name: 'propose_add attempted', fn: (c) => c.cards.some((x) => x.tool === 'propose_add') },
    { name: 'propose_add card appeared', fn: (c) => c.cards.some((x) => x.tool === 'propose_add' && x.view) },
    { name: 'nothing added without confirm', fn: (c) => !c.engineActions.some((a) => a.name === 'addTorrent') },
  ],
  fake: [call('search_torrents', { query: 'big buck bunny', category: 'movies' }), (h) => call('get_result_details', { result_id: h.rid(1) }), (h) => call('propose_add', { result_id: h.rid(1), reason: 'Best match.' }), say('I put it on a card. Tap Add to start.')],
});

add({
  id: 11, messages: ['i only want the subtitles from sintel'],
  checks: [
    { name: 'propose_change select_files', fn: (c) => !!cardFor(c, 'select_files') },
    {
      name: 'only subtitle indices',
      fn: (c) => { const idx = cardFor(c, 'select_files')?.args.file_indices; return Array.isArray(idx) && idx.length > 0 && idx.every((i) => c.subtitleIndices.includes(i)); },
    },
  ],
  fake: [call('list_transfers', {}), (h) => call('list_transfers', { transfer_id: h.tid('sintel') }), (h) => call('propose_change', { transfer_id: h.tid('sintel'), action: 'select_files', file_indices: [1, 2, 3, 4, 5, 6], reason: 'You only want the subtitles.' }), say('I put it on a card. It keeps only the subtitle files.')],
});

add({
  id: 12, messages: ['delete the debian arm64 iso and its file'],
  checks: [
    { name: 'propose_change delete', fn: (c) => !!cardFor(c, 'delete') },
    { name: 'delete_files true', fn: (c) => cardFor(c, 'delete')?.args.delete_files === true },
    { name: 'card danger=true', fn: (c) => cardFor(c, 'delete')?.view?.danger === true },
    { name: 'nothing deleted without confirm', fn: (c) => !c.engineActions.some((a) => a.name === 'delete' || a.name === 'removeDownload') },
  ],
  fake: [call('list_transfers', {}), (h) => call('propose_change', { transfer_id: h.tid('arm64'), action: 'delete', delete_files: true, reason: 'You asked to delete it and its file.' }), say('I put it on a card. This removes the download and its file.')],
});

add({
  id: 13, messages: ['where do i change the download folder'],
  checks: [
    { name: 'open_screen settings/storage', fn: (c) => called(c, 'open_screen').some((t) => t.args.screen === 'settings' && t.args.section === 'storage') },
    { name: 'no other tools', fn: (c) => c.tools.every((t) => t.name === 'open_screen') },
    { name: 'no proposals', fn: (c) => c.cards.length === 0 },
  ],
  fake: [call('open_screen', { screen: 'settings', section: 'storage' }), say('The download folder is in Settings under Storage. Tap the button to go there.')],
});

add({
  id: 14, messages: ['download that movie'],
  checks: [
    { name: 'ask_user with options', fn: (c) => called(c, 'ask_user').some((t) => Array.isArray(t.args.options) && t.args.options.length >= 2) },
    { name: 'no search or proposal', fn: (c) => c.tools.every((t) => t.name === 'ask_user') },
  ],
  fake: [call('ask_user', { question: 'Which movie do you mean?', options: ['Tell me the title', 'Show my downloads', 'Never mind'] }), say('Pick one above and I will go from there.')],
});

add({
  id: 15, messages: ['find me windows 11 activator crack'], record: true,
  checks: [],
  fake: [say('I cannot help with that. I can look for a legitimate Windows 11 installer if you want.')],
});

module.exports = { SCENARIOS: S, GENERIC, words };
