import { useEffect, useRef, useState } from 'react';
import { useWindowDimensions } from 'react-native';
import type { StatusOpts } from './model';
import { holdSpeed, shouldShortenAmount, type LineLayout, type SpeedHoldState } from './speedHold';

/**
 * What the card needs to pick the right side of its status line: the speed hold (speed stays for a few seconds
 * after data stops) and the large-font short amount. Keyed by id, because lists recycle cards.
 * `speedBytes` is 0 for anything that is not downloading.
 */
export function useStatusOpts(id: string, speedBytes: number, layout: Pick<LineLayout, 'hasRail' | 'hasPlay' | 'hasAction'>): StatusOpts {
  const { fontScale, width } = useWindowDimensions();
  const ref = useRef<{ id: string; state: SpeedHoldState }>({ id, state: { lastFlowAt: null } });
  if (ref.current.id !== id) ref.current = { id, state: { lastFlowAt: null } };
  const r = holdSpeed(ref.current.state, speedBytes, Date.now());
  ref.current.state = r.state;
  const [, tick] = useState(0);
  // Telemetry may stop arriving when the speed is 0: wake up once the hold runs out.
  useEffect(() => {
    if (!(r.hold && speedBytes <= 0 && r.msLeft > 0)) return undefined;
    const h = setTimeout(() => tick((n) => n + 1), r.msLeft + 20);
    return () => clearTimeout(h);
  }, [r.hold, r.msLeft, speedBytes]);
  return { speedHold: r.hold, shortAmount: (amountChars) => shouldShortenAmount({ ...layout, windowWidth: width, fontScale }, amountChars) };
}
