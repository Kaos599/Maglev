/** One "## Heading" from a release-notes file and its bullet points, as plain text. */
export type NotesSection = { title: string; items: string[] };

/** Strip inline markdown (bold, code, links, images) from one line. */
function inline(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Splits release-notes markdown into titled sections with one item per bullet.
 * A line that is neither a heading nor a bullet continues the previous bullet (wrapped text).
 * Bullets before the first heading go into a section with an empty title.
 */
export function parseReleaseNotes(markdown: string): NotesSection[] {
  const sections: NotesSection[] = [];
  let current: NotesSection | null = null;
  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      current = { title: inline(heading[1]), items: [] };
      sections.push(current);
      continue;
    }
    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    if (!current) {
      current = { title: '', items: [] };
      sections.push(current);
    }
    if (bullet || current.items.length === 0) {
      current.items.push(inline(bullet ? bullet[1] : line));
    } else {
      const last = current.items.length - 1;
      current.items[last] = inline(`${current.items[last]} ${line}`);
    }
  }
  return sections.filter((s) => s.items.length > 0);
}
