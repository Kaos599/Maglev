/** Subtitle sources, batch 1 (contract 36.3). Owned by one porting agent; the registry imports this array. */
import type { SubtitleProvider } from '../types.ts';
import { gestdown } from './gestdown.ts';
import { napisy24 } from './napisy24.ts';
import { regielive } from './regielive.ts';
import { subtis } from './subtis.ts';
import { vladoon } from './vladoon.ts';

export const BATCH_1: SubtitleProvider[] = [gestdown, napisy24, regielive, subtis, vladoon];
