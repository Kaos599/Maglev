/** Subtitle sources, batch 2 (contract 36.3). Owned by one porting agent; the registry imports this array. */
import type { SubtitleProvider } from '../types.ts';
import { moviesubtitles } from './moviesubtitles.ts';
import { subf2m } from './subf2m.ts';
import { subtitlecat } from './subtitlecat.ts';
import { tvsubtitles } from './tvsubtitles.ts';
import { yifysubtitles } from './yifysubtitles.ts';

// Not ported (see the report): isubtitles (every download answers HTTP 500), my_subs (site unreachable, HTTP 522).
export const BATCH_2: SubtitleProvider[] = [subf2m, yifysubtitles, subtitlecat, moviesubtitles, tvsubtitles];
