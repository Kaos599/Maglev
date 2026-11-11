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
import { x1337 } from './x1337.ts';

/** Built-in providers, in default priority order. */
export const PROVIDERS: SearchProvider[] = [knaben, torrentscsv, archive, nyaa, yts, tpb, bitsearch, linuxtracker, sukebei, eztv, subsplease, animetosho, x1337];

export { knaben, torrentscsv, archive, nyaa, yts, tpb, bitsearch, linuxtracker, sukebei, eztv, subsplease, animetosho, x1337 };

// General and adult providers ported from prajwalch/TorrentSearch (MIT).
import { limetorrents } from './limetorrents.ts';
import { torrentdownloads } from './torrentdownloads.ts';
import { torrentdownload } from './torrentdownload.ts';
import { therarbg } from './therarbg.ts';
import { ext } from './ext.ts';
import { mypornclub } from './mypornclub.ts';
import { xxxclub } from './xxxclub.ts';
import { xxxtracker } from './xxxtracker.ts';

PROVIDERS.push(limetorrents, torrentdownloads, torrentdownload, therarbg, ext, mypornclub, xxxclub, xxxtracker);

export { limetorrents, torrentdownloads, torrentdownload, therarbg, ext, mypornclub, xxxclub, xxxtracker };
