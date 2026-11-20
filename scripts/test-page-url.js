#!/usr/bin/env node
// Source checks for `pageUrl` (NATIVE_CONTRACT "Auto-refresh (2026-11-20)") and the redirect handling next to it.
// The behaviour is proven by Rust unit tests (CI runs `cargo test`); this keeps the types, the Kotlin passthrough and
// the Rust wiring honest, and runs the mock engine's rule for the saved page URL.
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
let failed = 0;
function check(name, cond) {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.error(`  FAIL ${name}`); }
}

const types = read('modules/maglev-engine/src/MaglevEngine.types.ts');
const opts = types.slice(types.indexOf('export interface DownloadOptions'), types.indexOf('export interface UrlProbe'));
const snap = types.slice(types.indexOf('export interface DownloadSnapshot'), types.indexOf('/** NATIVE_CONTRACT 24.8. */'));
check('DownloadOptions has pageUrl?: string', /pageUrl\?: string;/.test(opts));
check('DownloadSnapshot has pageUrl', /pageUrl\?: string \| null;/.test(snap));

const host = read('modules/maglev-engine/android/src/main/java/com/maglev/engine/EngineHost.kt');
const json = read('modules/maglev-engine/android/src/main/java/com/maglev/engine/util/Json.kt');
const add = host.slice(host.indexOf('fun addDownload('), host.indexOf('fun pauseDownload('));
const refresh = host.slice(host.indexOf('fun refreshDownloadUrl('), host.indexOf('fun allowLanHost('));
check('kotlin: addDownload snakeifies every option (pageUrl reaches Rust as page_url)', /Json\.snakeify\(options\)/.test(add));
check('kotlin: refreshDownloadUrl snakeifies every option', /Json\.snakeify\(options\)/.test(refresh));
check('kotlin: snapshot keys are camelized centrally (page_url comes back as pageUrl)', /fun camelize\(/.test(json) && /snakeToCamel/.test(json));
check('kotlin: no per-field option whitelist for downloads', !/options\["pageUrl"\]|options\.get\("pageUrl"\)/.test(host));
check('snake/camel converter maps pageUrl <-> page_url', (() => {
  const toSnake = (s) => s.replace(/([a-z0-9])([A-Z])/g, (_, a, b) => `${a}_${b.toLowerCase()}`);
  const toCamel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
  return toSnake('pageUrl') === 'page_url' && toCamel('page_url') === 'pageUrl';
})());

const rs = read('native/maglev-core/src/http_dl/driver.rs');
const run = read('native/maglev-core/src/http_dl/driver/stream_run.rs');
check('rust: DownloadOptions.page_url', /pub page_url: Option<String>,\n\s*\/\/\/ Save an HLS/.test(rs));
check('rust: DlRecord.page_url is #[serde(default)]', /#\[serde\(default\)\]\n\s*pub page_url: Option<String>,/.test(rs));
check('rust: persisted() applies the secret-query rule to the page URL', /r\.page_url = r\.page_url\.as_deref\(\)\.and_then\(persisted_page_url\)/.test(rs) && /has_secret_query\(url\) \|\| login/.test(rs));
check('rust: snapshots return page_url', /"page_url": r\.page_url,/.test(rs));
check('rust: add stores the page URL', /page_url: clean_page_url\(opts\.page_url\.as_deref\(\)\)/.test(rs));
check('rust: refresh updates it for files and streams', /rec\.page_url = Some\(p\)/.test(rs) && /rec\.page_url = Some\(p\)/.test(run));
check('rust: page URL tests exist', ['a_clean_page_url_is_saved_as_it_is', 'a_secret_looking_page_query_is_cut_off_before_saving', 'the_download_json_carries_the_page_url'].every((n) => rs.includes(`fn ${n}`)));

// Redirects: the client never follows, every request goes through send_following.
const red = read('native/maglev-core/src/http_dl/redirect.rs');
const seg = read('native/maglev-core/src/http_dl/driver/segments.rs');
const fetchRs = read('native/maglev-core/src/http_dl/stream/fetch.rs');
check('rust: the client policy stops instead of following', /attempt\.stop\(\)/.test(rs) && !/attempt\.follow\(\)/.test(rs));
check('rust: local-network refusal still in the policy', /redirect_allowed\(attempt\.url\(\)\.host_str\(\)/.test(rs));
check('rust: probe, single GET, part GET and stream requests use send_following', /send_following\(client, b, &hdrs\.picker\(url\)\)/.test(rs) && /send_following\(&client, builder, &picker\)/.test(rs) && /send_following\(client, builder, &picker\)/.test(seg) && /send_following\(&self\.client, self\.request\(url, range\), &picker\)/.test(fetchRs));
check('rust: no bare .send() left on a download request', !/\.send\(\)\.await/.test(rs.replace(/#\[cfg\(test\)\][\s\S]*$/, '')) && !/\.send\(\)\.await/.test(seg.replace(/#\[cfg\(test\)\][\s\S]*$/, '')));
check('rust: at most 10 hops, https to http refused, cookie dropped per hop', /MAX_HOPS: usize = 10/.test(red) && /Downgrade/.test(red) && /h\.remove\(COOKIE\)/.test(red) && /pick_cookie\(/.test(red));
check('rust: redirect tests exist', ['each_hop_carries_the_cookie_of_its_own_host_and_never_the_old_one', 'the_eleventh_redirect_is_an_error', 'a_redirect_onto_the_local_network_is_still_refused_from_a_public_link', 'methods_follow_the_status', 'a_relative_location_is_resolved_against_the_answering_url'].every((n) => red.includes(`fn ${n}`)) && seg.includes('fn a_redirect_to_another_host_carries_that_hosts_cookie_and_not_the_first'));

// The mock engine keeps pageUrl, with the same rule for a secret-looking query.
const mock = read('modules/maglev-engine/src/MaglevMockDownloads.ts');
check('mock: add keeps pageUrl and refresh can update it', /pageUrl: cleanPageUrl\(options\?\.pageUrl\)/.test(mock) && /i\.pageUrl = cleanPageUrl\(options\.pageUrl\)/.test(mock) && /pageUrl: i\.pageUrl \?\? null/.test(mock));
const fn = mock.slice(mock.indexOf('export function cleanPageUrl'), mock.indexOf('function hash('));
const js = fn.replace('export function cleanPageUrl(raw: string | undefined | null): string | null {', 'function cleanPageUrl(raw) {');
check('mock: cleanPageUrl header matches the test extraction', js.startsWith('function cleanPageUrl(raw) {'));
const clean = new Function(`${js}; return cleanPageUrl;`)();
check('mock: clean page URL is kept as it is', clean('https://site.test/w?v=1') === 'https://site.test/w?v=1');
check('mock: a secret-looking query is cut off', clean('https://site.test/w?v=1&token=abc') === 'https://site.test/w');
check('mock: empty is dropped', clean('') === null && clean('  ') === null && clean(undefined) === null);

if (failed) { console.error(`${failed} failed`); process.exit(1); }
console.log('page url: all ok');
