#!/usr/bin/env node
// Chat view helpers contract (pure TS, no network). Needs Node 22.18+ (runs TypeScript directly).
process.removeAllListeners('warning');
const fs = require('node:fs');
const path = require('node:path');

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}${extra !== undefined ? ` (${JSON.stringify(extra)})` : ''}`);
  }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  const v = await import('../utils/assistant/chatView.ts');
  const src = fs.readFileSync(path.join(__dirname, '..', 'utils/assistant/chatView.ts'), 'utf8');
  console.log('chatview: purity');
  check('no react or expo imports', !/from\s+['"](react|react-native|expo)/.test(src));

  console.log('chatview: steps');
  const S = (tool, text, state = 'done', detail) => ({ callId: text, tool, text, state, detail });
  check('search label with source count', v.stepLabel(S('search_torrents', 'Searching 4 sources')) === 'Searched 4 sources');
  check('look inside keeps handle', v.stepLabel(S('get_result_details', 'Looking inside r1')) === 'Looked inside r1');
  check('running label', v.stepLabel(S('list_transfers', 'x', 'running')) === 'Checking your downloads');
  check('unknown tool falls back to text', v.stepLabel(S(undefined, 'Knaben didn\'t answer', 'failed')) === "Knaben didn't answer");
  check('failed icon is warning', v.stepIcon(S('search_torrents', 'x', 'failed')) === 'warning');
  check('detail wins', v.stepDetail(S('search_torrents', 'Searching 4 sources', 'done', '23 results')) === '23 results');
  check('no raw text repeat', v.stepDetail(S('list_transfers', 'Checked your downloads')) === '');
  check(
    'summary',
    v.stepsSummary([S('search_torrents', 'Searching 4 sources'), S('get_result_details', 'Looking inside r1')]) === 'Searched 4 sources · Looked inside r1',
  );
  check('summary dedupes', v.stepsSummary([S('list_transfers', 'a'), S('list_transfers', 'b')]) === 'Checked your downloads');
  check('summary names the running step', v.stepsSummary([S('search_torrents', 's', 'done'), S('get_free_space', 'c', 'running')]) === 'Checking space…');
  check('summary counts failures', v.stepsSummary([S('search_torrents', 's'), S('get_free_space', 'c', 'failed')]) === 'Searched · 1 step failed');
  check('empty summary', v.stepsSummary([]) === '');
  check('running flag', v.stepsRunning([S('a', 'a', 'running')]) && !v.stepsRunning([S('a', 'a')]));

  console.log('chatview: whats inside');
  check('kinds line', v.kindsSummary({ fileCount: 4, totalText: '4.2 GB', files: [], moreText: '', kinds: { video: 1, subtitle: 3 } }) === '1 video · 3 subtitles · 4.2 GB');
  check('no kinds falls back to count', v.kindsSummary({ fileCount: 1, totalText: '1 MB', files: [], moreText: '', kinds: {} }) === '1 file · 1 MB');
  check('kind icons', v.kindIcon('video') === 'file-video' && v.kindIcon('app') === 'file-app' && v.kindIcon('other') === 'file');

  console.log('chatview: light formatting');
  check('paragraphs split on blank line', v.parseLight('One\n\nTwo').length === 2);
  check('soft wrap joins', eq(v.parseLight('a\nb'), [{ type: 'p', spans: [{ text: 'a b' }] }]));
  check('bullets', eq(v.parseLight('- a\n* b'), [{ type: 'ul', items: [[{ text: 'a' }], [{ text: 'b' }]] }]));
  check('numbered', v.parseLight('1. a\n2) b')[0].type === 'ol');
  check('bold', eq(v.parseInline('a **b** c'), [{ text: 'a ' }, { text: 'b', bold: true }, { text: ' c' }]));
  check('unmatched bold marker dropped', eq(v.parseInline('a **b'), [{ text: 'a b' }]));
  check('link collapses to label', eq(v.parseInline('see [docs](http://evil.example)'), [{ text: 'see docs' }]));
  check('image collapses to alt', eq(v.parseInline('![pic](http://x/y.png)'), [{ text: 'pic' }]));
  check('no url survives', !JSON.stringify(v.parseLight('[a](http://x.test) ![b](http://y.test)')).includes('http'));
  check('heading becomes bold', v.parseLight('## Hi')[0].spans[0].bold === true);
  check('empty text gives no blocks', v.parseLight('').length === 0);
  check('partial streaming text is safe', v.parseLight('- **Hel').length === 1);

  console.log('chatview: starters and composer');
  check('six suggestions', v.SUGGESTIONS.length === 6 && v.SUGGESTIONS[0] === "What's new in movies this week?");
  check('compactCount', v.compactCount(950) === '950' && v.compactCount(12400) === '12.4k' && v.compactCount(1200) === '1.2k' && v.compactCount(2300000) === '2.3M');
  check('tokens line', v.tokensLine({ input: 800, output: 400 }) === '1.2k tokens used');
  check('tokens zero', v.tokensLine({ input: 0, output: 0 }) === 'No tokens used yet');
  check('model chip falls back to provider', v.modelChipText(undefined, 'OpenRouter') === 'OpenRouter' && v.modelChipText('Llama', 'X') === 'Llama');

  console.log('chatview: links and questions');
  const r = v.routeForTarget;
  check('transfers', eq(r({ screen: 'transfers', filter: 'done' }), { pathname: '/', params: { filter: 'done' } }) && eq(r({ screen: 'transfers' }), { pathname: '/' }));
  check('torrent id', eq(r({ screen: 'transfer', id: 'abc' }), { pathname: '/torrent/[id]', params: { id: 'abc' } }));
  check('download id goes to Transfers', eq(r({ screen: 'transfer', id: 'dl_00000001' }), { pathname: '/' }));
  check('search', eq(r({ screen: 'search', query: ' x y ' }), { pathname: '/search', params: { q: 'x y' } }) && eq(r({ screen: 'search' }), { pathname: '/search' }));
  check('add download', r({ screen: 'add_download' }).pathname === '/add-download');
  check('settings sections', r({ screen: 'settings', section: 'search_providers' }).pathname === '/settings/search-providers' && r({ screen: 'settings', section: 'schedule' }).pathname === '/settings/scheduling' && r({ screen: 'settings', section: 'storage' }).pathname === '/settings/storage');
  check('settings without section', r({ screen: 'settings' }).pathname === '/settings');
  check('garbage falls back', r({ screen: 'nope' }).pathname === '/');
  check('question label', v.questionLabel('Which?', 'A') === 'Which? You chose A.' && v.questionLabel('Which?').includes('Choose one'));

  if (failed) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall chatview checks passed');
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
