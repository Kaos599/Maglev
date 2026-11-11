# Search Contract: providers, categories, aggregation (v1, 2026-11-11)

This contract is shared by the **search engine** (`utils/search/**`) and the **search UI** (`app/(tabs)/search.tsx`, `app/settings/search-providers.tsx`, `components/search/**`, `components/search-providers/**`).
The design is the Maglev Search Providers canvas (Results, Searching, Idle, Providers, Provider sheet). Provider facts come from live probes on 2026-11-11 (see LEDGER).

## 1. Categories

```ts
export type Category = 'all' | 'movies' | 'tv' | 'anime' | 'music' | 'apps' | 'games' | 'books' | 'other' | 'adult';
```
UI labels: All · Movies · TV · Anime · Music · Apps · Games · Books · Other · Adult.

- A query in category `c` goes **only** to enabled providers whose effective categories include `c`. `all` goes to every enabled provider, with `adult` filtered out unless adult content is on.
- **Effective categories** = the provider's `categories` ∩ the user's per-provider "Use for" selection. The default selection is all of the provider's categories.
- **Chips shown on Search:** `All` plus every category that at least one enabled provider effectively supports, in the order above. `Adult` appears only when Show adult sources is on.
- The selected chip persists in `utils/prefs/search.ts` (last used).
- Each provider maps `Category` to its own upstream codes in one table inside the provider file.

## 2. Provider interface

```ts
export interface SearchResult {
  providerId: string;
  name: string;
  infoHash: string;          // lowercase 40-hex; the dedupe key
  magnet: string;            // built from infoHash + name + default trackers when the source gives none
  sizeBytes?: number;
  seeders?: number;          // undefined = source has no counts (e.g. Internet Archive)
  leechers?: number;
  publishedAt?: number;      // epoch ms
  category?: Category;
  detailUrl?: string;
}

export interface SearchProvider {
  id: string;                // stable forever
  name: string;
  abbr: string;              // 2-char monogram for the UI tile
  homepage: string;
  mirrors: string[];         // tried in order; mirrors[0] is the default; user can override
  categories: Category[];    // includes 'adult' only for adult sources
  nsfw: boolean;             // true if it returns adult content
  unsafeReason?: string;     // plain-English warning shown as a badge + explanation
  enabledByDefault: boolean;
  method: 'json' | 'rss' | 'html' | 'torznab';
  canPage: boolean;
  search(q: string, category: Category, page: number, ctx: { baseUrl: string; signal: AbortSignal; hideAdult: boolean; limit: number }): Promise<SearchResult[]>;
}
```

## 3. Built-in providers (v1)

| id | Name | Default | Method | Categories | Notes |
|---|---|---|---|---|---|
| `knaben` | Knaben | **on** | json (POST `api.knaben.org/v1`) | all except adult (adult when hideAdult=false) | Meta-search of 20+ indexes. Send `hide_xxx: !adultOn`. |
| `torrentscsv` | Torrents-CSV | **on** | json (`torrents-csv.com/service/search`) | other (no categories: only queried for `all`/`other`) | Cursor pagination with `after`. |
| `archive` | Internet Archive | **on** | json (`archive.org/advancedsearch.php`) | movies, music, books, apps, other | Legal source. Skip items without `btih`. No seeders. |
| `nyaa` | Nyaa | **on** | rss (`nyaa.si/?page=rss`) | anime, music, books, apps, games, other | Mirror `nyaa.iss.ink`. |
| `yts` | YTS | **on** | json (`movies-api.accel.li/api/v2/list_movies.json`) | movies | One row per quality torrent: "Title (Year) 1080p". |
| `tpb` | The Pirate Bay | off | json (`apibay.org/q.php`) | all except anime | `unsafeReason`: "Many fake or malware uploads. Check comments before downloading." Ignore the sentinel row `id:"0"`. Category 500 = adult. |
| `bitsearch` | BitSearch | off | html (`bitsearch.eu/search`) | all except adult | Fragile scrape; parse magnets from the list. |
| `linuxtracker` | LinuxTracker | off | html | apps | Legal distros. |
| `sukebei` | Sukebei | off | rss (`sukebei.nyaa.si/?page=rss`) | adult | `nsfw: true`; listed only when adult is on. |
| `torznab:<uuid>` | user-added Jackett/Prowlarr | user | torznab XML (`/api?t=search&q=&apikey=&cat=`) | from caps or a mapping (movies 2000, tv 5000, music 3000, apps 4000, books 7000, anime 5070, other 8000, adult 6000) | API key in `expo-secure-store`. |

