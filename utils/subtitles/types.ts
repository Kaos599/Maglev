// Subtitle provider interface. Types only.
export type SubFormat = 'srt' | 'ass' | 'ssa' | 'vtt';
export interface SubtitleQuery {
  fileName: string; // video file name, no folders
  videoBytes: number;
  hash?: string; // 16 lowercase hex; only for a finished local file
  title: string;
  year?: number;
  season?: number;
  episode?: number;
  absoluteEpisode?: number;
  episodeConfidence: 'sure' | 'guess' | 'none';
  languages: string[]; // in priority order
}
export interface SubtitleCandidate {
  providerId: string;
  id: string; // id is opaque to the app
  language: string; // normalised: ISO 639-1 or a regional tag such as pt-BR
  releaseName: string;
  hearingImpaired?: boolean;
  format?: SubFormat; // when the source says; else learned on download
  matchedBy: 'hash' | 'release' | 'title';
  downloads?: number;
  uploadedAt?: number;
}
export type SubtitlePayload =
  | { kind: 'text'; bytes: Uint8Array; format: SubFormat }
  | { kind: 'zip'; bytes: Uint8Array }; // the payload step picks the member
export interface SubtitleContext {
  signal: AbortSignal;
  baseUrl: string;
}
export interface SubtitleProvider {
  id: string;
  name: string;
  homepage: string;
  mirrors: string[];
  languages: string[] | 'many';
  kinds: ('movie' | 'episode')[];
  matches: ('hash' | 'name' | 'imdb')[];
  group: 'A' | 'B';
  /** A source with one subject: the off-sources count puts these first for anime. */
  focus?: 'anime';
  enabledByDefault: boolean; // A: true when coverage is broad; regional and B: false
  search(q: SubtitleQuery, ctx: SubtitleContext): Promise<SubtitleCandidate[]>;
  download(c: SubtitleCandidate, ctx: SubtitleContext): Promise<SubtitlePayload>;
}
