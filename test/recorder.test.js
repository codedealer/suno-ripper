// test/recorder.test.js — exercise the userscript's stream-recorder logic in
// node with minimal browser stubs. Run: node test/recorder.test.js
//
// Covers: fresh-stream detection (incl. ftyp box spanning two appends),
// playbar attribution, rotation with byte handover (clean + mid-chunk
// boundary), pre-buffer foreign cut, same-clip restart, mid-file detection,
// assembly, MP4 + fragment-time verification, history LRU eviction.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- synthetic fMP4 ----------
const te = new TextEncoder();
function u32be(n) {
  const b = new Uint8Array(4);
  b[0] = (n >>> 24) & 255; b[1] = (n >>> 16) & 255; b[2] = (n >>> 8) & 255; b[3] = n & 255;
  return b;
}
function box(type, ...parts) {
  const body = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { body.set(p, o); o += p.length; }
  const out = new Uint8Array(8 + body.length);
  out.set(u32be(8 + body.length), 0);
  out.set(te.encode(type), 4);
  out.set(body, 8);
  return out;
}
const ftyp = () => box('ftyp', te.encode('M4M '), u32be(0), te.encode('isom'));
const moov = () => box('moov', box('mvhd', new Uint8Array(108)));
const moof = (i, t) =>
  box('moof',
    box('mfhd', u32be(0), u32be(i)),
    box('traf', box('tfhd', u32be(1)), box('tfdt', u32be(0), u32be(t)), box('trun', u32be(0))),
  );
const mdat = (i, salt) => box('mdat', new Uint8Array(20_000).fill((i * 7 + 3 + salt) & 255));
function file(frags, salt) {
  const parts = [ftyp(), moov()];
  for (const [i, t] of frags) { parts.push(moof(i, t)); parts.push(mdat(i, salt)); }
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const stdFrags = (n = 30) => Array.from({ length: n }, (_, i) => [i, i * 48000]);
const FILE_A = file(stdFrags(), 11); // ~602 KB each (> MIN_BYTES)
const FILE_B = file(stdFrags(), 22);
const FILE_C = file(stdFrags(), 33);
const FILE_D = file(stdFrags(), 44);
const FILE_E = file(stdFrags(), 55);
const FILE_F = file(stdFrags(), 66);
function concatU8(...parts) {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------- browser stubs ----------
const CLIP = (ch) =>
  `${ch.repeat(8)}-${ch.repeat(4)}-${ch.repeat(4)}-${ch.repeat(4)}-${ch.repeat(12)}`;
const C_A = CLIP('a'), C_B = CLIP('b'), C_C = CLIP('c'), C_D = CLIP('d'), C_E = CLIP('e'), C_F = CLIP('f');

const state = { clip: null };
const playbarEl = {
  parentElement: {
    querySelector: () => ({
      getAttribute: (a) => (a === 'href' ? (state.clip ? `/song/${state.clip}` : '') : null),
    }),
  },
};
const audioEl = {
  currentSrc: '', paused: true, ended: false, muted: false,
  playbackRate: 1, defaultPlaybackRate: 1, duration: 240, currentTime: 0,
  play() { this.paused = false; return Promise.resolve(); },
  pause() { this.paused = true; },
  addEventListener() {}, removeEventListener() {},
};
const gmStore = {};
const documentStub = {
  readyState: 'complete',
  body: { appendChild() {} },
  createElement: () => ({ style: {}, setAttribute() {}, addEventListener() {}, click() {}, remove() {} }),
  querySelector: (sel) => {
    if (sel === '[aria-label^="Playbar:"]') return playbarEl;
    if (sel === '[aria-label="Playbar: Play button"]') return { click() {} };
    return null;
  },
  querySelectorAll: (sel) => (sel === 'audio' ? [audioEl] : []),
  addEventListener() {},
};
const sandbox = {
  console,
  document: documentStub,
  location: { href: 'https://suno.com/create', pathname: '/create' },
  GM_getValue: (k, d) => (k in gmStore ? gmStore[k] : d),
  GM_setValue: (k, v) => { gmStore[k] = v; },
  MutationObserver: class { observe() {} disconnect() {} },
  setTimeout, setInterval, clearTimeout,
  URL: { createObjectURL: () => 'blob:stub', revokeObjectURL() {} },
};
sandbox.SourceBuffer = function SourceBuffer() {};
sandbox.SourceBuffer.prototype.appendBuffer = function () {};
const ctx = vm.createContext(sandbox);
sandbox.window = sandbox;

vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'suno-clip-archiver.user.js'), 'utf8'), ctx);
const sr = sandbox.__sunoripper;
assert.ok(sr, 'test hook not found — script failed to load');

