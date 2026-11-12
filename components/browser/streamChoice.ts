/**
 * Pure choices for the stream sheet (docs/NATIVE_CONTRACT.md section 24.8): quality labels,
 * the preselected quality and audio track, and the selection sent to startDownload.
 */
import type { StreamAudioTrack, StreamKind, StreamProbe, StreamSelection, StreamVariant } from '../../modules/maglev-engine/src/MaglevEngine.types';
import { formatBytes } from '../../constants/format.ts';

/** The tallest variant; without heights, the one with the most bandwidth. Null when there are none. */
export function defaultVariant(variants: readonly StreamVariant[]): StreamVariant | null {
  let best: StreamVariant | null = null;
  for (const v of variants) {
    if (!best || (v.height ?? -1) > (best.height ?? -1) || ((v.height ?? -1) === (best.height ?? -1) && v.bandwidth > best.bandwidth)) best = v;
  }
  return best;
}

const VIDEO_CODEC = /(^|,)\s*(avc[1-4]|hvc1|hev1|vp0?[89]|av01|dv[ah][1e]|mp4v|theora)/i;

/** True for a variant that has no picture: no height and CODECS that name no video codec. */
export function isAudioOnly(v: StreamVariant): boolean {
  return v.height == null && !!v.codecs?.trim() && !VIDEO_CODEC.test(v.codecs);
}

/** "1080p", "Audio only", or Low / Medium / High quality by bandwidth when the stream gives no height. */
export function qualityName(v: StreamVariant, all: readonly StreamVariant[]): string {
  if (v.height != null) return `${v.height}p`;
  if (isAudioOnly(v)) return 'Audio only';
  const blind = all.filter((x) => x.height == null && !isAudioOnly(x)).sort((a, b) => a.bandwidth - b.bandwidth);
  if (blind.length <= 1) return 'Medium quality';
  const i = blind.findIndex((x) => x.id === v.id);
  if (i <= 0) return 'Low quality';
  if (i === blind.length - 1) return 'High quality';
  return 'Medium quality';
}

/** "1080p · about 1.2 GB". The size is left out when it is unknown. */
export function qualityLabel(v: StreamVariant, all: readonly StreamVariant[]): string {
  const name = qualityName(v, all);
  return v.estBytes != null && v.estBytes > 0 ? `${name} · about ${formatBytes(v.estBytes)}` : name;
}

/** The track name, else its language, else "Track N" (N counts from 1). */
export function audioLabel(t: StreamAudioTrack, index: number): string {
  return t.name?.trim() || t.lang?.trim() || `Track ${index + 1}`;
}

/** True when the sheet should ask for an audio language. */
export function needsAudioPicker(v: StreamVariant | null | undefined, tracks: readonly StreamAudioTrack[]): boolean {
  return !!v && v.audio === 'separate' && tracks.length > 1;
}

/** The first track, unless the user picked one that still exists. Null when there are none. */
export function defaultAudio(tracks: readonly StreamAudioTrack[], pickedId?: string | null): string | null {
  return tracks.find((t) => t.id === pickedId)?.id ?? tracks[0]?.id ?? null;
}

/** What startDownload receives as `stream`. Audio is sent only for a variant whose audio is separate. */
export function buildSelection(kind: StreamKind, probe: Pick<StreamProbe, 'audioTracks'>, v: StreamVariant, pickedAudio?: string | null): StreamSelection {
  const sel: StreamSelection = { kind, variantId: v.id };
  if (v.audio === 'separate') sel.audioId = defaultAudio(probe.audioTracks, pickedAudio);
  return sel;
}

/** "hls" for a `.m3u8` address, "dash" for `.mpd`, else null. Looks at the path only (no network). */
export function streamKindOfLink(url: string): StreamKind | null {
  const path = (url ?? '').split(/[?#]/)[0].toLowerCase();
  return path.endsWith('.m3u8') ? 'hls' : path.endsWith('.mpd') ? 'dash' : null;
}
