import { AppState } from 'react-native';
import { refreshFeedsNewCountFromStorage } from './feeds';

// Kept apart from utils/feeds.ts: react-native cannot load under node, and the feed tests import feeds.ts.
/** Sets the Feeds badge count at app start and again whenever the app comes back to the foreground. */
export function startFeedsBadge(): () => void {
  refreshFeedsNewCountFromStorage();
  const sub = AppState.addEventListener('change', (s) => {
    if (s === 'active') refreshFeedsNewCountFromStorage();
  });
  return () => sub.remove();
}
