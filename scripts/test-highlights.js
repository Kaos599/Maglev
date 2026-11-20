#!/usr/bin/env node
// New-feature highlight (docs/NATIVE_CONTRACT.md section 37.4): the decision, the 0.30 entry and its route,
// the setting, the sheet and where it is mounted. Needs Node 22.18+ (runs the TypeScript source directly).
process.removeAllListeners('warning');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(root, p));
let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}

(async () => {
  console.log('Highlights');
  const H = await import('../utils/highlights.ts');
  const { HIGHLIGHTS } = await import('../constants/highlights.ts');
  const title = (x) => (x ? x.title : null);

  console.log('[decision]');
  check('first install never shows', H.highlightToShow('0.30', null, true, true) === null && H.highlightToShow('0.30', '0.20', true, true) === null);
  check('first install does not advance either (onboarding sets the version)', H.highlightPlan('0.30', null, true, true).advanceSilently === false);
  check('an upgrade across 0.30 shows Subtitles', title(H.highlightToShow('0.30', '0.27', false, true)) === 'Subtitles');
  check('an install that never stored a version counts as an upgrade', title(H.highlightToShow('0.30', null, false, true)) === 'Subtitles');
  check('the same version shows nothing', H.highlightToShow('0.30', '0.30', false, true) === null);
  check('a downgrade shows nothing and does not move the version', H.highlightToShow('0.27', '0.30', false, true) === null && H.highlightPlan('0.27', '0.30', false, true).advanceSilently === false);
  check('versions compare numerically, not as text (0.9 < 0.28)', H.compareVersions('0.28', '0.9') > 0 && H.compareVersions('0.9', '0.28') < 0 && H.compareVersions('1.0', '0.99') > 0 && H.compareVersions('0.28.0', '0.28') === 0);
  check('0.100 shows after 0.28 numerically', title(H.highlightToShow('0.100', '0.28', false, true, { '0.100': { title: 'Big', body: '', icon: 'check', tryRoute: '/', tryLabel: 'x' } })) === 'Big');

  const T = (t) => ({ title: t, body: 'b', icon: 'check', tryRoute: '/x', tryLabel: 'Go' });
  const table = { '0.26': T('Old'), '0.28': T('Mid'), '0.30': T('New'), '0.40': T('Future') };
  check('skipped versions show the newest entry up to the installed one', title(H.highlightToShow('0.31', '0.25', false, true, table)) === 'New');
  check('an entry above the installed version is not shown', title(H.highlightToShow('0.29', '0.25', false, true, table)) === 'Mid');
  check('an entry at or below the last seen version is not shown', H.highlightToShow('0.29', '0.28', false, true, table) === null);
  check('with no entry in the range nothing shows and the version moves forward silently', H.highlightToShow('0.27', '0.26', false, true, table) === null && H.highlightPlan('0.27', '0.26', false, true, table).advanceSilently === true);
  check('with the switch off nothing shows and the version moves forward', H.highlightToShow('0.30', '0.27', false, false) === null && H.highlightPlan('0.30', '0.27', false, false).advanceSilently === true);
  check('a plan that shows does not also advance (closing the sheet does)', H.highlightPlan('0.30', '0.27', false, true).advanceSilently === false && H.highlightPlan('0.30', '0.27', false, true).show.version === '0.30');

  console.log('[launch]');
  check('a launcher start is plain', H.isPlainLaunch(null) && H.isPlainLaunch('') && H.isPlainLaunch(undefined) && H.isPlainLaunch('maglev://') && H.isPlainLaunch('maglev:///'));
  check('a magnet, file, share, torrent link or deep link is not plain', ['magnet:?xt=urn:btih:abc', 'content://x/y.torrent', 'file:///sdcard/a.torrent', 'https://example.com/v', 'maglev://torrent/dl_ab12', 'maglev://browser?url=x'].every((u) => !H.isPlainLaunch(u)));

  console.log('[entry]');
  const e = HIGHLIGHTS['0.30'];
  check('0.30 entry is exactly the contract text', e && e.title === 'Subtitles' && e.body === "Find and save subtitles for videos you've downloaded, from 21 free sources. No account needed." && e.icon === 'subtitles' && e.tryRoute === '/settings/subtitles' && e.tryLabel === 'Set up subtitles');
  const gen = read('components/icons.generated.ts');
  check('the entry icon exists in the icon set', gen.includes(`"${e.icon}":`));
  const routeFile = `app${e.tryRoute}.tsx`;
  check('the entry route is a real screen, registered in the layout', exists(routeFile) && read('app/_layout.tsx').includes(`name="${e.tryRoute.slice(1)}"`));
  check('every entry key is major.minor', Object.keys(HIGHLIGHTS).every((k) => /^\d+\.\d+$/.test(k)));

  console.log('[setting]');
  const prefs = await import('../utils/prefs/update.ts');
  check('showHighlights defaults on; only false turns it off', prefs.defaultUpdatePrefs().showHighlights === true && prefs.normalizeUpdatePrefs({ showHighlights: false }).showHighlights === false && prefs.normalizeUpdatePrefs({ showHighlights: 0 }).showHighlights === true);
  check('UI only: toNativeConfig never reads it', !/showHighlights|highlights/i.test(read('modules/maglev-engine/src/toNativeConfig.ts')));
  const updates = read('app/settings/updates.tsx');
  check('Settings > Updates has "Show new features after updates"', /highlightCopy\.settingTitle/.test(updates) && /prefs\.showHighlights/.test(updates) && /settingTitle: 'Show new features after updates'/.test(read('constants/copy.ts')));
  const { SETTINGS_INDEX } = await import('../utils/settingsIndex.ts');
  check('the setting is in the search index under Updates', SETTINGS_INDEX.some((x) => x.title === 'Show new features after updates' && x.page === 'updates'));
  const kv = await import('../utils/prefs/highlights.ts');
  check('lastSeenVersion starts unset, then round-trips through kv', kv.getLastSeenVersion() === null && (kv.setLastSeenVersion('0.28'), kv.getLastSeenVersion() === '0.28'));

  console.log('[sheet]');
  const sheet = read('components/HighlightSheet.tsx');
  const copy = await import('../constants/copy.ts');
  check('sheet copy is the contract text', copy.highlightCopy.notNow === 'Not now' && copy.highlightCopy.allNotes === 'All release notes' && copy.highlightCopy.footer === 'You can turn these off in Settings → Updates');
  check('the sheet shows icon, title, body, the try button, Not now, All release notes and the footer', /highlight\.icon/.test(sheet) && /title=\{highlight\.title\}/.test(sheet) && /highlight\.body/.test(sheet) && /highlight\.tryLabel/.test(sheet) && /highlightCopy\.notNow/.test(sheet) && /highlightCopy\.allNotes/.test(sheet) && /highlightCopy\.footer/.test(sheet));
  check('it reuses the Dialog from components/ui (a centred modal, not a bottom sheet), closed with Not now', /Dialog\b[^;]*from '\.\/ui'/.test(sheet) && /<Dialog\b/.test(sheet) && !/\bSheet\b(?!\.|')/.test(sheet.replace(/HighlightSheet|highlight-sheet/g, '').replace(/\/\*[\s\S]*?\*\//g, '')) && /onClose=\{onNotNow\}/.test(sheet) && /testID="highlight-sheet"/.test(sheet));
  const dialog = read('components/ui/Dialog.tsx');
  check('Dialog closes on Back (onRequestClose) and on a backdrop tap', /onRequestClose=\{onClose\}/.test(dialog) && /<Pressable[^>]*onPress=\{onClose\}/.test(dialog));
  check('the primary button goes to tryRoute and All release notes to What\'s new', /router\.push\(route as never\)/.test(sheet) && /'\/settings\/whats-new'/.test(sheet) && exists('app/settings/whats-new.tsx'));
  check('every way of closing records the installed version', /const close = useCallback\(\(\) => \{\s*setLastSeenVersion\(INSTALLED\)/.test(sheet) && /tryIt[\s\S]*close\(\)/.test(sheet) && /notes = useCallback\(\(\) => \{\s*if \(!shown\?\.open\) return;\s*close\(\)/.test(sheet));
  check('it asks the plan once per launch, and only for an onboarded user on a plain launch', /decided \|\| plain !== true \|\| !onboarded/.test(sheet) && /highlightPlan\(INSTALLED, getLastSeenVersion\(\), false, prefs\.showHighlights\)/.test(sheet) && /advanceSilently\) setLastSeenVersion/.test(sheet));
  check('a launch link, at start or later, keeps it from showing', /Linking\.getInitialURL/.test(sheet) && /isPlainLaunch\(url\)/.test(sheet) && /addEventListener\('url', \(\) => setPlain\(false\)\)/.test(sheet));
  console.log('[entrance]');
  const B = await import('../components/highlight/burst.ts');
  const TM = await import('../components/highlight/timing.ts');
  const TL = await import('../components/highlight/timeline.ts');
  const HM = TM.HIGHLIGHT_MOTION;
  const near = (x, y, eps = 1e-6) => Math.abs(x - y) <= eps;

  console.log('[timeline: table]');
  check('the timeline numbers are the approved design', HM.scrimMs === 200 && HM.cardMs === 280 && HM.trainStart === 80 && HM.trainMs === 520 && HM.trainBrake === 0.55 && HM.trainOverU === 2 && HM.burstStart === 380 && HM.burstLife === 480 && HM.burstStagger === 15 && HM.burstCount === 14 && HM.badgeStart === 520 && HM.badgeMs === 340 && HM.badgeImpact === 0.45 && HM.flashMs === 120 && HM.dustMs === 220 && HM.sparkStart === 700 && HM.sparkGap === 30 && HM.sparkMs === 180 && HM.riseStart === 600 && HM.riseGap === 40 && HM.riseMs === 340);
  check('the badge lands (haptic, flash, dust) at 673 ms', Math.round(TM.IMPACT_MS) === 673);
  check('the last thing ends at 1140 ms, which is the clock length', TL.lastEnd() === 1140 && HM.totalMs === 1140);
  check('the train brakes at 366 ms and is parked by 600 ms', near(HM.trainStart + HM.trainMs * HM.trainBrake, 366.0, 0.01) && HM.trainStart + HM.trainMs === 600);

  console.log('[timeline: stepped easing and bezier]');
  check('steps(3, end) holds each third and reaches 1 only at the end', TL.stepsAt(0, 3, false) === 0 && TL.stepsAt(0.32, 3, false) === 0 && near(TL.stepsAt(0.34, 3, false), 1 / 3) && near(TL.stepsAt(0.7, 3, false), 2 / 3) && TL.stepsAt(1, 3, false) === 1);
  check('steps(1, start) jumps to the end value as soon as it starts', TL.stepsAt(0, 1, true) === 0 && TL.stepsAt(0.001, 1, true) === 1);
  check('a bezier starts at 0, ends at 1, and an ease-out is ahead of linear at half time', TL.bezierAt([0.22, 0.75, 0.3, 1], 0) === 0 && near(TL.bezierAt([0.22, 0.75, 0.3, 1], 1), 1, 1e-3) && TL.bezierAt([0.22, 0.75, 0.3, 1], 0.5) > 0.5);
  check('a keyframed value holds its first value before and its last after, and mid-keyframe curves change per stretch', TL.keyed(-1, [[0, 5, []], [1, 9, []]]) === 5 && TL.keyed(2, [[0, 5, []], [1, 9, []]]) === 9 && near(TL.keyed(0.25, [[0, 0, []], [0.5, 1, [4, 0]], [1, 0, []]]), 0.5) && TL.keyed(0.7, [[0, 0, []], [0.5, 1, [4, 0]], [1, 0, []]]) === 0.75);

  console.log('[timeline: rail light-up]');
  const starts = TL.railStarts();
  check('five rail pieces light, at 115, 131, 145, 164 and 214 ms, read off the approach curve', JSON.stringify(starts.filter((x) => x !== null)) === JSON.stringify([115, 131, 145, 164, 214]));
  check('the pieces beyond where the train parks never light', starts.length === TL.TRACK.length && starts[starts.length - 1] === null && starts[starts.length - 2] === null);
  check('every start is inside the approach (80 to 366 ms) and they rise in order along the track', starts.filter((x) => x !== null).every((x, i, all) => x >= 80 && x <= 366 && (i === 0 || x > all[i - 1])));
  check('a lit piece jumps to full, then steps back to 45% in three steps', TL.railLitAt(100, 115) === 0.45 && TL.railLitAt(116, 115) === 1 && TL.railLitAt(115 + 300 * 0.6, 115) < 1 && TL.railLitAt(115 + 300 * 0.6, 115) > 0.45 && TL.railLitAt(115 + 300, 115) === 0.45 && new Set([0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map((p) => TL.railLitAt(115 + 300 * p, 115))).size <= 3);

  console.log('[timeline: card, train, speed lines]');
  const c0 = TL.cardAt(0), cEnd = TL.cardAt(280), cMid = TL.cardAt(0.7 * 280);
  check('the card starts transparent at 92% and 2.5 cq low, overshoots 1% at 70%, and ends at rest', c0.opacity === 0 && near(c0.scale, 0.92) && near(c0.rise, 2.5) && near(cMid.scale, 1.01, 1e-3) && cEnd.opacity === 1 && cEnd.scale === 1 && cEnd.rise === 0);
  check('the scrim fades in over 200 ms', TL.scrimAt(0) === 0 && near(TL.scrimAt(200), 1, 1e-3) && TL.scrimAt(100) > 0.5);
  check('the train starts off the card and brakes two train pixels past the mark at 366 ms', TL.trainX(0) < -200 && near(TL.trainX(366), 2, 1e-3));
  check('it settles back to the mark by 600 ms and holds', near(TL.trainX(600), 0, 1e-6) && TL.trainX(1140) === 0);
  check('the train never goes backwards while it approaches', [80, 120, 160, 200, 240, 280, 320, 366].every((t, i, all) => i === 0 || TL.trainX(t) >= TL.trainX(all[i - 1])));
  check('the 1 px dip is held from 30% to 70% of the settle (436 to 530 ms) and is gone after', TL.trainDip(366) === 0 && TL.trainDip(440) === HM.dipU && TL.trainDip(520) === HM.dipU && TL.trainDip(540) === 0 && TL.trainDip(1140) === 0);
  const sp0 = TL.speedAt(80), sp1 = TL.speedAt(80 + 520 * 0.4), sp2 = TL.speedAt(80 + 520 * 0.55), spEnd = TL.speedAt(600);
  check('speed lines start stretched 1.8x, ease to 1.5x, retract to 1x, then are gone', near(sp0.stretch, 1.8) && sp0.opacity === 1 && near(sp1.stretch, 1.5) && near(sp2.stretch, 1) && spEnd.opacity === 0 && spEnd.stretch === 0);
  check('the speed lines retract in three steps', new Set([0.58, 0.62, 0.66, 0.7, 0.74, 0.78, 0.82].map((p) => TL.speedAt(80 + 520 * p).stretch.toFixed(4))).size === 3);

  console.log('[timeline: burst]');
  const a = B.burstLayout(HM.burstCount, HM.burstSizes, HM.burstWaves);
  check('the burst layout is the same on every run', JSON.stringify(a) === JSON.stringify(B.burstLayout(HM.burstCount, HM.burstSizes, HM.burstWaves)));
  check('14 pixels of 2, 3 or 4 train pixels, in 4 waves, both tints used, all thrown upward', a.length === 14 && a.every((v) => [2, 3, 4].includes(v.size) && v.y < 0 && Number.isInteger(v.x) && Number.isInteger(v.y)) && new Set(a.map((v) => v.wave)).size === 4 && new Set(a.map((v) => v.tint)).size === 2);
  check('targets: every pixel rises, drifts sideways, then falls past where it started', a.every((v) => { const tg = TL.burstTarget(v); return tg.x === v.x && tg.y === v.y + v.fall && v.fall >= 10; }));
  const w0 = a.find((v) => v.wave === 0), w3 = a.find((v) => v.wave === 3);
  check('waves start 15 ms apart: 380 ms and 425 ms', TL.burstAt(380, w0).opacity === 0 && TL.burstAt(381, w0).opacity === 1 && TL.burstAt(425, w3).opacity === 0 && TL.burstAt(426, w3).opacity === 1);
  check('the last pixel is gone at 905 ms and a pixel that has not started stays hidden', TL.burstAt(905, w3).opacity === 0 && TL.burstAt(300, w0).opacity === 0);
  const mid = TL.burstAt(380 + 480 * 0.38, w0), end = TL.burstAt(380 + 479, w0);
  check('a pixel peaks at 38% of its life, then falls (gravity), and keeps drifting out', near(mid.y, w0.y, 0.5) && end.y > mid.y && Math.abs(end.x) > Math.abs(mid.x) * 0.9 && near(TL.burstAt(380 + 480, w0).x, w0.x, 1e-6));
  check('the fade is three steps: 1, 2/3, 1/3, then gone', [0.6, 0.75, 0.9].map((p) => TL.blinkAt(p).toFixed(3)).join() === '1.000,0.667,0.333' && TL.blinkAt(1) === 0 && TL.blinkAt(0.3) === 1);
  check('the highest pixel flies past the card top edge (origin 38.25 u above the rail line, then up 20 u)', (TM.STATION_CQ.height - TM.STATION_CQ.railBottom) + (-38.25 + Math.min(...a.map((v) => v.y))) * TM.CQ_PER_U < 0);

  console.log('[timeline: badge, edge, dust, sparks]');
  const st0 = TL.stampAt(520), st18 = TL.stampAt(520 + 340 * 0.18), st45 = TL.stampAt(TM.IMPACT_MS), st56 = TL.stampAt(520 + 340 * 0.56), stEnd = TL.stampAt(860);
  check('the badge starts invisible, big and crooked (1.38x, -9deg)', st0.opacity === 0 && near(st0.sx, 1.38) && near(st0.tilt, -9));
  check('it winds up to 1.42x, -11deg, lifted 5.5 cq at 18%', near(st18.sx, 1.42) && near(st18.tilt, -11) && near(st18.rise, -5.5));
  check('it is on the card edge at 45% (673 ms): rise 0, scale 1, tilt -3', near(st45.rise, 0, 1e-4) && near(st45.sx, 1, 1e-4) && near(st45.tilt, -3, 1e-3));
  check('it squashes to 1.1 x 0.84 right after, then rebounds and settles at -4deg', near(st56.sx, 1.1) && near(st56.sy, 0.84) && near(stEnd.tilt, -4) && stEnd.sx === 1 && stEnd.sy === 1 && stEnd.rise === 0 && stEnd.opacity === 1);
  check('the flash is off before the impact, on for 1 beat, off in two steps while it widens, gone at 120 ms', TL.flashAt(672).opacity === 0 && TL.flashAt(674).opacity === 1 && near(TL.flashAt(674).stretch, 0.6) && TL.flashAt(673 + 120 * 0.6).opacity === 0.5 && near(TL.flashAt(673 + 120 * 0.6).stretch, 0.8) && TL.flashAt(673 + 120).opacity === 0 && TL.flashAt(673 + 120).stretch === 1);
  const d = TL.dustAt(TM.IMPACT_MS + 220, -7, -2);
  check('dust pixels (4, two each side) kick outward along the edge and are gone after 220 ms', HM.dust.length === 4 && near(d.x, -7, 1e-6) && near(d.y, -2, 1e-6) && d.opacity === 0 && TL.dustAt(TM.IMPACT_MS - 1, -7, -2).opacity === 0 && TL.dustAt(TM.IMPACT_MS + 10, -7, -2).opacity === 1 && HM.dust.slice(0, 2).every((q) => q[0] < 0 && q[1] < 0) && HM.dust.slice(2).every((q) => q[0] > 0 && q[1] > 0));
  check('sparks start at 700, 730 and 760 ms, popping in three steps to 1.25x and settling at 1x', TL.sparkAt(699, 0).opacity === 0 && TL.sparkAt(770, 1).opacity > 0 && TL.sparkAt(729, 1).opacity === 0 && TL.sparkAt(760 + 180, 2).scale === 1 && near(TL.sparkAt(700 + 108, 0).scale, 1.25, 1e-6) && TL.sparkAt(700 + 30, 0).scale < 0.7);
  check('the badge words come from the version key: NEW and 0.28', B.badgeParts('0.28').label === 'NEW' && B.badgeParts('0.28').version === '0.28' && /badgeParts\(version\)/.test(read('components/highlight/Station.tsx')));

  console.log('[timeline: the words]');
  const r = [0, 1, 2, 3, 4, 5].map((i) => HM.riseStart + HM.riseGap * i);
  check('the words start at 600, 640, 680, 720, 760 and 800 ms', JSON.stringify(r) === JSON.stringify([600, 640, 680, 720, 760, 800]));
  check('each rises 3 cq with an expo-out and is fully opaque by 40% of its rise', TL.riseAt(600, 0).opacity === 0 && near(TL.riseAt(600, 0).rise, 3) && near(TL.riseAt(600 + 340 * 0.4, 0).opacity, 1, 1e-6) && TL.riseAt(600 + 340, 0).rise === 0 && TL.riseAt(1140, 5).opacity === 1);
  check('the last item is done at 1140 ms', TL.riseAt(1140, 5).rise === 0);
  check('the card unit follows the card: 86 cq across, capped at the dialog width', near(TM.cardUnit(360, 360, 16), 328 / 86) && near(TM.cardUnit(800, 360, 16), 360 / 86));

  console.log('[entrance: wiring]');
  const ent = read('components/highlight/useEntrance.ts');
  const station = read('components/highlight/Station.tsx');
  check('reduce motion shows the last frame (clock at the end); the haptic fires once, from a callback scheduled at the impact', /m\.disabled/.test(ent) && /clock\.value = M\.totalMs/.test(ent) && /haptic\('done'\)/.test(ent) && /scheduleOnRN\(onImpact\)/.test(ent) && /withDelay\(\s*IMPACT_MS/.test(ent));
  check('under reduce motion nothing is scheduled after the jump (no haptic path)', /if \(m\.disabled\) \{\s*clock\.value = M\.totalMs;\s*return;\s*\}/.test(ent));
  check('the entrance never blocks input and never loops', /pointerEvents="none"/.test(station) && !/withRepeat/.test(ent + station));
  check('the train is drawn from the brand paths (MARK_BODY evenodd, MARK_LINES), the badge from stacked Views, no clip path', /MARK_BODY/.test(station) && /fillRule="evenodd"/.test(station) && /MARK_LINES/.test(station) && !/clipPath|clip-path/.test(station) && /type\.brand/.test(station));
  check('no hex colours, no system monospace in the new files', ['Station.tsx', 'timing.ts', 'timeline.ts', 'burst.ts', 'useEntrance.ts'].every((f) => !/#[0-9a-fA-F]{3,8}\b/.test(read('components/highlight/' + f)) && !/fontFamily:\s*'monospace'/.test(read('components/highlight/' + f))));
  check('the card and scrim run on the same clock as the train, through the Dialog intro', /intro=\{intro\}/.test(sheet) && /card: cardAt, scrim: scrimAt/.test(sheet));
  check('closing plays an exit (motion.duration.exit) and the dialog is dropped only once it has gone', /EXIT_MS = motion\.duration\.exit/.test(sheet) && /exitMs=\{EXIT_MS\}/.test(sheet) && /onExited=\{onExited\}/.test(sheet) && /const gone = useCallback\(\(\) => setShown\(null\)/.test(sheet) && /visible=\{open\}/.test(sheet));
  check('a second tap during the exit does nothing', /if \(!shown\?\.open\) return/.test(sheet));
  check('HighlightPreview is exported for review', /export function HighlightPreview/.test(sheet));

  const layout = read('app/_layout.tsx');
  check('mounted at the app root next to the star prompt, inside the signed-in guard only', /\{main \? <HighlightSheet \/> : null\}/.test(layout) && layout.indexOf('<HighlightSheet') > layout.indexOf('</Stack>'));
  const onb = read('app/onboarding.tsx');
  check('onboarding sets lastSeenVersion on both ways of finishing', (onb.match(/markHighlightsSeen\(\);/g) || []).length === 2 && /setLastSeenVersion\(v\)/.test(onb));
  check('not shown during onboarding: the sheet is not mounted until the user is onboarded', !/<HighlightSheet/.test(onb));

  console.log(failed ? `\n${failed} failed` : '\nhighlights: all passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
