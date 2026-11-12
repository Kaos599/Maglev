import { useEffect, useRef } from 'react';
import { AccessibilityInfo } from 'react-native';
import type { ChatItem } from '../../utils/assistant/runtime';

/** What a screen reader should say for a card that just settled, or null for states that need no speech. */
function cardLine(item: Extract<ChatItem, { kind: 'card' }>): string | null {
  const s = item.state;
  switch (s.kind) {
    case 'done':
      return s.summary ?? 'Done.';
    case 'dismissed':
      return 'Dismissed.';
    case 'expired':
      return s.caption ?? 'Expired.';
    case 'failed':
      return s.error ?? null;
    default:
      return null;
  }
}

/**
 * Speaks chat changes once, instead of a live region that would re-read every streamed token:
 * a finished assistant message (streaming true to false), a new error, a new note, and a card that settles.
 * Chat items already on screen when the view mounts are not read again.
 * Uses AccessibilityInfo.announceForAccessibility (TalkBack and VoiceOver).
 */
export function useChatAnnouncements(items: ChatItem[]): void {
  // id -> signature of what was last seen; seeded on first render so a revisit stays quiet.
  const seen = useRef<Map<string, string> | null>(null);

  useEffect(() => {
    const next = new Map<string, string>();
    const spoken: string[] = [];
    const prev = seen.current;
    for (const it of items) {
      let sig = it.kind as string;
      let line: string | null = null;
      switch (it.kind) {
        case 'assistant':
          sig = it.streaming ? 'streaming' : 'final';
          if (sig === 'final' && it.text && prev?.get(it.id) !== 'final') line = it.text;
          break;
        case 'error':
          sig = 'error';
          if (prev && !prev.has(it.id)) line = it.message;
          break;
        case 'note':
          sig = 'note';
          if (prev && !prev.has(it.id)) line = it.text;
          break;
        case 'card':
          sig = it.state.kind;
          if (prev && prev.get(it.id) !== sig) line = cardLine(it);
          break;
        default:
          break;
      }
      next.set(it.id, sig);
      if (line && prev) spoken.push(line);
    }
    seen.current = next;
    if (spoken.length > 0) AccessibilityInfo.announceForAccessibility(spoken.join(' '));
  }, [items]);
}
