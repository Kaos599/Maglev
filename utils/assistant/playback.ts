// Playback advice from a parsed release name and the device codec probe
// (docs/ASSISTANT_DESIGN.md section 9 "On your phone:", D3). Pure TypeScript, never throws.
// Rule: an unknown probe never gives "smooth".
import type { ParsedRelease } from './releaseName';
import type { PlaybackSupport, CodecSupport } from '../../modules/maglev-engine/src/MaglevEngine.types';

export type PlaybackVerdict = 'smooth' | 'may_stutter' | 'needs_other_player' | 'unknown';

export interface PlaybackAdvice {
  verdict: PlaybackVerdict;
  /** The "On your phone:" value. null when unknown: the UI hides the line. */
  label: 'Plays smoothly' | 'May stutter' | 'Needs another player' | null;
  /** One plain sentence. */
  reason: string;
}

const LABELS: Record<PlaybackVerdict, PlaybackAdvice['label']> = {
  smooth: 'Plays smoothly',
  may_stutter: 'May stutter',
  needs_other_player: 'Needs another player',
  unknown: null,
};

function advice(verdict: PlaybackVerdict, reason: string): PlaybackAdvice {
  return { verdict, label: LABELS[verdict], reason };
}

function fromLevel(level: CodecSupport | undefined, what: string): PlaybackAdvice {
  switch (level) {
    case 'hardware': return advice('smooth', `Your phone decodes ${what} in hardware.`);
    case 'software': return advice('may_stutter', `Your phone decodes ${what} in software, which can stutter and drain the battery.`);
    case 'none': return advice('needs_other_player', `Your phone can't decode ${what}. Try VLC or Just Player.`);
    default: return advice('unknown', `Can't tell yet whether your phone plays ${what}.`);
  }
}

export function playbackVerdict(parsed: ParsedRelease, support: PlaybackSupport | null | undefined): PlaybackAdvice {
  if (!support) return advice('unknown', "Your phone's video support isn't known yet.");

  const tenBit = parsed.bitDepth === 10;
  const hdr = parsed.hdr ?? [];
  const wantsHdr = hdr.includes('hdr10') || hdr.includes('hdr10plus') || hdr.includes('hlg') || hdr.includes('dv');
  const deep = tenBit || wantsHdr;
  let base: PlaybackAdvice;

  switch (parsed.codec) {
    case 'avc':
      base = fromLevel(support.avc, 'H.264');
      // 10-bit H.264 (Hi10P) has almost no hardware decoders.
      if (tenBit && base.verdict !== 'needs_other_player') {
        base = advice('may_stutter', '10-bit H.264 is decoded in software on most phones and can stutter.');
      }
      break;
    case 'hevc':
      base = fromLevel(deep ? support.hevc10 : support.hevc, deep ? '10-bit HEVC' : 'HEVC');
      break;
    case 'av1':
      base = fromLevel(deep ? support.av1_10 : support.av1, deep ? '10-bit AV1' : 'AV1');
      break;
    case 'vp9':
      base = fromLevel(support.vp9, 'VP9');
      break;
    default:
      return advice('unknown', "The name doesn't say how the video is encoded.");
  }

  if (base.verdict === 'unknown' || base.verdict === 'needs_other_player') return base;

  // Dolby Vision without a plain HDR10 layer needs a Dolby Vision decoder.
  if (hdr.includes('dv')) {
    if (parsed.dvFallback === false) {
      if (support.dolbyVision === 'none') return advice('needs_other_player', "This is Dolby Vision and your phone can't decode it. Try VLC or Just Player.");
      if (support.dolbyVision === 'unknown') return advice('unknown', "Can't tell yet whether your phone plays Dolby Vision.");
      if (support.dolbyVision === 'software') return advice('may_stutter', 'Your phone decodes Dolby Vision in software, which can stutter.');
    } else if (support.dolbyVision === 'none' && base.verdict === 'smooth') {
      return advice('smooth', 'Plays as HDR10. Your phone has no Dolby Vision, so colors may look slightly off.');
    }
  }

  if (base.verdict === 'smooth' && (hdr.includes('hdr10') || hdr.includes('hdr10plus')) && support.hdr10 === false) {
    return advice('smooth', `${base.reason} Your screen has no HDR, so colors may look washed out.`);
  }
  return base;
}
