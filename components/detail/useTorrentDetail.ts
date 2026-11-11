import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { maglevEngine, type Detail } from 'maglev-engine';

export type DetailStatus = 'loading' | 'ready' | 'missing' | 'error';

const POLL_MS = 1000;

/**
 * Polls getDetail every second while the screen is focused (and only then).
 * Piece cells are fetched on the same tick when `wantPieces` is true.
 * `tick` increments on every successful sample so charts can append real history.
 */
export function useTorrentDetail(id: string | undefined, wantPieces: boolean) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [pieces, setPieces] = useState<number[] | null>(null);
  const [status, setStatus] = useState<DetailStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const wantRef = useRef(wantPieces);
  wantRef.current = wantPieces;
  const runRef = useRef<(() => Promise<void>) | null>(null);
  const inFlight = useRef(false);
  const hasData = useRef(false);

  useFocusEffect(
    useCallback(() => {
      if (!id) return undefined;
      let alive = true;
      const run = async () => {
        if (inFlight.current) return;
        inFlight.current = true;
        try {
          const res = await maglevEngine.getDetail(id);
          if (!alive) return;
          if (res.ok) {
            hasData.current = true;
            setDetail(res);
            setStatus('ready');
            setError(null);
            setTick((t) => t + 1);
            if (wantRef.current) {
              try {
                const cells = await maglevEngine.getPieceBitfield(id);
                if (alive) setPieces(cells);
              } catch {
                // pieces are optional; keep the last grid
              }
            }
          } else if (res.code === 'NOT_FOUND') {
            setStatus('missing');
          } else {
            setError(res.message);
            if (!hasData.current) setStatus('error');
          }
        } catch (e) {
          if (!alive) return;
          setError(e instanceof Error ? e.message : 'Could not read torrent info.');
          if (!hasData.current) setStatus('error');
        } finally {
          inFlight.current = false;
        }
      };
      runRef.current = run;
      void run();
      const timer = setInterval(() => void run(), POLL_MS);
      return () => {
        alive = false;
        clearInterval(timer);
        runRef.current = null;
      };
    }, [id]),
  );

  // Fetch the grid right away when the Pieces tab opens instead of waiting a tick.
  useEffect(() => {
    if (wantPieces) void runRef.current?.();
  }, [wantPieces]);

  const retry = useCallback(() => {
    setStatus('loading');
    void runRef.current?.();
  }, []);

  return { detail, pieces, status, error, tick, retry };
}
