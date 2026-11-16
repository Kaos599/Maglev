#!/usr/bin/env node
// Contract for the site's smart Download (site/assets/download.js) and the generated site/index.html.
// Plain node, no dependencies. Exits 1 on any failure.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let failed = 0;
const check = (name, cond) => {
  if (cond) console.log(`ok   ${name}`);
  else { failed++; console.log(`FAIL ${name}`); }
};

const dl = require(path.join(ROOT, 'site/assets/download.js'));
const releases = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/site/releases.json'), 'utf8'));

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';
const WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';

// ---- pickLatest
const apk = (tag, kinds = ['universal']) => kinds.map((k) => ({ name: `Maglev-${tag}-${k}.apk`, size: 1, browser_download_url: `https://x/${tag}/${k}.apk` }));
const rel = (tag, over = {}) => ({ tag_name: tag, draft: false, prerelease: false, published_at: '2026-01-01T00:00:00Z', assets: apk(tag), ...over });

const latest = dl.pickLatest(releases);
check('pickLatest: fixture gives the newest release', latest && latest.tag_name === 'v0.25');
check('pickLatest: skips a draft', dl.pickLatest([rel('v9', { draft: true }), rel('v8')]).tag_name === 'v8');
check('pickLatest: skips a prerelease', dl.pickLatest([rel('v9', { prerelease: true }), rel('v8')]).tag_name === 'v8');
check('pickLatest: skips a release without APKs', dl.pickLatest([rel('v9', { assets: [{ name: 'Maglev-v9.apks', size: 1, browser_download_url: 'https://x' }] }), rel('v8')]).tag_name === 'v8');
check('pickLatest: skips a release with no assets at all', dl.pickLatest([rel('v9', { assets: [] }), rel('v8')]).tag_name === 'v8');
check('pickLatest: newest by published_at, whatever the order', dl.pickLatest([rel('v1', { published_at: '2026-01-01T00:00:00Z' }), rel('v2', { published_at: '2026-03-01T00:00:00Z' }), rel('v3', { published_at: '2026-02-01T00:00:00Z' })]).tag_name === 'v2');
check('pickLatest: null when nothing fits', dl.pickLatest([rel('v9', { draft: true })]) === null);
check('pickLatest: null for junk', dl.pickLatest(null) === null && dl.pickLatest({}) === null && dl.pickLatest([]) === null);

// ---- pickAsset
const kindOf = (env) => dl.pickAsset(latest, env);
const r1 = kindOf({ userAgent: ANDROID, platform: 'Linux aarch64' });
check('pickAsset: Android with aarch64 platform -> arm64', r1.kind === 'arm64' && r1.asset.name === 'Maglev-v0.25-arm64-v8a.apk');
const r1b = kindOf({ userAgent: ANDROID.replace('Linux;', 'Linux; arm64;'), platform: 'Linux armv8l' });
check('pickAsset: armv8l platform wins over an arm64 word in the UA -> universal', r1b.kind === 'universal');
const r2 = kindOf({ userAgent: ANDROID, platform: 'Linux', architecture: 'arm', bitness: '64' });
check('pickAsset: UA-CH arm + 64 -> arm64', r2.kind === 'arm64');
check('pickAsset: UA-CH arm + 32 -> universal', kindOf({ userAgent: ANDROID, platform: 'Linux', architecture: 'arm', bitness: '32' }).kind === 'universal');
const r3 = kindOf({ userAgent: ANDROID, platform: 'Linux' });
check('pickAsset: Android with no signal -> universal', r3.kind === 'universal' && r3.asset.name === 'Maglev-v0.25-universal.apk');
check('pickAsset: Android armv7l -> universal', kindOf({ userAgent: ANDROID, platform: 'Linux armv7l' }).kind === 'universal');
check('pickAsset: Android armv8l -> universal', kindOf({ userAgent: ANDROID, platform: 'Linux armv8l' }).kind === 'universal');
const r4 = kindOf({ userAgent: ANDROID, platform: 'Linux x86_64' });
check('pickAsset: Android x86_64 -> x86_64', r4.kind === 'x86_64' && r4.asset.name === 'Maglev-v0.25-x86_64.apk');
check('pickAsset: UA-CH x86 + 64 on Android -> x86_64', kindOf({ userAgent: ANDROID, platform: 'Linux', architecture: 'x86', bitness: '64' }).kind === 'x86_64');
check('pickAsset: Android via UA-CH platform only', kindOf({ userAgent: '', uaPlatform: 'Android', platform: 'Linux aarch64' }).kind === 'arm64');
const rm = kindOf({ userAgent: MAC, platform: 'MacIntel' });
check('pickAsset: Mac -> desktop with the universal file', rm.kind === 'desktop' && rm.asset.name === 'Maglev-v0.25-universal.apk');
const rw = kindOf({ userAgent: WIN, platform: 'Win32' });
check('pickAsset: Windows -> desktop with the universal file', rw.kind === 'desktop' && rw.asset.name === 'Maglev-v0.25-universal.apk');
check('pickAsset: iPhone -> desktop mode', kindOf({ userAgent: IPHONE, platform: 'iPhone' }).kind === 'desktop');
check('pickAsset: an arm64 Mac is still desktop', kindOf({ userAgent: MAC, platform: 'MacIntel', architecture: 'arm', bitness: '64' }).kind === 'desktop');
check('pickAsset: an aarch64 Linux desktop is still desktop', kindOf({ userAgent: 'Mozilla/5.0 (X11; Linux aarch64)', platform: 'Linux aarch64' }).kind === 'desktop');
check('pickAsset: empty env -> desktop', kindOf({}).kind === 'desktop' && kindOf(undefined).kind === 'desktop');
const noArm = { ...latest, assets: latest.assets.filter((a) => !/arm64/.test(a.name)) };
const rf = dl.pickAsset(noArm, { userAgent: ANDROID, platform: 'Linux aarch64' });
check('pickAsset: missing arm64 file falls back to universal', rf.kind === 'universal' && rf.asset.name === 'Maglev-v0.25-universal.apk');
check('pickAsset: never offers the .apks bundle', latest.assets.some((a) => /\.apks$/.test(a.name)) && ![r1, r2, r3, r4, rm, rw, rf].some((r) => /\.apks$/.test(r.asset.name)));
const onlyArm = { ...latest, assets: latest.assets.filter((a) => /arm64/.test(a.name)) };
check('pickAsset: no universal file -> still an APK, never the bundle', /\.apk$/.test(dl.pickAsset(onlyArm, { userAgent: MAC }).asset.name));
check('pickAsset: null release -> null', dl.pickAsset(null, {}) === null);

