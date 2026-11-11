/**
 * Disk-space aware advice (docs/ASSISTANT_DESIGN.md §6).
 *
 * Pure: no React, no react-native, no engine. Free space and pending need come
 * in as arguments. Every number in a message is computed here and formatted
 * with formatBytes. Unknown input produces a U1/U2 advice and never a guess.
 * The model only words the output; it never picks numbers.
 *
 * Choices where §6 leaves room (listed in the test file header too):
 * - Partial packs (R2, R10) assume episodes are the same size: pack bytes / episode count.
 *   They use only counts whose admit() result is Fits, so the text never states a Tight fit.
 * - R3/R4 only name an existing candidate whose admit() result is Fits, since the text says "it fits".
 *   R7 offers a smaller Fits option too. R11/R12 accept any non-DoesntFit alternative.
 * - AV1 is eligible for R3 only with `av1Hardware: true` or at 720p or smaller.
 * - Step-down ladder for R4 is 2160 -> 1080 -> 720 -> 480. 576 counts as 480 and has no step.
 * - R8 fires once, on the first candidate whose result gets worse under staging factor 2.
 * - R9 fires once. Pausing a download does not release its reserved space in admit(),
 *   so no pause action is offered.
 * - R10 "many seasons" means 3 or more.
 * - R11 looks at candidates[0] only: the caller passes candidates best first.
 * - Output is sorted by rule number. Ties keep candidate order.
 */
import { formatBytes } from '../../constants/format.ts';
import { ADMISSION_RESERVE_BYTES, admit } from '../admission.ts';
import type { AdmissionResult } from '../admission.ts';
import { parseRelease } from './releaseName.ts';
import type { ParsedRelease } from './releaseName.ts';
import type { Profile, Ranked } from './scoring.ts';

/** One option the user could pick. `name` is the release name; it is parsed here. */
export interface DiskCandidate {
  id: string;
  name: string;
  /** undefined = size unknown. */
  sizeBytes?: number;
  /** Total episodes when this is a season or series pack. Only counts of 2 or more are used. */
  episodes?: number;
}

export interface FinishedDownload {
  id: string;
  name: string;
  sizeBytes?: number;
  ageDays?: number;
}

export interface DiskAdviceInput {
  profile: Profile;
  /** undefined = free space unknown. */
  freeBytes?: number;
  /** undefined = unknown. Sum of what unfinished downloads still need. */
  pendingNeed?: number;
  /** 2 when the folder is SAF-staged, else 1. */
  stagingFactor: 1 | 2;
  /** Number of unfinished downloads, for the R9 sentence. */
  unfinishedCount?: number;
  /** Finished downloads that could be removed (R5). */
  finished?: readonly FinishedDownload[];
  storage?: { onSdCard?: boolean; hasRoomElsewhere?: boolean };
  /** R10. Seasons the user asked for. */
  wantedSeasons?: number;
  /** R10. True only when the user wants to watch while it downloads. */
  wantsWatchWhileDownloading?: boolean;
  /** R3. True when the probe says the phone decodes AV1 in hardware. */
  av1Hardware?: boolean;
}

export type DiskRuleId =
  | 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7' | 'R8' | 'R9' | 'R10' | 'R11' | 'R12'
  | 'U1' | 'U2';

export type DiskAction =
  | { kind: 'select_episodes'; candidateId: string; count: number; sequential: boolean }
  | { kind: 'choose_candidate'; candidateId: string }
  | {
      kind: 'ask_which_to_remove';
      items: { id: string; name: string; sizeBytes?: number; ageDays?: number; coversShortfall: boolean }[];
    }
  | { kind: 'move_storage' }
  | { kind: 'change_folder'; to: 'default' };

export interface DiskAdvice {
  rule: DiskRuleId;
  /** One plain line. Numbers come from formatBytes. */
  text: string;
  action?: DiskAction;
}

/** Convert a scoring row into a candidate. Ranked order is kept by the caller. */
export function candidateFromRanked(r: Ranked, episodes?: number): DiskCandidate {
  return { id: r.id, name: r.parsed.raw, sizeBytes: r.result.sizeBytes, episodes };
}

// ---------------------------------------------------------------- internals

type Encoder = 'x264' | 'x265' | 'av1' | 'other';

interface View {
  id: string;
  title: string;
  key: string;
  encoder: Encoder;
  res?: number;
  lossless: boolean;
  size?: number;
  episodes?: number;
  perEpisode?: number;
}

interface Space {
  freeBytes: number;
  pendingNeed: number;
}