**Skipped (documented):** 1337x, Torlock and rargb are behind a Cloudflare challenge. TorrentGalaxy, SolidTorrents and TorrentDownloads are unreachable. LimeTorrents and TheRarBg have no magnet in the list page, and TheRarBg also has fakes. EZTV's API needs an IMDb id, so it is deferred.

## 4. Aggregation (`utils/search/aggregate.ts`)

- `searchAll(q, category, opts) → AsyncIterable<SearchUpdate>` or an `onUpdate` callback. Each update is `{ results: MergedResult[]; sources: SourceStatus[]; done: boolean }`.
- All eligible providers run in parallel. Each gets its own `AbortController`, a per-provider timeout (`waitSeconds`: 5, 8 or 15; default 8), and the user's cancel signal chained in.
- `SourceStatus = { providerId, state: 'searching' | 'done' | 'empty' | 'timeout' | 'error' | 'blocked', count, ms, message? }`. `blocked` means an HTTP 403/503 with an HTML body (a Cloudflare challenge).
- **Merge:** the key is `infoHash`. `MergedResult` = the best row (highest seeders) + `sources: providerId[]` (in priority order) + max seeders and leechers + the earliest `publishedAt`. Ties go to the source with higher priority (its position in the user's On list).
- **Sort options:** most seeders (default; `undefined` sorts last), newest, largest, name.
- **Filters:** `hideDead` drops `seeders === 0` (but keeps `undefined`). `limit` per provider is 25, 50 or 100 (default 50).
- **Health:** a provider with 3 consecutive failures is skipped for 5 minutes. `testProvider(id)` returns `{ ok, ms, count, message }` for the sheet's Test now button. Health persists in memory only.
- **Mirrors:** use the user override if set, else the mirrors in order. A network error or 5xx tries the next mirror once.
- **Requests:** a generic User-Agent `Maglev/<version> (Android)` and no cookies. Never send personal data.

## 5. Preferences (`utils/prefs/search.ts`, kv-store)

```ts
interface SearchPrefs {
  enabled: string[];                         // provider ids in priority order (On list order)
  useFor: Record<string, Category[]>;        // per-provider category restriction; missing = all
  mirrorOverride: Record<string, string>;
  adult: boolean;                            // default false
  waitSeconds: 5 | 8 | 15;                   // default 8
  limit: 25 | 50 | 100;                      // default 50
  hideDead: boolean;                         // default true
  sort: 'seeders' | 'newest' | 'size' | 'name';
  lastCategory: Category;
  recents: string[];                         // existing behaviour, max 8
  torznab: { id: string; name: string; url: string; categories: Category[] }[]; // apiKey in secure-store under `torznab:<id>`
}
```
Migration: if the stored prefs lack `enabled`, seed it with the `enabledByDefault` providers. Turning `adult` off also disables every `nsfw` provider (TorrentSearch's model).

## 6. Contract tests (`scripts/test-search.js`, Node, no network)

These run the providers' parsers against recorded fixtures in `scripts/fixtures/search/`:
1. Each provider parses its fixture into ≥ 1 result with a valid 40-hex `infoHash` and a `magnet:?xt=urn:btih:` link.
2. The TPB sentinel row is ignored.
3. Category routing: `movies` reaches YTS but not Nyaa. `adult` reaches nothing unless adult is on.
4. Merge: two providers returning the same hash produce one row with both sources and the max seeders.
5. Timeout: a provider that never resolves becomes `timeout` within `waitSeconds` and does not block the others.
6. `hideDead` keeps `undefined` seeders and drops 0.

The Reality contract `C-SEARCH-1` in `test-p3-reality-contracts.js` asserts that the files exist and that `scripts/test-search.js` passes.
