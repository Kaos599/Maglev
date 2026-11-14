/**
 * "Save to" for one download. `DownloadOptions.folder` is a POSIX path the engine writes into (it creates the
 * folder), so the browser offers the default folder or a subfolder of the default root. A folder picked with the
 * system picker is a SAF tree and cannot be passed per download; that picker changes the engine's target for every
 * later download, so the browser's sheets no longer use it. Pure: no React, no native modules.
 */

/** A safe folder name: no separators, no `..`, no hidden folder, no reserved characters, at most 64 characters. */
export function subfolderName(input: string): string {
  let n = (input ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\/:*?"<>|]/g, '');
  while (n.includes('..')) n = n.replace(/\.\./g, '');
  n = n.replace(/\s+/g, ' ').trim().replace(/^\.+/, '').trim();
  n = n.slice(0, 64).replace(/[. ]+$/, '');
  return n;
}

/** `<root>/<name>`, or null when the name is empty after cleaning. */
export function saveFolder(root: string, name: string): string | null {
  const clean = subfolderName(name);
  if (!clean) return null;
  return `${root.replace(/\/+$/, '')}/${clean}`;
}
