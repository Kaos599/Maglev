import type { SearchProvider } from '../types.ts';
import { knaben } from './knaben.ts';
import { torrentscsv } from './torrentscsv.ts';
import { archive } from './archive.ts';
import { nyaa } from './nyaa.ts';
import { yts } from './yts.ts';
import { tpb } from './tpb.ts';
import { bitsearch } from './bitsearch.ts';
import { linuxtracker } from './linuxtracker.ts';
import { sukebei } from './sukebei.ts';
import { eztv } from './eztv.ts';
import { subsplease } from './subsplease.ts';
import { animetosho } from './animetosho.ts';

/** Built-in providers, in default priority order. */
export const PROVIDERS: SearchProvider[] = [knaben, torrentscsv, archive, nyaa, yts, tpb, bitsearch, linuxtracker, sukebei, eztv, subsplease, animetosho];

export { knaben, torrentscsv, archive, nyaa, yts, tpb, bitsearch, linuxtracker, sukebei, eztv, subsplease, animetosho };
