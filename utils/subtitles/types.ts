// Subtitle provider interface (docs/NATIVE_CONTRACT.md section 36.3). Types only.
export type SubFormat = 'srt' | 'ass' | 'ssa' | 'vtt';
export interface SubtitleQuery {
  fileName: string; // video file name, no folders
  videoBytes: number;
  hash?: string; // 16 lowercase hex (36.6); only for a finished local file
  title: string;
  year?: number;
  season?: number;
  episode?: number;
  absoluteEpisode?: number;
  episodeConfidence: 'sure' | 'guess' | 'none';
  languages: string[]; // 36.2 order
}
export interface SubtitleCandidate {
  providerId: string;
  id: string; // id is opaque to the app
  language: string; // normalised as in 36.2
  releaseName: string;
  hearingImpaired?: boolean;
  format?: SubFormat; // when the source says; else learned on download
  matchedBy: 'hash' | 'release' | 'title';
  downloads?: number;
  uploadedAt?: number;
}
export type SubtitlePayload =
  | { kind: 'text'; bytes: Uint8Array; format: SubFormat }
  | { kind: 'zip'; bytes: Uint8Array }; // 36.7 picks the member
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
  /** A source with one subject (36 / 45.5): the off-sources count puts these first for anime. */
  focus?: 'anime';
  enabledByDefault: boolean; // A: true when coverage is broad; regional and B: false
  search(q: SubtitleQuery, ctx: SubtitleContext): Promise<SubtitleCandidate[]>;
  download(c: SubtitleCandidate, ctx: SubtitleContext): Promise<SubtitlePayload>;
}
