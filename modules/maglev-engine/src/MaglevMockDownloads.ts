import type {
  DownloadError,
  DownloadOptions,
  DownloadSnapshot,
  EngineErrorCode,
  EngineResult,
  UrlProbe,
} from './MaglevEngine.types.ts';
import { displayUrl, nameFromUrl, parseDownloadUrl, sanitizeFileName } from './downloadLink.ts';

/**
 * Dev and web simulation of URL downloads (NATIVE_CONTRACT 17, SM-30). Same validation and the same error
 * codes as the Rust engine; only the bytes are invented. Never used in a release build (see MaglevNativeBridge).
 *
 * Words in a link steer the simulation, so every SM-30 row can be reached by hand:
 * `404` HTTP_STATUS, `auth` AUTH_REQUIRED, `.html` NOT_A_FILE, `offline` NETWORK, `expire` link expires half way
 * (needs_link), `changed` FILE_CHANGED half way, `noresume` a server without resume.
 */

const MAX_ACTIVE = 3;
const SPEED = 2_000_000;
const MIN = 1_000_000;
const SPAN = 400_000_000;

export interface MockDownloadHooks {
  /** A governance tag (`wifi_only`, `battery`, ...) while transfers are blocked, else null. */
  blockedReason: () => string | null;
  folder: () => string;
  changed: () => void;
}

interface Item extends DownloadSnapshot {
  url: string;
  limit: number;
  /** Ticks left in `resolving` before the probe answers. */
  resolveTicks: number;
  probeFail: { code: EngineErrorCode; message: string; httpStatus?: number } | null;
  sawExpire: boolean;
  sawChanged: boolean;
  needsRestart: boolean;
}

