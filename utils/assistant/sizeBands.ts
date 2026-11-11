/**
 * Expected size bands for the assistant (docs/ASSISTANT_DESIGN.md §3.3, "Sanity" table).
 *
 * Pure: no React, no engine. Numbers are GB per hour of runtime. They are
 * heuristic. The 1080p and 720p avc/hevc figures come from one vendor table at
 * 30 fps; remux and 4K upper ends come from forum notes; the band widths are
 * judgement (§3.3 intro). Tune them on fixtures, not by feel.
 */

export type BandCodec = 'avc' | 'hevc' | 'remux';

export interface SizeBand {
  /** Expected low, GB per hour. */
  low: number;
  /** Expected high, GB per hour. */
  high: number;
}

/** Keys are `<resolution height>-<codec class>`. Each row cites its §3.3 band table line. */
const BANDS: Readonly<Record<string, SizeBand>> = {
  '480-avc': { low: 0.4, high: 1.5 }, // §3.3 band table: "480p avc | 0.4 | 1.5"
  '720-avc': { low: 0.8, high: 2.5 }, // §3.3 band table: "720p avc | 0.8 | 2.5"
  '720-hevc': { low: 0.4, high: 1.6 }, // §3.3 band table: "720p hevc/av1 | 0.4 | 1.6"
  '1080-avc': { low: 1.5, high: 5 }, // §3.3 band table: "1080p avc | 1.5 | 5"
  '1080-hevc': { low: 0.9, high: 3.5 }, // §3.3 band table: "1080p hevc/av1 | 0.9 | 3.5"
  '2160-hevc': { low: 4, high: 15 }, // §3.3 band table: "2160p hevc/av1 (encode) | 4 | 15"
  '1080-remux': { low: 15, high: 40 }, // §3.3 band table: "1080p remux | 15 | 40"
  '2160-remux': { low: 25, high: 80 }, // §3.3 band table: "2160p remux | 25 | 80"
};

/**
 * Below this fraction of the low end, a file is too small to be what its name claims.
 * §3.3: "Below low but at least 0.6x low: 5 ... Below 0.6x low: 0 and flag too_small_for_claim".
 * Also the §3.4 fake-upload rule "Largest video is below 0.6x the low end of its band".
 */
export const TOO_SMALL_FRACTION = 0.6;

/** Default runtimes in minutes. §3.1: "film: user or default 110; episode: 45". */
export const DEFAULT_FILM_RUNTIME_MIN = 110;
export const DEFAULT_EPISODE_RUNTIME_MIN = 45;

/**
 * Looks up the band for a resolution height and codec class.
 *
 * Lookup rules (choices where §3.3 has no row, all lenient):
 * - 576 uses the 480 row (it is standard definition).
 * - avc at 2160 has no row of its own; it uses the 2160 hevc row.
 * - hevc/av1 at 480 has no row; it uses the 480 avc row (the same low end).
 * - remux below 1080, and anything above 2160, has no band: returns undefined.
 */
export function sizeBand(resolution: number | undefined, codec: BandCodec): SizeBand | undefined {
  if (resolution === undefined) return undefined;
  const res = resolution === 576 ? 480 : resolution;
  const exact = BANDS[`${res}-${codec}`];
  if (exact) return exact;
  if (codec === 'avc') return BANDS[`${res}-hevc`];
  if (codec === 'hevc') return BANDS[`${res}-avc`];
  return undefined;
}

/** Just the low end, in GB per hour. Used by the file-list safety check (§3.4). */
export function lowGbPerHour(resolution: number | undefined, codec: BandCodec): number | undefined {
  return sizeBand(resolution, codec)?.low;
}
