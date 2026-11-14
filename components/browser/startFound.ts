/**
 * One found file into Transfers: probeUrl first (so a page that is not a file is refused), then addDownload with
 * the page's cookie, referer and user agent. The single-download sheet and the batch both use this path.
 * The engine and the header builder are passed in so the function runs without React or native modules.
 */
import type { DownloadOptions, EngineResult, UrlProbe } from '../../modules/maglev-engine/src/MaglevEngine.types';

export interface StartDeps {
  headersFor: (t: { url: string; pageUrl: string; userAgent: string }) => Promise<NonNullable<DownloadOptions['headers']>>;
  probeUrl: (url: string, options?: DownloadOptions) => Promise<({ ok: true } & UrlProbe) | { ok: false; code: string; message: string; httpStatus?: number | null }>;
  startDownload: (url: string, options?: DownloadOptions) => Promise<EngineResult<{ id: string }>>;
}

export async function startFound(
  deps: StartDeps,
  t: { url: string; pageUrl: string; userAgent: string },
  extra: Pick<DownloadOptions, 'name' | 'folder'> = {},
): Promise<{ ok: true; id: string } | { ok: false; code?: string; message?: string }> {
  const headers = await deps.headersFor(t);
  const probe = await deps.probeUrl(t.url, { headers });
  if (!probe.ok) return { ok: false, code: probe.code, message: probe.message };
  const res = await deps.startDownload(t.url, { headers, ...extra });
  return res.ok ? { ok: true, id: res.id } : { ok: false, code: res.code, message: res.message };
}