// ---- formatSize and label
check('formatSize: 23715651 -> 24 MB', dl.formatSize(23715651) === '24 MB');
check('formatSize: 54858588 -> 55 MB', dl.formatSize(54858588) === '55 MB');
check('formatSize: 3.5 MB keeps a decimal', dl.formatSize(3.5e6) === '3.5 MB');
check('formatSize: 500 KB', dl.formatSize(500000) === '500 KB');
check('formatSize: junk -> empty', dl.formatSize(undefined) === '' && dl.formatSize(-1) === '' && dl.formatSize(NaN) === '');
check('versionOf strips the v', dl.versionOf('v0.25') === '0.25' && dl.versionOf('v0.19-beta') === '0.19-beta');
check('buttonLabel: Download 0.25 \u00b7 24 MB', dl.buttonLabel(latest, r1.asset) === 'Download 0.25 \u00b7 24 MB');
check('recentReleases: at most 5, newest first, only usable', (() => { const l = dl.recentReleases(releases, 5); return l.length === 5 && l[0].tag_name === 'v0.25'; })());
check('fileLabel: plain English', /most phones/i.test(dl.fileLabel('arm64')) && /any device/i.test(dl.fileLabel('universal')));

// ---- generated page
const html = fs.readFileSync(path.join(ROOT, 'site/index.html'), 'utf8');
const anchors = [...html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/g)].map((m) => m[0]);
const faqStart = html.indexOf('id="faq"');
const outsideFaq = (a) => html.indexOf(a) < faqStart || html.indexOf(a) > html.indexOf('</section>', faqStart);
const latestLinks = anchors.filter((a) => /href="[^"]*\/releases\/latest"/.test(a) && outsideFaq(a));
check('index.html: no link to releases/latest outside the FAQ prose', latestLinks.length === 0);
const dlButtons = anchors.filter((a) => /data-dl=/.test(a));
check('index.html: at least 4 smart Download buttons', dlButtons.length >= 4);
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8')).expo.version;
const baked = `https://github.com/Kaos599/Maglev/releases/download/v${version}/Maglev-v${version}-universal.apk`;
check('index.html: every smart button bakes the universal APK of the app.json version', dlButtons.length > 0 && dlButtons.every((a) => a.includes(`href="${baked}"`)));
check('index.html: no button text says arm64 any more', !dlButtons.some((a) => /arm64/.test(a)));
check('index.html: "All releases on GitHub" link exists', /<a[^>]*href="https:\/\/github\.com\/Kaos599\/Maglev\/releases"[^>]*>[^<]*All releases on GitHub/.test(html));
check('index.html: static fallback lists the baked version\'s four APKs', ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'universal'].every((k) => html.includes(`/download/v${version}/Maglev-v${version}-${k}.apk"`)));
check('index.html: includes download.js with defer', /<script src="\/maglev\/assets\/download\.js" defer><\/script>/.test(html));
check('index.html: QR block points at the committed svg', html.includes('assets/qr-maglev.svg') && fs.existsSync(path.join(ROOT, 'site/assets/qr-maglev.svg')));
check('index.html: JSON-LD downloadUrl unchanged', html.includes('"downloadUrl":"https://github.com/Kaos599/Maglev/releases/latest"') || html.includes('"downloadUrl": "https://github.com/Kaos599/Maglev/releases/latest"'));
check('index.html: QR line is the agreed copy', html.includes('Maglev is an Android app. Scan this with your phone to get it.'));

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall checks passed');
