#!/usr/bin/env node
// NATIVE_CONTRACT 36.6: subtitle hash, save and unzip. Proves the hash vector on the JS side, that the Kotlin test
// holds the same constant, that the Kotlin source exposes the calls and error codes, and that the mock implements them.
// Needs Node 22.18+ (runs the TypeScript source directly).
process.removeAllListeners('warning');
const fs = require('fs');
const path = require('path');

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const KT = 'modules/maglev-engine/android/src';

// The OpenSubtitles hash, as BigInt: size + LE uint64 sums of the first and last 64 KiB, mod 2^64.
function movieHash(buf) {
  const M = (1n << 64n) - 1n;
  const sum = (o) => {
    let s = 0n;
    for (let i = 0; i < 65536; i += 8) s += buf.readBigUInt64LE(o + i);
    return s;
  };
  return ((BigInt(buf.length) + sum(0) + sum(buf.length - 65536)) & M).toString(16).padStart(16, '0');
}

// Same vector as SubtitleHashTest.kt: 200000 bytes, byte[i] = (i * 31 + 7) & 0xFF.
const VECTOR_HASH = '5f9fe02060a3cd40';

// A stored (uncompressed) zip, the format the mock reads.
function storedZip(files) {
  const parts = [];
  for (const [name, data] of files) {
    const n = Buffer.from(name);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt32LE(data.length, 18);
    h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(n.length, 26);
    parts.push(h, n, data);
  }
  return Buffer.concat(parts).toString('base64');
}

async function main() {
  // 1. Hash vector.
  const buf = Buffer.alloc(200000);
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 31 + 7) & 255;
  check('JS BigInt hash of the vector', movieHash(buf) === VECTOR_HASH, movieHash(buf));
  const ktHashTest = read(`${KT}/test/java/com/maglev/engine/subtitles/SubtitleHashTest.kt`);
  check('Kotlin test asserts the same constant', ktHashTest.includes(`"${VECTOR_HASH}"`));
  check('Kotlin test uses the same pattern', ktHashTest.includes('200000') && ktHashTest.includes('i * 31 + 7'));

  // 2. Kotlin source exposes the calls and codes.
  const mod = read(`${KT}/main/java/com/maglev/engine/MaglevEngineModule.kt`);
  for (const fn of ['subtitleHash', 'saveSubtitle', 'unzipSubtitles']) check(`module exposes ${fn}`, mod.includes(`AsyncFunction("${fn}")`));
  check('saveSubtitle takes the replace flag', /AsyncFunction\("saveSubtitle"\) \{[^}]*replace: Boolean/.test(mod));
  const kt = ['SubtitleHash', 'SubtitleFiles', 'SubtitleZip'].map((f) => read(`${KT}/main/java/com/maglev/engine/subtitles/${f}.kt`)).join('\n');
  for (const code of ['FILE_TOO_SMALL', 'NOT_FOUND', 'IO', 'NAME_TAKEN', 'VERIFY_FAILED', 'CANT_WRITE', 'NO_SPACE', 'ARCHIVE_UNSAFE']) {
    check(`Kotlin raises ${code}`, kt.includes(`"${code}"`) || (code === 'IO' && mod.includes('"IO"')));
  }
  check('module rejects with the code', mod.includes('promise.reject(e.code'));
  check('Kotlin has zip and hash unit tests', fs.existsSync(path.join(__dirname, '..', `${KT}/test/java/com/maglev/engine/subtitles/SubtitleZipTest.kt`)));

  // 3. Types and bridge.
  const types = read('modules/maglev-engine/src/MaglevEngine.types.ts');
  const bridge = read('modules/maglev-engine/src/MaglevNativeBridge.ts');
  for (const fn of ['subtitleHash', 'saveSubtitle', 'unzipSubtitles']) {
    check(`API types declare ${fn}`, new RegExp(`\\b${fn}\\(`).test(types));
    check(`bridge implements ${fn}`, new RegExp(`public ${fn}\\(`).test(bridge));
  }

  // 4. Mock.
  const { MaglevMockEngine } = await import('../modules/maglev-engine/src/MaglevMockEngine.ts');
  const mock = new MaglevMockEngine();
  const code = async (p) => {
    try {
      await p;
      return null;
    } catch (e) {
      return e && e.code;
    }
  };
  const h1 = await mock.subtitleHash('/storage/emulated/0/Download/Maglev/A/a.mkv');
  const h2 = await mock.subtitleHash('/storage/emulated/0/Download/Maglev/A/a.mkv');
  const h3 = await mock.subtitleHash('/storage/emulated/0/Download/Maglev/A/b.mkv');
  check('mock hash is 16 lowercase hex', /^[0-9a-f]{16}$/.test(h1.hash), h1.hash);
  check('mock hash is deterministic', h1.hash === h2.hash && h1.bytes === h2.bytes);
  check('mock hash differs by name', h1.hash !== h3.hash);
  check('mock bytes at least 131072', h1.bytes >= 131072);
  check('mock hash of nothing is NOT_FOUND', (await code(mock.subtitleHash(''))) === 'NOT_FOUND');

  const v = '/storage/emulated/0/Download/Maglev/A/a.mkv';
  const r1 = await mock.saveSubtitle(v, 'a.en.srt', 'QQ==', false);
  check('mock save returns a sibling path', r1.path === '/storage/emulated/0/Download/Maglev/A/a.en.srt', r1.path);
  check('mock save NAME_TAKEN without replace', (await code(mock.saveSubtitle(v, 'a.en.srt', 'QQ==', false))) === 'NAME_TAKEN');
  check('mock save replaces when asked', (await mock.saveSubtitle(v, 'a.en.srt', 'Qg==', true)).path === r1.path);
  for (const bad of ['', '../x.srt', 'a/b.srt', 'x'.repeat(256)]) {
    check(`mock save rejects name "${bad.slice(0, 8)}"`, (await code(mock.saveSubtitle(v, bad, 'QQ==', true))) === 'CANT_WRITE');
  }

  const sub = Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nHi\n');
  const zipped = await mock.unzipSubtitles(storedZip([['dir/Show.S01E01.SRT', sub], ['readme.txt', Buffer.from('x')], ['b.vtt', sub]]));
  check('mock unzip keeps subtitle members by base name', zipped.map((z) => z.name).join() === 'Show.S01E01.SRT,b.vtt', zipped.map((z) => z.name).join());
  check('mock unzip keeps the bytes', Buffer.from(zipped[0].base64, 'base64').equals(sub));
  check('mock unzip rejects too many entries', (await code(mock.unzipSubtitles(storedZip(Array.from({ length: 201 }, (_, i) => [`f${i}.txt`, Buffer.from('x')]))))) === 'ARCHIVE_UNSAFE');

  if (failed) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('subtitles native: all checks passed');
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
