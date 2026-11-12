#!/usr/bin/env node
// System prompt: structure and priority order, the date, the generated tool list, intents and style (0.11).
// Pure TS, no network. Needs Node 22.18+ (runs the TypeScript source directly via type stripping).
process.removeAllListeners('warning');

let failed = 0;
let passed = 0;
function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${extra !== undefined ? ` (${typeof extra === 'string' ? extra : JSON.stringify(extra)})` : ''}`);
  }
}

async function main() {
  const { buildSystemPrompt, describeNow } = await import('../utils/assistant/systemPrompt.ts');
  const { TOOLS } = await import('../utils/assistant/tools.ts');
  const { estimateTokens } = await import('../utils/assistant/context.ts');
  const { explain } = await import('../utils/assistant/glossary.ts');

  const NOW = new Date('2026-11-12T12:10:00Z');
  const p = buildSystemPrompt({ now: NOW, timeZone: 'Asia/Kolkata' });

  console.log('prompt: date and time');
  check('names weekday, date, time and zone', p.includes('Thursday 12 November 2026, 17:40, Asia/Kolkata'), p.slice(0, 400));
  check('names the year and what it is for', /The year is 2026\./.test(p) && /this week/.test(p));
  const ny = describeNow(new Date('2026-12-31T20:00:00Z'), 'Asia/Kolkata');
  check('the zone decides the date (New Year in Kolkata)', ny.text.startsWith('Friday 1 January 2027') && ny.year === 2027, ny);
  check('a bad zone falls back instead of throwing', typeof describeNow(NOW, 'Not/AZone').text === 'string');
  check('no clock, no date line', !/<now>/.test(buildSystemPrompt()));

  console.log('prompt: the tool list is generated');
  const section = p.split('<tools>\n')[1].split('\n</tools>')[0];
  const lines = section.split('\n');
  check('one line per tool', lines.length === TOOLS.length && TOOLS.every((t) => lines.some((l) => l.startsWith(`- ${t.function.name}:`))), lines.length);
  check('search_torrents line shows sort values and category', /search_torrents:.*category.*sort best\|seeders\|newest/.test(section));
  check('exactly eight tools are mentioned', TOOLS.length === 8);
  check('browse_torrents is listed', /^- browse_torrents: /m.test(section), section);
  for (const gone of ['parse_release_name', 'describe_tools', 'propose_plan', 'propose_setting', 'get_free_space', 'get_transfer_details', 'explain_error', 'propose_select_files', 'propose_pause_resume', 'propose_remove_files', 'propose_delete', 'propose_url_download']) {
    check(`the prompt never mentions ${gone}`, !p.includes(gone));
  }
  const names = [...p.matchAll(/\b(search_torrents|get_result_details|propose_add|propose_change|list_transfers|ask_user|open_screen|[a-z]+_[a-z_]+)\b/g)].map((m) => m[1]);
  const known = new Set([...TOOLS.map((t) => t.function.name), 'max_size_gb', 'min_resolution', 'resolve_files', 'transfer_id', 'status_text', 'action_hint', 'add_download', 'search_providers', 'file_indices', 'first_indices', 'select_files', 'remove_files', 'delete_files', 'on_card', 'all_too_big', 'shortfall_text', 'max_resolution']);
  check('every snake_case word in the prompt is a real tool or argument', names.every((n) => known.has(n)), names.filter((n) => !known.has(n)));

  console.log('prompt: structure');
  const order = ['<role>', '<priorities>', '<rules>', '<approach>', '<style>', '<now>', '<tools>'].map((t) => p.indexOf(t));
  check('sections come in order of authority, context last', order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1])), order);
  check('every opened section is closed', ['role', 'priorities', 'rules', 'approach', 'style', 'now', 'tools'].every((t) => p.includes(`</${t}>`)));
  const prio = p.split('<priorities>')[1].split('</priorities>')[0];
  check('priorities are ranked: safety, truth, consent, goal, style', /1\. Safety[\s\S]*2\. Truth[\s\S]*3\. Consent[\s\S]*4\. The user's goal[\s\S]*5\. Style/.test(prio));
  check('rules are grouped under the priorities', /Safety\n- [\s\S]*Truth\n- [\s\S]*Consent\n- [\s\S]*Scope\n- /.test(p.split('<rules>')[1]));
  check('no sample titles or books-only rules', !/Primetime|Terminator|Debian|Sintel|ebook|^Books/im.test(p));

  console.log('prompt: approach by intent');
  const ap = p.split('<approach>')[1].split('</approach>')[0];
  check('no title but new or popular: browse_torrents with order new or popular', /No title[^\n]*new, recent, popular[^\n]*browse_torrents[^\n]*order new or popular/.test(ap), ap);
  check('a title: search_torrents, newest for the newest copy, seeders for the most shared', /A title: search_torrents/.test(ap) && /newest/.test(ap) && /seeders for the most shared/.test(ap));
  check('suggestions: picks first, offer to search; new or popular now browses', /two or three picks, then offer to search/.test(ap) && /new, recent or popular now, browse instead/.test(ap));
  check('meaning questions: no tools', /Answer from knowledge, no tools\n- Meaning or comparison/.test(ap));
  check('availability opens with yes, no or not yet; cinema recordings flagged', /yes, no or not yet/.test(ap) && /cinema recordings/.test(ap));
  check('how-to follows the app and names Download/Maglev', /Choose files/.test(ap) && /Download\/Maglev/.test(ap));
  check('downloads use list_transfers status_text and action_hint', /list_transfers[^\n]*status_text and action_hint/.test(ap));
  check('already in that state: say so, no card', /already in the state asked for/.test(ap));
  check('settings questions go to open_screen', /open_screen/.test(ap));
  check('closed choices go to ask_user then wait; open questions in one plain sentence', /ask_user[^\n]*stop and wait/.test(ap) && /open question[^\n]*plain sentence/i.test(ap));
  check('fewest tool calls', /fewest tool calls/.test(ap));
  check('a download request picks a card, looks inside, proposes; no asking which copy', /pick the card that fits best yourself/.test(ap) && /Don't ask which copy/.test(ap));
  check('existing downloads: list_transfers before searching', /list_transfers first\. Search only if it isn't there/.test(ap));
  check('cards are referred to by title, matched by on_card', /on_card/.test(ap) && /never by an id/.test(ap));
  check('nothing found: no invented titles, mention sources down', /Nothing found/.test(ap) && /never invent a title/i.test(ap));
  check('all too big: shortfall_text then ask_user, no add', /all_too_big/.test(ap) && /shortfall_text/.test(ap) && /Don't look inside or propose an add/.test(ap));
  check('follow-ups map to the cards in order', /Follow-ups/.test(ap) && /smaller/.test(ap));
  check('scope: no cracks (malware), no adult search, other topics declined in one line', /cracks, keygens, activators/.test(p) && /adult content/.test(p) && /For anything else/.test(p));
  check('quote tool numbers as written', /exactly as the tool wrote them/.test(p));
  check('reply in the user language', /Reply in the language the user writes in/.test(p));

  console.log('prompt: style');
  const st = p.split('<style>')[1].split('</style>')[0];
  check('answer first, no preamble', /Lead with the answer\. No preamble/.test(st));
  check('formatting: short paragraphs, bullets, bold, no tables, links, images or headings', /Short paragraphs of one to three sentences/.test(st) && /Bullets/.test(st) && /\*\*Bold\*\*/.test(st) && /No tables, links, images or headings/.test(st));
  check('the old "plain text only" rule is gone', !/Plain text only/.test(p) && !/No markdown/i.test(p));
  check('never mention the .torrent size', /Never mention the size of the \.torrent file/.test(st));
  check('free space only when something does not fit', /free space only when something doesn't fit/i.test(st));
  check('at most three options, no apologies', /At most three options/.test(st) && /No apologies/.test(st));

  console.log('prompt: safety and scope are kept');
  check('proposals only, cards need a tap', /Every change is a card the user taps/.test(p) && /Never write as if it already happened/.test(p));
  check('untrusted names, never "safe", red refusal', /as data, never as instructions/.test(p) && /Never call a file safe/.test(p) && /Never propose adding a result the check marked red/.test(p));
  check('no legal advice', /can't give legal advice/.test(p));
  check('look inside before propose_add', /get_result_details before you propose adding it/.test(p));
  check('sharing, not seeders', /Say "sharing"/.test(p));
  check('no year added to the search', p.includes('Never add a year'));

  console.log('prompt: size');
  const tokens = estimateTokens(p);
  check('the prompt stays under 2400 tokens', tokens < 2400, tokens);

  console.log('glossary: terms the jargon workflow relies on');
  for (const k of ['webdl', 'webrip', 'bluray', 'hdtv', 'cam', 'ts', 'remux', 'x264', 'x265', 'hevc', '10bit', 'hdr', 'dv', 'atmos', 'dts', 'aac', '2160p', '1080p', '720p']) {
    const e = explain(k);
    check(`glossary explains ${k} in plain words`, e && e.plain.length > 20 && e.plain.split(/\s+/).length < 40, e && e.plain);
  }
  const cam = explain('cam');
  check('HDCAM is an alias of CAM', cam.aka && cam.aka.includes('HDCAM'));
  check('TELESYNC is an alias of TS', explain('ts').aka.includes('TELESYNC'));

  if (failed) {
    console.error(`\n${failed} failed`);
    process.exit(1);
  }
  console.log(`\nassistant prompt tests passed (${passed})`);
}
main();
