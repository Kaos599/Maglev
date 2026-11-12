import { fetchFeed, hostOf, loadFeeds, saveFeeds } from '../../utils/feeds';
import { getFeedAutomation, updateFeedAutomation } from '../../utils/prefs/feedAutomation';
import { FollowTarget, planFollow } from '../../utils/follow';

export type FollowOutcome = { ok: true; status: 'followed' | 'already' } | { ok: false; message: string };

/**
 * Saves the feed and rule for a followed show. A new feed is read once first, so a source that
 * cannot be reached is reported instead of leaving an empty feed behind.
 */
export async function commitFollow(target: FollowTarget, autoDownload: boolean): Promise<FollowOutcome> {
  const auto = getFeedAutomation();
  const plan = planFollow({ feeds: loadFeeds(), rules: auto.rules, automationEnabled: auto.enabled }, target, autoDownload);
  if (plan.status === 'already') return { ok: true, status: 'already' };
  if (plan.feedIsNew) {
    try {
      await fetchFeed(plan.feed.url);
    } catch {
      return { ok: false, message: `Maglev can't reach ${hostOf(plan.feed.url)} right now. Check your connection and try again.` };
    }
  }
  // Feeds first: updateFeedAutomation pushes both lists to the background checker.
  saveFeeds(plan.feeds);
  updateFeedAutomation({ rules: plan.rules, enabled: plan.automationEnabled });
  return { ok: true, status: 'followed' };
}
