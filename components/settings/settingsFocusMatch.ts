/** Pure matching for settings search focus: which registered row or section should a search result scroll to. */

const clean = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ');

export const rowKey = (title: string) => `row:${clean(title)}`;
export const sectionKey = (title: string) => `section:${clean(title)}`;

/** Row title first, then its section header, otherwise null (no scroll). */
export function pickAnchor(target: { title: string; section?: string }, keys: readonly string[]): string | null {
  const row = rowKey(target.title);
  if (keys.includes(row)) return row;
  if (target.section) {
    const section = sectionKey(target.section);
    if (keys.includes(section)) return section;
  }
  return null;
}
