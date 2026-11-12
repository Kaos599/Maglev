/**
 * Haptics, as a small vocabulary. Call sites say what happened, never how it should feel.
 *
 *   select  A choice changed: tab, segmented control, toggle, chip, radio, checkbox, entering selection.
 *   tap     A button press where feedback helps: paste, pick a file, play or pause. Not every press.
 *   commit  The user started something: add a torrent, start a download.
 *   done    A positive outcome the user waited for: files freed, magnet copied, .torrent saved.
 *   warn    A destructive step is about to happen: the delete confirmation opens.
 *   fail    An action the user took failed or was refused.
 *
 * Rules:
 *   1. At most one haptic per user action. Pick the verb for the outcome, not one per step.
 *   2. Only the user's own actions buzz. Nothing on mount, on scroll, from a timer or from an
 *      engine event. A download finishing does not buzz: the notification covers it.
 *   3. Do not call haptic() inside useEffect. Call it from the handler that caused it.
 *   4. Nothing outside this file imports expo-haptics (scripts/test-haptics.js enforces all of this).
 *
 * There is no haptics preference in Settings, so none is read here.
 */
import * as Haptics from 'expo-haptics';

export const HAPTIC_VERBS = ['select', 'tap', 'commit', 'done', 'warn', 'fail'] as const;
export type HapticVerb = (typeof HAPTIC_VERBS)[number];

/** Safe on web, in Node tests and on hardware without a vibration motor: it never throws. */
export function haptic(verb: HapticVerb): void {
  try {
    switch (verb) {
      case 'select':
        Haptics.selectionAsync().catch(() => {});
        break;
      case 'commit':
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
        break;
      case 'done':
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        break;
      case 'warn':
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
        break;
      case 'fail':
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
        break;
      case 'tap':
      default:
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        break;
    }
  } catch {
    // Non-fatal: haptics are unavailable here.
  }
}
