#!/usr/bin/env node
// "Follow this": result to rule, feed choice, and persistence round-trip through the real kv-backed stores.
// Needs Node 22.18+ (runs the TypeScript source directly).

process.removeAllListeners('warning');

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}

// Stub the two native-only packages so feeds.ts and feedAutomation.ts load in Node.
const kv = new Map();
const pushed = [];
const stubs = {
  'expo-sqlite/kv-store': `export default { getItemSync: (k) => globalThis.__kv.has(k) ? globalThis.__kv.get(k) : null, setItemSync: (k, v) => { globalThis.__kv.set(k, v); } };`,
  'maglev-engine': `export const maglevEngine = { setFeedAutomation: async (c) => { globalThis.__pushed.push(c); } };`,
  react: `export const useSyncExternalStore = () => null;`,
};
globalThis.__kv = kv;
globalThis.__pushed = pushed;
require('node:module').registerHooks({
  resolve(spec, ctx, next) {
    if (stubs[spec]) return { url: 'data:text/javascript,' + encodeURIComponent(stubs[spec]), shortCircuit: true, format: 'module' };
    try {
      return next(spec, ctx);
    } catch (e) {
      // App code imports without extensions (Metro resolves them); Node needs the .ts.
      if (spec.startsWith('.') && !/\.\w+(\?.*)?$/.test(spec)) return next(spec + '.ts', ctx);
      throw e;
    }
  },
});

