import { useEffect, useRef, useState } from 'react';
import { useWindowDimensions } from 'react-native';
import type { StatusOpts } from './model';
import { QUIET_MS, feedFlow, flowHold, lastDataAgoMs, quietMs, type FlowRecord } from './flowClock';
import { holdSpeed, shouldShortenAmount, type LineLayout, type SpeedHoldState } from './speedHold';

/**
 * What the card needs to pick the right side of its status line: the speed hold (speed stays for a few seconds
 * after data stops) and the large-font short amount. Keyed by id, because lists recycle cards.
 * `speedBytes` is 0 for anything that is not downloading. `downloading` feeds the shared flow clock (NATIVE_CONTRACT 43.1),
 * which says how long no data has arrived; the card and the detail page read the same record.
 */
export function useStatusOpts(
  id: string,
  speedBytes: number,
  layout: Pick<LineLayout, 'hasRail' | 'hasPlay' | 'hasAction'>,
  downloading: boolean = speedBytes > 0,
): StatusOpts {
  const { fontScale, width } = useWindowDimensions();
  const ref = useRef<{ id: string; state: SpeedHoldState }>({ id, state: { lastFlowAt: null } });
  if (ref.current.id !== id) ref.current = { id, state: { lastFlowAt: null } };
  const r = holdSpeed(ref.current.state, speedBytes, Date.now());
  ref.current.state = r.state;
  const [, tick] = useState(0);
  const now = Date.now();
  const quiet = quietMs(feedFlow(id, { downloading, speedBytes }, now), now);
  // Wake once the quiet run reaches QUIET_MS, so "Downloading" turns into "Waiting for peers" with no new telemetry.
  const quietWake = downloading && speedBytes <= 0 && quiet < QUIET_MS ? QUIET_MS - quiet + 20 : 0;
  useEffect(() => {
    if (quietWake <= 0) return undefined;
    const h = setTimeout(() => tick((n) => n + 1), quietWake);
    return () => clearTimeout(h);
  }, [quietWake]);
  // Telemetry may stop arriving when the speed is 0: wake up once the hold runs out.
  useEffect(() => {
    if (!(r.hold && speedBytes <= 0 && r.msLeft > 0)) return undefined;
    const h = setTimeout(() => tick((n) => n + 1), r.msLeft + 20);
    return () => clearTimeout(h);
  }, [r.hold, r.msLeft, speedBytes]);
  return { speedHold: r.hold, quietMs: quiet, shortAmount: (amountChars) => shouldShortenAmount({ ...layout, windowWidth: width, fontScale }, amountChars) };
}

/**
 * The flow clock for a detail page (NATIVE_CONTRACT 43.1): feeds the shared record from the telemetry the page already has
 * and ticks once a second while data is not flowing, so "Trying for" and the quiet threshold move on their own.
 * Returns what the status functions and the "why" block read.
 */
export function useFlowClock(id: string, downloading: boolean, speedBytes: number): { speedHold: boolean; quietMs: number; lastDataAgoMs: number | null; record: FlowRecord } {
  const now = Date.now();
  const record = feedFlow(id, { downloading, speedBytes }, now);
  const [, tick] = useState(0);
  const idle = downloading && !(speedBytes > 0);
  useEffect(() => {
    if (!idle) return undefined;
    const h = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(h);
  }, [idle]);
  return { speedHold: flowHold(record, now), quietMs: quietMs(record, now), lastDataAgoMs: lastDataAgoMs(record, now), record };
}
