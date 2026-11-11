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

// Games, books and regional sources (ported from TorrentSearch). All off by default.
import { fitgirl } from './fitgirl.ts';
import { blueroms } from './blueroms.ts';
import { audiobookbay } from './audiobookbay.ts';
import { epublibre } from './epublibre.ts';
import { rutor } from './rutor.ts';
import { megapeer } from './megapeer.ts';
import { oxtorrent } from './oxtorrent.ts';
import { torrent9 } from './torrent9.ts';

PROVIDERS.push(fitgirl, blueroms, audiobookbay, epublibre, rutor, megapeer, oxtorrent, torrent9);

export { fitgirl, blueroms, audiobookbay, epublibre, rutor, megapeer, oxtorrent, torrent9 };
