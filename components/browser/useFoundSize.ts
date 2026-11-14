import { useEffect, useState } from 'react';
import type { FoundItem, StreamProbe } from 'maglev-engine';
import { createSizeProber, fetchContentLength, isProbeable, streamEstimate } from '../../utils/foundSize';
import { downloadHeaders } from './FoundDownload';

export interface FoundSize {
  /** Bytes, or null while unknown. */
  size: number | null;
  /** True when `size` comes from a stream manifest (bandwidth x duration). */
  estimate: boolean;
  /** The height of the quality the estimate is for. */
  height: number | null;
}

type ProbeStream = (url: string, options?: { headers?: Record<string, string> }) => Promise<{ ok: boolean } & Partial<StreamProbe>>;

// One prober for the whole app: sizes are cached per address, three requests at a time.
const prober = createSizeProber();

const UNKNOWN: FoundSize = { size: null, estimate: false, height: null };

/**
 * The size of a found file. Rows ask only when they are on screen. The engine's own size wins; then a HEAD
 * (or ranged GET) for a direct file, or the stream probe for HLS and DASH. Unknown stays unknown.
 */
export function useFoundSize(item: FoundItem, userAgent: string, probeStream: ProbeStream): FoundSize {
  const own = item.size != null && item.size > 0 ? item.size : null;
  const key = `${item.stream ? 's' : 'f'}:${item.url}`;
  const [found, setFound] = useState<FoundSize>(() => prober.peek<FoundSize>(key) ?? UNKNOWN);

  useEffect(() => {
    if (own != null || !isProbeable(item.url)) return;
    let live = true;
    void prober
      .run<FoundSize>(key, async () => {
        const headers = await downloadHeaders({ url: item.url, pageUrl: item.pageUrl, userAgent });
        if (item.stream) {
          const res = await probeStream(item.url, { headers });
          const est = res.ok ? streamEstimate(res.variants ?? []) : null;
          return est ? { size: est.bytes, estimate: true, height: est.height } : UNKNOWN;
        }
        return { size: await fetchContentLength(item.url, headers), estimate: false, height: null };
      })
      .then((v) => live && setFound(v ?? UNKNOWN));
    return () => {
      live = false;
    };
  }, [key, own, item.url, item.pageUrl, item.stream, userAgent, probeStream]);

  return own != null ? { size: own, estimate: false, height: null } : found;
}