async function main() {
  const { followRuleFromResult, followFeedFor, planFollow } = await import('../utils/follow.ts');
  const { matchItem } = await import('../utils/feedRules.ts');

  const ep = followRuleFromResult('Severance.S02E03.1080p.WEB.h264-ETHEL', 'severance', 'tv');
  check('episode: rule for the show', ep?.kind === 'tv' && ep.title === 'Severance' && ep.rule.include === 'severance 1080p');
  check('episode: new_only, off until chosen', ep?.rule.episodes === 'new_only' && ep.rule.enabled === false);
  check('episode rule matches a later episode', matchItem(ep.rule, 'Severance.S02E04.1080p.WEB.h264-ETHEL', ['s2e3']).match);
  check('episode rule skips the same episode', !matchItem(ep.rule, 'Severance.S02E03.1080p.WEB.h264-X', ['s2e3']).match);
  check('episode rule skips another resolution', !matchItem(ep.rule, 'Severance.S02E04.720p.WEB.h264-X', []).match);
  check('episode rule skips another show', !matchItem(ep.rule, 'Other.Show.S02E04.1080p.WEB', []).match);

  const pack = followRuleFromResult('The.Bear.2022.S03.COMPLETE.2160p.WEB-DL', 'the bear', 'tv');
  check('season pack: rule, year not in rule', pack?.kind === 'tv' && pack.rule.include === 'the bear 2160p', pack?.rule.include);

  check('movie with year: null', followRuleFromResult('Dune.Part.Two.2024.1080p.BluRay', 'dune', 'movies') === null);
  check('movie in "all" category: null', followRuleFromResult('Dune.Part.Two.2024.1080p.BluRay', 'dune', 'all') === null);
  check('game: null', followRuleFromResult('Some.Game.S01E01', 'x', 'games') === null);

  const x = followRuleFromResult('Show Name 2x05 720p HDTV', '', 'all');
  check('1x02 style names', x?.title === 'Show Name' && x.rule.include === 'show name 720p');

  const accent = followRuleFromResult('Shōgun (2024) S01E01 1080p', '', 'tv');
  check('accents fold to plain words', accent?.rule.include === 'shogun 1080p', accent?.rule.include);
  check('accented rule matches plain title', matchItem(accent.rule, 'Shogun.2024.S01E02.1080p', []).match);

  const anime = followRuleFromResult('[SubsPlease] Sousou no Frieren - 12 (1080p) [ABC].mkv', 'frieren', 'anime');
  check('anime: kind and short query as title', anime?.kind === 'anime' && anime.title === 'frieren' && anime.rule.include === 'frieren 1080p');
  const animeNoQuery = followRuleFromResult('[SubsPlease] Sousou no Frieren - 12 (1080p) [ABC].mkv', '', 'all');
  check('anime without category hint: still anime', animeNoQuery?.kind === 'anime' && animeNoQuery.rule.include === 'sousou no frieren 1080p');
  const apos = followRuleFromResult("Frieren - Beyond Journey's End - 12 [1080p] [SubsPlease]", "frieren", 'anime');
  check('title with trailing number cleaned via query', apos?.title === 'frieren');
  check('apostrophes do not leave a stray letter', !followRuleFromResult("Journey's.End.S01E01.1080p", '', 'tv').rule.include.split(' ').includes('s'));

  check('feed: anime uses a Nyaa RSS filtered by title', followFeedFor(anime).url === 'https://nyaa.si/?page=rss&c=1_0&f=0&q=frieren');
  check('feed: TV uses the EZTV RSS', followFeedFor(ep).url === 'https://eztvx.to/ezrss.xml');

  // planFollow
  const base = { feeds: [], rules: [], automationEnabled: false };
  const p1 = planFollow(base, ep, false, 1000);
  check('plan: adds feed and rule', p1.status === 'followed' && p1.feeds.length === 1 && p1.rules.length === 1 && p1.feedIsNew);
  check('plan: rule points at the feed, off', p1.rules[0].feedIds[0] === p1.feed.id && p1.rules[0].enabled === false && !p1.automationEnabled);
  const p2 = planFollow(p1, ep, false, 2000);
  check('plan: same show twice is "already"', p2.status === 'already' && p2.rules.length === 1 && p2.feeds.length === 1);
  const other = followRuleFromResult('Andor.S02E01.1080p.WEB', 'andor', 'tv');
  const p3 = planFollow(p1, other, true, 3000);
  check('plan: second TV show reuses the EZTV feed', p3.feeds.length === 1 && !p3.feedIsNew && p3.rules.length === 2);
  check('plan: auto-download on enables rule and global switch', p3.rules[1].enabled && p3.automationEnabled);

  // Round-trip through the real stores.
  const feeds = await import('../utils/feeds.ts');
  const auto = await import('../utils/prefs/feedAutomation.ts');
  feeds.saveFeeds(p3.feeds);
  auto.updateFeedAutomation({ rules: p3.rules, enabled: p3.automationEnabled });
  check('store: feeds persisted as JSON in kv', JSON.parse(kv.get('maglev.feeds.list.v1')).length === 1);
  const saved = JSON.parse(kv.get('maglev.feeds.automation.v1'));
  check('store: rules and toggle persisted', saved.enabled === true && saved.rules.length === 2 && saved.rules[1].include === 'andor 1080p');
  // A fresh load (restart) reads the same thing back through normalize.
  const restarted = (await import('../utils/prefs/feedAutomation.ts?restart')).getFeedAutomation();
  check('restart: rules survive normalize', restarted.rules.length === 2 && restarted.rules[0].episodes === 'new_only' && restarted.rules[0].feedIds[0] === p3.feed.id);
  check('restart: feeds reload', feeds.loadFeeds()[0].url === 'https://eztvx.to/ezrss.xml');
  const cfg = pushed[pushed.length - 1];
  check('native config carries the rule, feed and switch', cfg.enabled === true && cfg.rules.length === 2 && cfg.feeds.length === 1 && cfg.rules[1].feedIds[0] === cfg.feeds[0].id);

  // Removing the rule (as the Auto-download settings do) round-trips too.
  auto.updateFeedAutomation((p) => ({ rules: p.rules.filter((r) => r.id !== ep.rule.id) }));
  check('remove: rule gone from store', JSON.parse(kv.get('maglev.feeds.automation.v1')).rules.length === 1);
  const again = planFollow({ feeds: feeds.loadFeeds(), rules: auto.getFeedAutomation().rules, automationEnabled: true }, ep, false, 5000);
  check('remove: can follow again', again.status === 'followed');

  console.log(failed ? `\nfollow: ${failed} failed` : '\nfollow: all passed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
