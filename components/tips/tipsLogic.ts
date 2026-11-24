import { TIPS, TIP_TOPICS, type Tip, type TipTopic, type TipTopicId } from '../../constants/tipsCopy';
import { kvGet, kvSet } from '../../utils/prefs/kv';

/**
 * Whether the video-site feature (yt-dlp, PR #156) is in this build. It is, since #156 merged; kept as one switch
 * so the two cards that need it can be hidden again if the feature is ever pulled.
 */
export function isVideoSitesAvailable(): boolean {
  return true;
}

function available(tip: Tip): boolean {
  return tip.needs === 'videoSites' ? isVideoSitesAvailable() : true;
}

/** The cards a person can see in this build. */
export function visibleTips(): Tip[] {
  return TIPS.filter(available);
}

/** A topic with its visible cards. Topics with no visible card are dropped. */
export interface DeckTopic extends TipTopic {
  tips: Tip[];
}

export function deckTopics(): DeckTopic[] {
  const tips = visibleTips();
  return TIP_TOPICS.map((t) => ({ ...t, tips: tips.filter((c) => c.topic === t.id) })).filter((t) => t.tips.length > 0);
}

export function isTopicId(value: unknown): value is TipTopicId {
  return typeof value === 'string' && TIP_TOPICS.some((t) => t.id === value);
}

/** The topic after `id`, wrapping from the last back to the first. */
export function nextTopic(topics: readonly DeckTopic[], id: TipTopicId): DeckTopic {
  const i = topics.findIndex((t) => t.id === id);
  return topics[(i + 1) % topics.length];
}

/** What a swipe does: +1 next card, -1 previous card, 0 stay. A fling or more than 30% of the width commits. */
export function swipeDirection(dx: number, vx: number, width: number, canPrev: boolean, canNext: boolean): -1 | 0 | 1 {
  'worklet';
  const far = width > 0 && Math.abs(dx) > width * 0.3;
  const fast = Math.abs(vx) > 800;
  if (!far && !(fast && Math.abs(dx) > 12)) return 0;
  if (dx < 0) return canNext ? 1 : 0;
  return canPrev ? -1 : 0;
}

const LAST_KEY = 'maglev.tips.last.v1';

export interface TipsPosition {
  topic: TipTopicId;
  index: number;
}

/** Remembered topic and card. A convenience only: any trouble reading it means the first topic, first card. */
export function readPosition(): TipsPosition | null {
  try {
    const raw = kvGet(LAST_KEY);
    if (!raw) return null;
    const [topic, idx] = raw.split(':');
    const index = Number.parseInt(idx ?? '', 10);
    if (!isTopicId(topic) || !Number.isFinite(index) || index < 0) return null;
    return { topic, index };
  } catch {
    return null;
  }
}

export function savePosition(pos: TipsPosition): void {
  try {
    kvSet(LAST_KEY, `${pos.topic}:${pos.index}`);
  } catch {
    // Not worth failing a swipe over.
  }
}
