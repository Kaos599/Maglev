/**
 * Expected size bands for the assistant: how many GB per hour a release of a given resolution and codec should be.
 * A file far below its band is probably not what its name claims.
 *
 * Pure: no React, no engine. Numbers are GB per hour of runtime. They are
 * heuristic. The 1080p and 720p avc/hevc figures come from one vendor table at
 * 30 fps; remux and 4K upper ends come from forum notes; the band widths are
 * judgement. Tune them on fixtures, not by feel.
 */

export type BandCodec = 'avc' | 'hevc' | 'remux';

export interface SizeBand {
  /** Expected low, GB per hour. */
  low: number;
  /** Expected high, GB per hour. */
  high: number;
}

/** Keys are `<resolution height>-<codec class>`: expected low and high GB per hour. */
const BANDS: Readonly<Record<string, SizeBand>> = {
  '480-avc': { low: 0.4, high: 1.5 },
  '720-avc': { low: 0.8, high: 2.5 },
  '720-hevc': { low: 0.4, high: 1.6 },
  '1080-avc': { low: 1.5, high: 5 },
  '1080-hevc': { low: 0.9, high: 3.5 },
  '2160-hevc': { low: 4, high: 15 },
  '1080-remux': { low: 15, high: 40 },
  '2160-remux': { low: 25, high: 80 },
};

/**
 * Below this fraction of the low end, a file is too small to be what its name claims (red).
 * The assistant shows this as red: "probably not what the name says".
 */
export const TOO_SMALL_FRACTION = 0.25;

/**
 * Below this fraction of the low end, a file is smaller than usual (amber). Between this and the
 * low end it is a normal, slimmer encode and gets no warning.
 */
export const SMALL_FRACTION = 0.5;

/** Default runtimes in minutes: a film 110 (unless the user says), an episode 45, an anime episode 24. */
export const DEFAULT_FILM_RUNTIME_MIN = 110;
export const DEFAULT_EPISODE_RUNTIME_MIN = 45;
export const DEFAULT_ANIME_EPISODE_RUNTIME_MIN = 24;

/**
 * Looks up the band for a resolution height and codec class.
 *
 * Lookup rules (choices where the band table has no row, all lenient):
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

/** Just the low end, in GB per hour. Used by the file-list safety check. */
export function lowGbPerHour(resolution: number | undefined, codec: BandCodec): number | undefined {
  return sizeBand(resolution, codec)?.low;
}
