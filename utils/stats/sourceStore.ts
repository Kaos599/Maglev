/** The app's single origin-tag store, over the kv store. Call `noteOrigin` where an add knows where it came from. */
import { kvGet, kvSet } from '../prefs/kv.ts';
import { createOriginTags } from './source.ts';

export const originTags = createOriginTags({ get: kvGet, set: kvSet });

export const noteOrigin = originTags.note;
