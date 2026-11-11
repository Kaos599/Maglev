// Magnet link for a torrent. Pure: no React.

/** Torrent info-hash is the engine id. `dn=` is the name and every current tracker goes in as `tr=` (NATIVE_CONTRACT 21). */
export function buildMagnet(infoHash: string, name: string, trackers: readonly string[] = []): string {
  let out = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name)}`;
  const seen = new Set<string>();
  for (const url of trackers) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out += `&tr=${encodeURIComponent(url)}`;
  }
  return out;
}
