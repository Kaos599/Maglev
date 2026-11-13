/**
 * What the clipboard chip and the Paste link button accept: a magnet link or any http(s) link.
 * A link to a .torrent file goes to the torrent flow and any other web link to the link-download
 * flow; the add screen decides which (utils/addSource). Pure: no React.
 */
export function isAddableLink(text: string): boolean {
  const t = text.trim();
  if (/^magnet:\?xt=/i.test(t)) return true;
  // One link, no spaces, with a host.
  return /^https?:\/\/[^\s/?#]+\S*$/i.test(t);
}