const LOSSLESS = new Set(['truehd', 'dtshd', 'flac']);
/** R4 step-down ladder. 576 is not on it: it counts as 480 and has no step. */
const STEP_LADDER = [2160, 1080, 720, 480];
/** R10: "many seasons" means this many or more. */
const MANY_SEASONS = 3;
const RANK: Record<AdmissionResult, number> = { Fits: 0, Tight: 1, DoesntFit: 2 };

function encoderOf(parsed: ParsedRelease): Encoder {
  if (parsed.codec === 'av1') return 'av1';
  if (parsed.encoder === 'x265' || parsed.codec === 'hevc') return 'x265';
  if (parsed.encoder === 'x264' || parsed.codec === 'avc') return 'x264';
  return 'other';
}

function validSize(n: number | undefined): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
}

function toView(c: DiskCandidate): View {
  const parsed = parseRelease(c.name);
  const title = parsed.title?.trim() || c.name.trim();
  const size = validSize(c.sizeBytes);
  const episodes = c.episodes !== undefined && c.episodes >= 2 ? Math.floor(c.episodes) : undefined;
  const audio = parsed.audio;
  return {
    id: c.id,
    title,
    key: title.toLowerCase().replace(/\s+/g, ' '),
    encoder: encoderOf(parsed),
    res: parsed.resolution,
    lossless: audio.length > 0 && audio.every((a) => LOSSLESS.has(a.codec)),
    size,
    episodes,
    perEpisode: size !== undefined && episodes !== undefined ? Math.floor(size / episodes) : undefined,
  };
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function pctSmaller(from: number, to: number): number {
  return Math.round(((from - to) / from) * 100);
}

/** Largest episode count k (1 to max) whose pro-rata size is Fits. Fits is monotone in k, so stop at the first miss. */
function largestFittingCount(v: View, max: number, space: Space, staging: 1 | 2): number {
  if (v.perEpisode === undefined) return 0;
  let best = 0;
  for (let k = 1; k <= max; k++) {
    const r = admit({ freeBytes: space.freeBytes, pendingNeed: space.pendingNeed, stagingFactor: staging, selectionBytes: v.perEpisode * k });
    if (r.result !== 'Fits') break;
    best = k;
  }
  return best;
}

// ---------------------------------------------------------------- main

/**
 * Advice for a set of candidates, in rule order (§6.1).
 *
 * Each DoesntFit candidate gets R1, then the ladder R2 to R6 when it applies.
 * Each Tight candidate gets R5 (when finished downloads exist) and R7.
 * R8 to R12 are context rules. Without free space or pending need, only U1, U2,
 * R11 and R12 can apply, because the rest need admission.
 */
export function diskAdvice(candidates: readonly DiskCandidate[], input: DiskAdviceInput): DiskAdvice[] {
  const views = candidates.map(toView);
  const staging = input.stagingFactor;
  const space: Space | undefined =
    input.freeBytes !== undefined && input.pendingNeed !== undefined
      ? { freeBytes: input.freeBytes, pendingNeed: input.pendingNeed }
      : undefined;
  const found: { n: number; advice: DiskAdvice }[] = [];
  const push = (n: number, advice: DiskAdvice): void => {
    found.push({ n, advice });
  };
  const f = formatBytes;
  const admitAt = (size: number, stagingFactor: 1 | 2 = staging) =>
    admit({ freeBytes: space?.freeBytes ?? 0, pendingNeed: space?.pendingNeed ?? 0, stagingFactor, selectionBytes: size });
  /** A same-title alternative with a known size that admit() does not reject. */
  const fitsAlt = (v: View, a: View): boolean =>
    a.id !== v.id && a.key === v.key && a.size !== undefined && (space === undefined || admitAt(a.size).result !== 'DoesntFit');
  /** Same, but Fits only. Used where the text says "and it fits". */
  const fitsOnly = (v: View, a: View): boolean =>
    fitsAlt(v, a) && a.size !== undefined && (space === undefined || admitAt(a.size).result === 'Fits');

  // U1 and U2: unknown inputs are said, never guessed.
  if (space === undefined) {
    const freeUnknown = input.freeBytes === undefined;
    push(0, {
      rule: 'U1',
      text: freeUnknown
        ? "I don't know how much space is free, so I can't check the fit."
        : "I don't know what your other downloads still need, so I can't check the fit.",
    });
  }
  for (const v of views) {
    if (v.size === undefined) {
      push(0, { rule: 'U2', text: `The size of ${v.title} is unknown, so I can't check it against your space.` });
    }
  }

  for (const v of views) {
    if (v.size === undefined || space === undefined) continue;
    const outcome = admitAt(v.size);

    if (outcome.result === 'DoesntFit') {
      // R1: state the verdict. Never offer "add anyway".
      push(1, {
        rule: 'R1',
        text: `${v.title} needs ${f(outcome.need)}, but only ${f(Math.max(0, outcome.budget))} is free for it after other downloads and ${f(ADMISSION_RESERVE_BYTES)} kept for the system. It doesn't fit.`,
      });

      // R2: a pack where some episodes fit now.
      if (v.episodes !== undefined) {
        const k = largestFittingCount(v, v.episodes - 1, space, staging);
        if (k >= 1 && v.perEpisode !== undefined) {
          const text = k === 1
            ? `This 1 episode fits (${f(v.perEpisode)}). The rest can come later.`
            : `These ${k} episodes fit (${f(k * v.perEpisode)}). The rest can come later.`;
          push(2, { rule: 'R2', text, action: { kind: 'select_episodes', candidateId: v.id, count: k, sequential: false } });
        }
      }

      // R3: same title as x265, or AV1 when the phone can take it.
      if (v.encoder === 'x264' || v.encoder === 'other') {
        const alt = views.find((a) =>
          fitsOnly(v, a)
          && a.size !== undefined && a.size < v.size!
          && (a.encoder === 'x265'
            || (a.encoder === 'av1' && (input.av1Hardware === true || (a.res !== undefined && a.res <= 720)))));
        if (alt && alt.size !== undefined) {
          const label = alt.encoder === 'x265' ? 'x265' : 'AV1';
          push(3, {
            rule: 'R3',
            text: `The ${label} copy of ${v.title} is ${f(alt.size)} (${pctSmaller(v.size, alt.size)}% smaller) and it fits.`,
            action: { kind: 'choose_candidate', candidateId: alt.id },
          });
        }
      }

      // R4: one resolution step down, when that copy fits.
      if (v.res !== undefined) {
        const i = STEP_LADDER.indexOf(v.res);
        const lower = i >= 0 && i < STEP_LADDER.length - 1 ? STEP_LADDER[i + 1] : undefined;
        if (lower !== undefined) {
          const alt = views.find((a) => fitsOnly(v, a) && a.res === lower && a.size !== undefined && a.size < v.size!);
          if (alt && alt.size !== undefined) {
            push(4, {
              rule: 'R4',
              text: `The ${lower}p copy of ${v.title} is ${f(alt.size)} (${pctSmaller(v.size, alt.size)}% smaller) and it fits.`,
              action: { kind: 'choose_candidate', candidateId: alt.id },
            });
          }
        }
      }
    }

    if (outcome.result === 'DoesntFit' || outcome.result === 'Tight') {
      // R5: finished downloads the user could remove.
      const finished = input.finished ?? [];
      if (finished.length > 0) {
        const sorted = [...finished].sort((a, b) => (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1));
        const shortfall = -outcome.leftAfter;
        const items = sorted.map((x) => ({
          id: x.id,
          name: x.name,
          sizeBytes: validSize(x.sizeBytes),
          ageDays: x.ageDays,
          coversShortfall: outcome.result === 'DoesntFit' && validSize(x.sizeBytes) !== undefined && x.sizeBytes! >= shortfall,
        }));
        const describe = (x: (typeof items)[number]) =>
          `${x.name} (${x.sizeBytes !== undefined ? f(x.sizeBytes) : 'size unknown'}, ${x.ageDays !== undefined ? `${x.ageDays} days old` : 'age unknown'})`;
        const top = items.slice(0, 3).map(describe).join('; ');
        const more = items.length > 3 ? `, and ${items.length - 3} more` : '';
        const lead = outcome.result === 'DoesntFit'
          ? `To fit, free up ${f(shortfall)}. Finished downloads you could remove: `
          : 'You could remove a finished download to leave more room. Finished downloads: ';
        push(5, { rule: 'R5', text: `${lead}${top}${more}.`, action: { kind: 'ask_which_to_remove', items } });
      }
    }

    if (outcome.result === 'DoesntFit' && (input.storage?.onSdCard || input.storage?.hasRoomElsewhere)) {
      // R6: the Move action already exists.
      push(6, {
        rule: 'R6',
        text: input.storage?.onSdCard
          ? 'Your folder is on an SD card. Use Move to change where downloads are stored.'
          : 'Another storage location has more room. Use Move to change where downloads are stored.',
        action: { kind: 'move_storage' },
      });
    }

    if (outcome.result === 'Tight') {
      // R7: the add-sheet warning. Offer a smaller option that fits first.
      const smaller = views
        .filter((a) => fitsAlt(v, a) && a.size !== undefined && a.size < v.size! && admitAt(a.size).result === 'Fits')
        .sort((a, b) => b.size! - a.size!)[0];
      push(7, {
        rule: 'R7',
        text: `This leaves under 1 GB free (${f(outcome.leftAfter)} left). Your phone may slow down.`,
        action: smaller ? { kind: 'choose_candidate', candidateId: smaller.id } : undefined,
      });
    }
  }

  // R8: staging doubles the need and makes the fit worse. Once, on the first such candidate.
  if (space !== undefined && staging === 2) {
    for (const v of views) {
      if (v.size === undefined) continue;
      const plain = admitAt(v.size, 1);
      const doubled = admitAt(v.size, 2);
      if (RANK[doubled.result] > RANK[plain.result]) {
        push(8, {
          rule: 'R8',
          text: `Your folder needs double space while downloading because it copies files in when done. Using the default folder (Download/Maglev) halves that. ${v.title} needs ${f(doubled.need)} here and ${f(plain.need)} in the default folder.`,
          action: { kind: 'change_folder', to: 'default' },
        });
        break;
      }
    }
  }

  // R9: unfinished downloads already reserve space. Once.
  if (space !== undefined && space.pendingNeed > 0 && views.some((v) => v.size !== undefined && admitAt(v.size).result !== 'Fits')) {
    const n = input.unfinishedCount;
    const who = n === undefined
      ? 'Your other downloads still need'
      : n === 1 ? 'Your other download still needs' : `Your other ${n} downloads still need`;
    push(9, { rule: 'R9', text: `${who} ${f(space.pendingNeed)}.` });
  }

  // R10: many seasons wanted. Start with the episodes that fit now.
  if (space !== undefined && input.wantedSeasons !== undefined && input.wantedSeasons >= MANY_SEASONS) {
    const pack = views.find((v) => v.episodes !== undefined && v.perEpisode !== undefined);
    // A whole pack that already fits needs no partial suggestion.
    if (pack && pack.episodes !== undefined && pack.perEpisode !== undefined && pack.size !== undefined
      && admitAt(pack.size).result !== 'Fits') {
      const k = largestFittingCount(pack, pack.episodes - 1, space, staging);
      if (k >= 1) {
        push(10, {
          rule: 'R10',
          text: `You asked for ${input.wantedSeasons} seasons. Start with the first ${k} ${plural(k, 'episode', 'episodes')}, which ${plural(k, 'fits', 'fit')} now (${f(k * pack.perEpisode)}).`,
          action: {
            kind: 'select_episodes',
            candidateId: pack.id,
            count: k,
            sequential: input.wantsWatchWhileDownloading === true,
          },
        });
      }
    }
  }

  // R11: on a phone the 4K copy is not worth its size. Looks at the best candidate only.
  const best = views[0];
  if (input.profile === 'phone' && best !== undefined && best.res === 2160 && best.size !== undefined) {
    const alt = views.find((a) => fitsAlt(best, a) && a.res === 1080 && a.size !== undefined);
    if (alt && alt.size !== undefined) {
      push(11, {
        rule: 'R11',
        text: `On a phone screen 1080p looks much like 4K, and it is far smaller: ${alt.title} 1080p is ${f(alt.size)}, against ${f(best.size)} for 4K.`,
        action: { kind: 'choose_candidate', candidateId: alt.id },
      });
    }
  }

  // R12: lossless-only audio on a phone adds bytes the phone cannot use.
  if (input.profile === 'phone') {
    for (const v of views) {
      if (!v.lossless) continue;
      const alt = views.find((a) => a.id !== v.id && a.key === v.key && !a.lossless && fitsAlt(v, a));
      push(12, {
        rule: 'R12',
        text: alt && alt.size !== undefined
          ? `The only audio on this copy is lossless. A phone can't use that extra audio, and it adds gigabytes. A copy with AAC or Dolby Digital Plus is ${f(alt.size)}.`
          : "The only audio on this copy is lossless. A phone can't use that extra audio, and it adds gigabytes. Look for a copy with AAC or Dolby Digital Plus.",
        action: alt ? { kind: 'choose_candidate', candidateId: alt.id } : undefined,
      });
    }
  }

  return found
    .map((x, i) => ({ ...x, i }))
    .sort((a, b) => a.n - b.n || a.i - b.i)
    .map((x) => x.advice);
}
