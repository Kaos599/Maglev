// Splits assistant text into plain and glossary-term segments (docs/ASSISTANT_DESIGN.md section 9, "Jargon chips").
// Pure TypeScript: no React, no engine, no network (contract C-ASSIST-8). The app scans, so the model cannot invent a chip.
//
// Matching rules:
// - Terms are the label and the aka names of every glossary entry shown as a chip.
// - Longest match first, so "WEB-DL" wins over "WEB" and "HDR10+" over "HDR10".
// - A term never matches inside another word: the characters on both sides must not be letters or digits.
// - Short letter-only terms (CAM, TS, TC, WEB, HD, DV, MULTi ...) collide with everyday words, so they only
//   match with the exact casing the glossary uses. Longer terms match in any casing.

import { GLOSSARY, type TokenKey } from './glossary.ts';

export interface JargonSegment {
  text: string;
  /** Set on glossary-term segments only. */
  key?: TokenKey;
}

interface Term {
  /** Lower-cased term, used for case-insensitive comparison. */
  lower: string;
  /** The term as written in the glossary, used for exact-case comparison. */
  exact: string;
  key: TokenKey;
  exactOnly: boolean;
}

let cached: Term[] | null = null;

const isAlnum = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z0-9]/.test(ch);

function terms(): Term[] {
  if (cached) return cached;
  const seen = new Set<string>();
  const out: Term[] = [];
  for (const key of Object.keys(GLOSSARY) as TokenKey[]) {
    const entry = GLOSSARY[key];
    if (!entry.chip) continue;
    for (const name of [entry.label, ...(entry.aka ?? [])]) {
      const lower = name.toLowerCase();
      if (seen.has(lower)) continue; // first key wins ("SD" belongs to 480p)
      seen.add(lower);
      const lettersOnly = /^[A-Za-z]+$/.test(name);
      out.push({ lower, exact: name, key, exactOnly: lettersOnly && (name.length <= 4 || lower === 'multi') });
    }
  }
  out.sort((a, b) => b.lower.length - a.lower.length);
  cached = out;
  return out;
}

/** Split `text` into plain and glossary-term segments. Concatenating the segments gives back `text`. */
export function scanJargon(text: string): JargonSegment[] {
  const list = terms();
  const lowerText = text.toLowerCase();
  const out: JargonSegment[] = [];
  let plainStart = 0;
  let i = 0;
  while (i < text.length) {
    let hit: Term | undefined;
    if (!isAlnum(text[i - 1])) {
      for (const t of list) {
        if (lowerText.startsWith(t.lower, i)) {
          const end = i + t.lower.length;
          const lastIsWord = isAlnum(t.exact[t.exact.length - 1]);
          if (lastIsWord && isAlnum(text[end])) continue;
          if (t.exactOnly && text.slice(i, end) !== t.exact) continue;
          hit = t;
          break;
        }
      }
    }
    if (hit) {
      if (i > plainStart) out.push({ text: text.slice(plainStart, i) });
      const end = i + hit.lower.length;
      out.push({ text: text.slice(i, end), key: hit.key });
      i = end;
      plainStart = end;
    } else {
      i++;
    }
  }
  if (plainStart < text.length) out.push({ text: text.slice(plainStart) });
  return out;
}
