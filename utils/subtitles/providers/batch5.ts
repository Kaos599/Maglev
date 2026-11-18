/** Subtitle sources, batch 5 (contract 36.3). Owned by one porting agent; the registry imports this array. */
import type { SubtitleProvider } from '../types.ts';
import { nekur } from './nekur.ts';
import { soustitreseu } from './soustitreseu.ts';
import { subclub } from './subclub.ts';
import { subsynchro } from './subsynchro.ts';
import { subtitlestar } from './subtitlestar.ts';
import { subtitulamostv } from './subtitulamostv.ts';

// Not ported (see the batch report): subcentral (site down for maintenance, forum with session tokens) and
// subtitriid (a cookie check answers 403 to a request that carries no cookies).
export const BATCH_5: SubtitleProvider[] = [soustitreseu, subsynchro, subclub, nekur, subtitlestar, subtitulamostv];
