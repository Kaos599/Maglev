import { mobileDataLine } from '../constants/copy.ts';

/**
 * The line to show before a one-tap add (Search, Feeds) so a big file never starts on mobile data
 * by surprise. Returns null when there is nothing to say: on Wi-Fi, or when the size is unknown
 * and Wi-Fi-only is off. When Wi-Fi-only is on and the phone is on mobile data, the add waits.
 */
export function oneTapAddNote(args: {
  sizeBytes: number | null | undefined;
  onMetered: boolean;
  wifiOnly: boolean;
}): string | null {
  return mobileDataLine(args.onMetered, args.wifiOnly, args.sizeBytes ?? null);
}
