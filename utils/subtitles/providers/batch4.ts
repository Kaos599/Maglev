/** Subtitle sources, batch 4 (contract 36.3). Owned by one porting agent; the registry imports this array. */
import type { SubtitleProvider } from '../types.ts';
import { subsunacs } from './subsunacs.ts';
import { subtitrarinoi } from './subtitrarinoi.ts';
import { supersubtitles } from './supersubtitles.ts';
import { titrari } from './titrari.ts';

export const BATCH_4: SubtitleProvider[] = [subsunacs, subtitrarinoi, supersubtitles, titrari];