function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Size of the file behind a link. The query is ignored, so a refreshed link to the same file has the same size. */
export function mockSizeFor(url: string): number {
  return MIN + (hash(url.split(/[?#]/)[0]) % SPAN);
}

function probeFailure(url: string): Item['probeFail'] {
  const u = url.toLowerCase();
  if (u.includes('offline')) return { code: 'NETWORK', message: "Couldn't reach that link. Check your connection and the address." };
  if (u.includes('auth')) return { code: 'AUTH_REQUIRED', message: 'This site wants you to sign in.', httpStatus: 403 };
  if (u.includes('404')) return { code: 'HTTP_STATUS', message: "The file isn't there (404).", httpStatus: 404 };
  if (/\.html?(?:[?#]|$)/.test(u)) return { code: 'NOT_A_FILE', message: 'This link opens a web page, not a file.' };
  return null;
}

function errorFor(code: DownloadError['code'], httpStatus?: number): DownloadError {
  switch (code) {
    case 'HTTP_STATUS':
      return { code, httpStatus: httpStatus ?? null, message: `The server returned an error (${httpStatus ?? '?'}).` };
    case 'FILE_CHANGED':
      return { code, message: 'The file changed on the server.' };
    case 'NOT_A_FILE':
      return { code, message: 'This link opens a web page, not a file.' };
    case 'CHECKSUM_MISMATCH':
      return { code, message: "File doesn't match the checksum." };
    case 'PERMISSION':
      return { code, message: "Maglev can't write to that folder." };
    case 'AUTH_REQUIRED':
      return { code, message: 'This site wants you to sign in.', httpStatus: httpStatus ?? null };
    case 'LINK_EXPIRED':
      return { code, message: 'Link expired', httpStatus: httpStatus ?? null };
    default:
      return { code: 'NETWORK', message: "Couldn't reach the server. Check your connection, then retry." };
  }
}

const fail = (code: EngineErrorCode, message: string, extra: { id?: string; httpStatus?: number } = {}): EngineResult<any> => ({
  ok: false,
  code,
  message,
  ...extra,
});

export class MockDownloads {
  private items = new Map<string, Item>();
  private seq = 0;
  private hooks: MockDownloadHooks;

  constructor(hooks: MockDownloadHooks) {
    this.hooks = hooks;
  }

  snapshots(): DownloadSnapshot[] {
    return [...this.items.values()]
      .sort((a, b) => a.addedAt - b.addedAt || (a.id < b.id ? -1 : 1))
      .map((i) => ({
        id: i.id,
        urlDisplay: i.urlDisplay,
        name: i.name,
        state: i.state,
        pausedBy: i.state === 'paused' ? i.pausedBy : null,
        size: i.size,
        downloaded: i.downloaded,
        downBps: i.state === 'downloading' ? i.downBps : 0,
        eta: i.state === 'downloading' && i.size != null && i.downBps > 0 ? Math.ceil((i.size - i.downloaded) / i.downBps) : -1,
        segmentsActive: i.state === 'downloading' ? 1 : 0,
        resumable: i.resumable,
        folder: i.folder,
        addedAt: i.addedAt,
        error: i.error,
        notice: i.notice ?? null,
      }));
  }

  private checkOptions(options: DownloadOptions | undefined): EngineResult<any> | null {
    const o = options ?? {};
    if (o.segments !== undefined && (!Number.isInteger(o.segments) || o.segments < 1 || o.segments > 8)) {
      return fail('INVALID_ARGUMENT', 'Use 1 to 8 connections');
    }
    if (o.expectedHash) return fail('UNSUPPORTED', "Checking a checksum isn't available yet");
    if (o.stream) return fail('STREAM_UNSUPPORTED', "Maglev can't save this kind of stream yet.");
    return null;
  }

  async probeUrl(url: string, options: DownloadOptions): Promise<EngineResult<UrlProbe>> {
    const bad = this.checkOptions(options);
    if (bad) return bad;
    const check = parseDownloadUrl(url);
    if (!check.ok) return fail('INVALID_SOURCE', 'That isn\'t a web link. Use a link that starts with http or https.');
    const f = probeFailure(check.url);
    if (f) return fail(f.code, f.message, f.httpStatus !== undefined ? { httpStatus: f.httpStatus } : {});
    return {
      ok: true,
      name: options?.name ? sanitizeFileName(options.name) : nameFromUrl(check.url),
      size: mockSizeFor(check.url),
      resumable: !check.url.toLowerCase().includes('noresume'),
      urlDisplay: check.display,
    };
  }

  async add(url: string, options: DownloadOptions): Promise<EngineResult<{ id: string }>> {
    const bad = this.checkOptions(options);
    if (bad) return bad;
    const check = parseDownloadUrl(url);
    if (!check.ok) return fail('INVALID_SOURCE', 'That isn\'t a web link. Use a link that starts with http or https.');
    const folder = options?.folder || this.hooks.folder();
    for (const i of this.items.values()) {
      if (i.url === check.url && i.folder === folder && i.state !== 'finished') {
        return fail('DUPLICATE', 'This link is already in your downloads', { id: i.id });
      }
    }
    const id = `dl_${(++this.seq).toString(16).padStart(12, '0')}`;
    const item: Item = {
      id,
      url: check.url,
      urlDisplay: check.display,
      name: options?.name ? sanitizeFileName(options.name) : nameFromUrl(check.url),
      state: 'resolving',
      pausedBy: null,
      size: null,
      downloaded: 0,
      downBps: 0,
      eta: -1,
      segmentsActive: 0,
      resumable: false,
      folder,
      addedAt: Math.floor(Date.now() / 1000) + this.seq,
      error: null,
      notice: null,
      limit: options?.downLimitBps ?? 0,
      resolveTicks: 1,
      probeFail: probeFailure(check.url),
      sawExpire: false,
      sawChanged: false,
      needsRestart: false,
    };
    if (options?.paused) item.pausedBy = 'user';
    this.items.set(id, item);
    this.hooks.changed();
    return { ok: true, id };
  }

  pause(id: string): EngineResult {
    const i = this.items.get(id);
    if (!i) return fail('NOT_FOUND', "That download isn't in your list");
    if (i.state === 'downloading' || i.state === 'queued') {
      i.state = 'paused';
      i.pausedBy = 'user';
      i.downBps = 0;
      this.hooks.changed();
    }
    return { ok: true };
  }

  resume(id: string): EngineResult {
    const i = this.items.get(id);
    if (!i) return fail('NOT_FOUND', "That download isn't in your list");
    if (i.state === 'paused') {
      i.state = 'queued';
      i.pausedBy = null;
      this.hooks.changed();
    }
    return { ok: true };
  }

  retry(id: string): EngineResult {
    const i = this.items.get(id);
    if (!i) return fail('NOT_FOUND', "That download isn't in your list");
    if (i.state !== 'error') return fail('INVALID_STATE', 'Only a failed download can be retried');
    if (i.error?.code === 'FILE_CHANGED' || i.error?.code === 'CHECKSUM_MISMATCH' || i.needsRestart) {
      i.downloaded = 0;
      i.size = null;
      i.needsRestart = false;
      i.sawChanged = true; // the restarted file is the new one
    }
    i.state = 'resolving';
    i.resolveTicks = 1;
    i.error = null;
    i.probeFail = probeFailure(i.url);
    this.hooks.changed();
    return { ok: true };
  }

  remove(id: string, _deleteFiles: boolean): EngineResult {
    if (!this.items.delete(id)) return fail('NOT_FOUND', "That download isn't in your list");
    this.hooks.changed();
    return { ok: true };
  }

  async refreshUrl(id: string, url: string, options: DownloadOptions): Promise<EngineResult> {
    const bad = this.checkOptions(options);
    if (bad) return bad;
    const check = parseDownloadUrl(url);
    if (!check.ok) return fail('INVALID_SOURCE', 'That isn\'t a web link. Use a link that starts with http or https.');
    const i = this.items.get(id);
    if (!i) return fail('NOT_FOUND', "That download isn't in your list");
    if (i.state !== 'needs_link') return fail('INVALID_STATE', "This download doesn't need a new link");
    const f = probeFailure(check.url);
    if (f) return fail(f.code, f.message, f.httpStatus !== undefined ? { httpStatus: f.httpStatus } : {});
    if (i.size != null && mockSizeFor(check.url) !== i.size) {
      i.state = 'error';
      i.error = errorFor('FILE_CHANGED');
      this.hooks.changed();
      return fail('FILE_CHANGED', 'That link points to a different file');
    }
    i.url = check.url;
    i.urlDisplay = displayUrl(check.url);
    i.sawExpire = true; // do not expire again
    i.state = 'queued';
    i.error = null;
    this.hooks.changed();
    return { ok: true };
  }

  setLimits(id: string, limits: { downLimitBps: number }): EngineResult {
    const i = this.items.get(id);
    if (!i) return fail('NOT_FOUND', "That download isn't in your list");
    i.limit = Math.max(0, Math.floor(limits?.downLimitBps ?? 0));
    return { ok: true };
  }

  /** Advances the simulation by `seconds`. Returns the downloads that finished in this step. */
  step(seconds: number): DownloadSnapshot[] {
    const done: DownloadSnapshot[] = [];
    const blocked = this.hooks.blockedReason();
    let active = [...this.items.values()].filter((i) => i.state === 'downloading').length;
    let changed = false;
    for (const i of [...this.items.values()].sort((a, b) => a.addedAt - b.addedAt)) {
      switch (i.state) {
        case 'resolving': {
          if (--i.resolveTicks > 0) break;
          changed = true;
          if (i.probeFail) {
            const f = i.probeFail;
            if (f.code === 'AUTH_REQUIRED') {
              i.state = 'needs_link';
              i.error = errorFor('AUTH_REQUIRED', f.httpStatus);
            } else {
              i.state = 'error';
              i.error = errorFor(f.code as DownloadError['code'], f.httpStatus);
            }
            break;
          }
          i.size = i.size ?? mockSizeFor(i.url);
          i.resumable = !i.url.toLowerCase().includes('noresume');
          if (i.pausedBy === 'user') {
            i.state = 'paused';
          } else if (blocked || active >= MAX_ACTIVE) {
            i.state = 'queued';
          } else {
            i.state = 'downloading';
            active++;
          }
          break;
        }
        case 'queued': {
          if (!blocked && active < MAX_ACTIVE) {
            i.state = 'downloading';
            active++;
            changed = true;
          }
          break;
        }
        case 'paused': {
          // A governance pause clears by itself; a user pause waits for Resume (the user's pause wins).
          if (i.pausedBy && i.pausedBy !== 'user' && i.pausedBy !== 'storage_full' && i.pausedBy !== blocked) {
            i.state = 'queued';
            i.pausedBy = null;
            changed = true;
          }
          break;
        }
        case 'downloading': {
          if (blocked) {
            i.state = 'paused';
            i.pausedBy = blocked;
            i.downBps = 0;
            active--;
            changed = true;
            break;
          }
          const speed = i.limit > 0 ? Math.min(i.limit, SPEED) : SPEED;
          i.downBps = speed;
          i.downloaded = Math.min(i.size ?? 0, i.downloaded + Math.floor(speed * seconds));
          const frac = i.size ? i.downloaded / i.size : 0;
          if (!i.sawExpire && i.url.toLowerCase().includes('expire') && frac >= 0.5) {
            i.sawExpire = true;
            i.state = 'needs_link';
            i.error = errorFor('LINK_EXPIRED', 410);
            i.downBps = 0;
            active--;
          } else if (!i.sawChanged && i.url.toLowerCase().includes('changed') && frac >= 0.3) {
            i.sawChanged = true;
            i.state = 'error';
            i.error = errorFor('FILE_CHANGED');
            i.downBps = 0;
            active--;
          } else if (i.size != null && i.downloaded >= i.size) {
            i.state = 'verifying';
            i.downBps = 0;
            active--;
          }
          changed = true;
          break;
        }
        case 'verifying': {
          i.state = 'finished';
          changed = true;
          done.push(this.snapshots().find((s) => s.id === i.id)!);
          break;
        }
        default:
          break;
      }
    }
    if (changed) this.hooks.changed();
    return done;
  }

  /** Used by tests and by the engine's shutdown. */
  clear(): void {
    this.items.clear();
  }
}
