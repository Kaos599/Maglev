/**
 * "Follow this": turns a search result for a TV or anime episode into a feed rule.
 * Pure: no storage and no network. The Search tab persists the plan through utils/feeds.ts
 * and utils/prefs/feedAutomation.ts.
 */
import type { FeedRule } from 'maglev-engine';
import type { Feed } from './feeds';
import { parseEpisodeKey } from './feedRules.ts';
import { parseRelease } from './assistant/releaseName.ts';

export type FollowKind = 'tv' | 'anime';

export interface FollowTarget {
  kind: FollowKind;
  /** Show title as shown to the user. */
  title: string;
  /** Rule without a feed attached; planFollow fills feedIds. */
  rule: FeedRule;
}

export interface FollowFeed {
  name: string;
  url: string;
}

/** Categories that can never be a followed series. */
const NOT_SERIES = new Set(['movies', 'music', 'apps', 'games', 'books', 'adult']);

/** Lowercase alphanumeric words without accents; one-letter words are dropped (they match everything). */
export function titleWords(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);
}

function slug(words: string[]): string {
  return words.join('-').slice(0, 60);
}

/**
 * A rule for new episodes of the show in this result, or null when the result is not an episode or
 * season pack (a movie or one-off has nothing to follow). The query wins as the title when it is a
 * shorter form of the parsed title, because anime names often parse with the episode number attached.
 */
export function followRuleFromResult(name: string, query: string, category: string): FollowTarget | null {
  if (NOT_SERIES.has(category)) return null;
  const parsed = parseRelease(name);
  // parseRelease misses "Title - 12" without a group tag; the feed matcher's key reads it.
  const hasEpisodes = (parsed.episodes?.length ?? 0) > 0 || parseEpisodeKey(name) !== null;
  if (!hasEpisodes && !parsed.seasonPack && !parsed.completeSeries) return null;

  let title = (parsed.title ?? '').replace(/\s+-\s+\d{1,4}(v\d+)?$/i, '').trim();
  let words = titleWords(title);
  const q = titleWords(query);
  if (q.length > 0 && q.length < words.length && q.every((w) => words.includes(w))) {
    title = query.trim();
    words = q;
  }
  if (words.length === 0) return null;

  const kind: FollowKind = category === 'anime' || (parsed.season === undefined && hasEpisodes && !parsed.seasonPack) ? 'anime' : 'tv';
  const include = [...words.slice(0, 8), ...(parsed.resolution ? [`${parsed.resolution}p`] : [])].join(' ');
  return {
    kind,
    title,
    rule: {
      id: `follow_${kind}_${slug(words)}`,
      name: title,
      feedIds: [],
      include,
      exclude: '',
      episodes: 'new_only',
      startPaused: false,
      enabled: false,
    },
  };
}

/**
 * The feed that can carry this show, from endpoints the Search tab already uses.
 * Anime: Nyaa's RSS, filtered by title (one feed per show). TV: EZTV's "latest releases" RSS,
 * the only RSS EZTV offers (it has no per-show feed, and shows are filtered by the rule).
 */
export function followFeedFor(target: FollowTarget): FollowFeed {
  if (target.kind === 'anime') {
    return {
      name: `${target.title} (Nyaa)`,
      url: `https://nyaa.si/?page=rss&c=1_0&f=0&q=${encodeURIComponent(titleWords(target.title).join(' '))}`,
    };
  }
  return { name: 'EZTV latest releases', url: 'https://eztvx.to/ezrss.xml' };
}

export interface FollowState {
  feeds: Feed[];
  rules: FeedRule[];
  automationEnabled: boolean;
}

export interface FollowPlan extends FollowState {
  status: 'followed' | 'already';
  feed: Feed;
  /** True when planFollow added a feed (the caller should read it once to seed "seen"). */
  feedIsNew: boolean;
}

/**
 * Applies a follow to the saved feeds and rules. Reuses a feed with the same address and never
 * adds the same show twice. Switching automatic download on also turns the global switch on,
 * since a rule does nothing while it is off.
 */
export function planFollow(state: FollowState, target: FollowTarget, autoDownload: boolean, now: number = Date.now()): FollowPlan {
  const wanted = followFeedFor(target);
  const existing = state.feeds.find((f) => f.url === wanted.url);
  const feed: Feed = existing ?? { id: `feed_${now.toString(36)}`, name: wanted.name, url: wanted.url };
  const dup = state.rules.find((r) => r.id === target.rule.id);
  if (dup) {
    return { ...state, status: 'already', feed, feedIsNew: false };
  }
  const rule: FeedRule = { ...target.rule, feedIds: [feed.id], enabled: autoDownload };
  return {
    feeds: existing ? state.feeds : [...state.feeds, feed],
    rules: [...state.rules, rule],
    automationEnabled: state.automationEnabled || autoDownload,
    status: 'followed',
    feed,
    feedIsNew: !existing,
  };
}