// realm-safe copies (the hook checks `instanceof Uint8Array` in its own realm)
const Sarr = vm.runInContext('Uint8Array', ctx);
const c8 = (u8) => new Sarr(u8);

function setAudio(src) {
  audioEl.currentSrc = src;
  audioEl.ended = false;
  audioEl.paused = true;
  audioEl.currentTime = 0;
}
function feed(fileU8, chunkSize = 7000) {
  for (let off = 0; off < fileU8.length; off += chunkSize) {
    sr.appendChunk(c8(fileU8.subarray(off, off + chunkSize)));
  }
}

(async function main() {
  // ---- A: fresh stream; ftyp box spans the first two appends ----------
  state.clip = C_A;
  setAudio('blob:A');
  new sandbox.SourceBuffer().appendBuffer(c8(FILE_A.subarray(0, 5))); // via the hook
  assert.strictEqual(sr.rec().total, 5, 'hooked appendBuffer not recorded');
  assert.strictEqual(sr.rec().firstFtyp, false, 'ftyp not complete yet');
  feed(FILE_A.subarray(5));
  assert.strictEqual(sr.rec().firstFtyp, true, 'first ftyp (spanning appends) not detected');
  assert.strictEqual(sr.rec().total, FILE_A.length);
  assert.strictEqual(sr.getRec(C_A).clipId, C_A, 'playbar attribution');

  // A plays to the end, then the player auto-advances to B
  audioEl.ended = true;
  sr.recPoll();
  assert.strictEqual(sr.rec().complete, true, 'A not marked complete on end');
  feed(FILE_B.subarray(0, 300)); // B's stream starts while playbar still shows A
  assert.ok(sr.rec().pending, 'B ftyp boundary not detected on A rec');
  state.clip = C_B;
  setAudio('blob:B');
  sr.recPoll(); // rotation with handover
  assert.strictEqual(sr.rec().clipId, C_B, 'rotation to B');
  assert.strictEqual(sr.getRec(C_A).complete, true, 'A kept in history (complete)');

  const recA = sr.getRec(C_A);
  const bytesA = sr.assembleRec(recA);
  assert.ok(bytesA && sameBytes(bytesA, FILE_A), 'A assembly != file A');
  assert.strictEqual(sr.verifyMp4(bytesA), null);
  assert.strictEqual(sr.verifyContinuity(bytesA), null);

  // ---- B: the user's scenario — partially buffered, playhead > 0 ------
  // (B has 300 bytes recorded; it is "paused a few seconds in".)
  assert.strictEqual(sr.rec().clipId, C_B);
  assert.strictEqual(sr.rec().firstFtyp, true);
  assert.strictEqual(sr.rec().complete, false);
  // capture: resume + fast-forward -> the rest of the file is appended
  feed(FILE_B.subarray(300));
  audioEl.ended = true;
  sr.recPoll();
  const recB = sr.getRec(C_B);
  assert.strictEqual(recB.complete, true);
  const bytesB = sr.assembleRec(recB);
  assert.ok(bytesB && sameBytes(bytesB, FILE_B), 'B assembly (prefix + captured tail) != file B');
  assert.strictEqual(sr.verifyMp4(bytesB), null);
  assert.strictEqual(sr.verifyContinuity(bytesB), null);

  // ---- C + D: boundary mid-chunk (one append holds C tail + D ftyp) ---
  state.clip = C_C;
  setAudio('blob:C');
  sr.recPoll(); // B->C rotation: B retires (complete), C's rec created
  assert.strictEqual(sr.rec().clipId, C_C, 'rotation to C');
  feed(FILE_C.subarray(0, FILE_C.length - 200));
  audioEl.ended = true;
  sr.recPoll();
  assert.strictEqual(sr.rec().complete, true, 'C complete');
  sr.appendChunk(c8(concatU8(FILE_C.subarray(FILE_C.length - 200), FILE_D.subarray(0, 800))));
  assert.ok(sr.rec().pending, 'mid-chunk D ftyp boundary not detected');
  assert.strictEqual(sr.rec().pending.offset, FILE_C.length);
  state.clip = C_D;
  setAudio('blob:D');
  sr.recPoll(); // rotation; split happens inside a chunk
  assert.strictEqual(sr.getRec(C_C).total, FILE_C.length, 'C cut at boundary');
  assert.ok(sameBytes(sr.assembleRec(sr.getRec(C_C)), FILE_C), 'C assembly != file C');
  assert.strictEqual(sr.rec().clipId, C_D);
  assert.strictEqual(sr.rec().total, 800, 'D handover bytes');
  feed(FILE_D.subarray(800));
  audioEl.ended = true;
  sr.recPoll();
  const bytesD = sr.assembleRec(sr.getRec(C_D));
  assert.ok(bytesD && sameBytes(bytesD, FILE_D), 'D assembly (handover + tail) != file D');
  assert.strictEqual(sr.verifyMp4(bytesD), null);
  assert.strictEqual(sr.verifyContinuity(bytesD), null);

  // ---- E: same-clip restart (stream recreated, new src) ---------------
  state.clip = C_E;
  setAudio('blob:E');
  feed(FILE_E.subarray(0, 1000));
  setAudio('blob:E2'); // app dropped the MediaSource and recreated it
  feed(FILE_E); // full file from byte 0 again
  assert.ok(sr.rec().pending, 'restart ftyp not detected');
  await sleep(2200); // grace: playbar unchanged, track not ended -> restart
  sr.recPoll();
  assert.strictEqual(sr.rec().files.length, 2, 'restart boundary not confirmed');
  audioEl.ended = true;
  sr.recPoll();
  const bytesE = sr.assembleRec(sr.getRec(C_E));
  assert.ok(bytesE && sameBytes(bytesE, FILE_E), 'E assembly (last file) != file E');
  assert.strictEqual(sr.verifyMp4(bytesE), null);
  assert.strictEqual(sr.verifyContinuity(bytesE), null);

  // history LRU: A, B, C, D retired -> A evicted (max 3)
  assert.strictEqual(sr.history().has(C_A), false, 'LRU eviction');
  assert.strictEqual(sr.history().has(C_B), true);
  assert.strictEqual(sr.history().has(C_C), true);
  assert.strictEqual(sr.history().has(C_D), true);
  // D was retired by the E rotation with its full file intact
  assert.ok(sameBytes(sr.assembleRec(sr.getRec(C_D)), FILE_D), 'D retired intact');

  // ---- F: mid-file resume (no ftyp prefix recorded) -------------------
  state.clip = C_F;
  setAudio('blob:F');
  sr.recPoll(); // E->F rotation: E retires (complete)
  feed(FILE_F.subarray(20_000, 40_000));
  const recF = sr.getRec(C_F);
  assert.ok(recF && recF.total > 0 && recF.firstFtyp === false, 'F should be mid-file');
  const stF = await sr.waitForRecFtyp(C_F, 2000);
  assert.strictEqual(stF.status, 'midfile');
  const stNone = await sr.waitForRecFtyp(CLIP('9'), 300);
  assert.strictEqual(stNone.status, 'nodata');

  // ---- direct unit checks ----------------------------------------------
  // splitAtSecondFtyp: A followed by B's ftyp -> cut at A
  const mixed = concatU8(FILE_A, FILE_B.subarray(0, 20));
  const cut = sr.splitAtSecondFtyp(mixed);
  assert.ok(sameBytes(cut, FILE_A), 'splitAtSecondFtyp cut');

  // verifyContinuity: a gapped file (fragments 1-9 skipped) must fail
  const gapFrags = [[0, 0], [1, 48000], [2, 96000], [10, 480000], [11, 528000], [12, 576000]];
  const gapFile = file(gapFrags, 77);
  assert.notStrictEqual(sr.verifyContinuity(gapFile), null, 'gap not detected');
  // verifyContinuity: backwards/duplicated fragment times must fail
  const backFrags = [[0, 0], [1, 48000], [2, 96000], [1, 48000]];
  const backFile = file(backFrags, 88);
  assert.notStrictEqual(sr.verifyContinuity(backFile), null, 'backwards times not detected');
  // a clean file passes
  assert.strictEqual(sr.verifyContinuity(FILE_A), null);

  // streamed-style file with unknown-length mdat (size 0) still verifies
  const streamed = (() => {
    const parts = [ftyp(), moov(), moof(0, 0), moof(1, 48000), moof(2, 96000)];
    const head = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) { head.set(p, o); o += p.length; }
    // one mdat with size 0, padding out past MIN_BYTES
    const mdat = new Uint8Array(600_000);
    mdat[4] = 109; mdat[5] = 100; mdat[6] = 97; mdat[7] = 116; // 'mdat', size 0
    return concatU8(head, mdat);
  })();
  assert.strictEqual(sr.verifyMp4(streamed), null, 'size-0 mdat file should verify');
  assert.strictEqual(sr.verifyContinuity(streamed), null, 'size-0 mdat continuity check');

  console.log('recorder tests: all passed');
  process.exit(0);
})().catch((e) => {
  console.error('recorder tests FAILED:', e && e.message);
  console.error(e && e.stack);
  process.exit(1);
});