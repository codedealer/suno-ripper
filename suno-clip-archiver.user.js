// ==UserScript==
// @name         Suno Clip Archiver
// @namespace    https://suno.com/
// @version      0.6.0
// @description  Adds a per-track archive button to Suno library rows. Captures the DRM-decrypted audio (Opus-in-MP4 fragments) as the player's MediaSource buffers it, and saves it locally. One track at a time; remembers archived tracks; Shift+click forces re-download.
// @author       you
// @match        https://suno.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // ---- Config -------------------------------------------------------------
  const ARCHIVED_KEY = 'sunoripper.archivedClips'; // clipId -> {title, at}
  const PENDING_KEY = 'sunoripper.pendingClip';    // auto-resume after navigation
  const MIN_BYTES = 500_000;        // sanity: a real track is bigger than this
  const MAX_WAIT_MS = 240_000;      // give up on capture after this
  const NO_DATA_MS = 20_000;        // no decrypted audio this soon => error
  const SETTLE_MS = 800;            // let final appends land after stopping
  const CAPTURE_RATE = 4;           // fast-forward (muted) so streams finish quickly
  const PENDING_TTL_MS = 10 * 60_000;
  const EXT = 'm4a';
  // Stream recorder: we record every decrypted append from document start so
  // a track already loaded in the player can be archived in place (no
  // navigation to its page): the recorder keeps the bytes from the moment the
  // track's stream began (the ftyp prefix), and a capture only needs to wait
  // for the rest of the file to buffer.
  const REC_POLL_MS = 300;          // playbar attribution / completion polling
  const REC_GRACE_MS = 1500;        // a new file with an unchanged playbar is
                                    // judged restart-vs-prebuffer after this
  const REC_HISTORY_MAX = 3;        // completed clips kept for instant re-save
  const REC_CLIP_MAX = 24_000_000;  // safety cap per clip recording
  // Optional local receiver (e.g. in sandboxed browsers where anchor
  // downloads are blocked): if it answers, the capture is POSTed there
  // instead of using the in-page anchor download.
  const RECEIVER_URL = 'http://127.0.0.1:8765/save';
  const RECEIVER_TIMEOUT_MS = 2000;
  // --------------------------------------------------------------------------

  const BTN_ATTR = 'data-sunoripper-btn';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- Storage -------------------------------------------------------------
  function getArchived() {
    const v = GM_getValue(ARCHIVED_KEY, null);
    return v && typeof v === 'object' ? v : {};
  }
  function setArchived(map) {
    GM_setValue(ARCHIVED_KEY, map);
  }
  function getPending() {
    const v = GM_getValue(PENDING_KEY, null);
    return v && typeof v === 'object' && v.clipId ? v : null;
  }
  function setPending(v) {
    if (v === null) GM_setValue(PENDING_KEY, null);
    else GM_setValue(PENDING_KEY, v);
  }

  // ---- Row helpers ---------------------------------------------------------
  function clipIdFromRow(row) {
    // Preferred: React fiber carries the clipId as a prop directly.
    try {
      const key = Object.keys(row).find((k) => k.startsWith('__reactFiber$'));
      if (key) {
        const v = row[key].memoizedProps && row[key].memoizedProps.clipId;
        if (typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v)) return v;
      }
    } catch (e) {}
    // Fallback: artwork URL looks like https://cdn2.suno.ai/image[_large]_<clipId>.jpeg
    // Lazy-loaded images carry the real URL in data-src.
    const img = row.querySelector('img');
    if (img) {
      const candidates = [img.getAttribute('src'), img.getAttribute('data-src')].filter(Boolean);
      for (const u of candidates) {
        const m = u.match(/image(?:_large|_small|_thumb)?_([0-9a-f-]{36})/i);
        if (m) return m[1];
      }
    }
    return null;
  }

  function playbarSongId() {
    // Anchor to the playbar itself: its play/pause button's parent holds the
    // /song/<clipId> link. The first /song/ link in DOM order is often an
    // unrelated related-songs carousel.
    const pb = document.querySelector('[aria-label^="Playbar:"]');
    if (pb && pb.parentElement) {
      const link = pb.parentElement.querySelector('a[href*="/song/"]');
      if (link) {
        const m = (link.getAttribute('href') || '').match(/\/song\/([0-9a-f-]{36})/i);
        if (m) return m[1];
      }
    }
    return null;
  }

  function getMainAudio() {
    // The player's audio element carries a blob: (or http) media src;
    // the other <audio> on the page is the silent placeholder (sil-100.mp3).
    const els = [...document.querySelectorAll('audio')];
    return (
      els.find((a) => a.currentSrc && a.currentSrc.startsWith('blob:')) ||
      els.find((a) => a.currentSrc && !/sil-/.test(a.currentSrc)) ||
      els[0] ||
      null
    );
  }

  // ---- Stream recorder ------------------------------------------------------
  // Suno streams encrypted audio; the app decrypts it in-page and feeds the
  // plaintext (fragmented MP4, Opus codec) to a MediaSource via
  // SourceBuffer.appendBuffer. A fresh stream always begins with an `ftyp`
  // box — that box is our file boundary. We record every append (attributed
  // to the clip shown in the playbar) so a track loaded in this document can
  // be archived without replaying it from the beginning:
  //   - a fully played track is already complete in the recorder (instant
  //     save, no playback at all);
  //   - a partially played track is resumed and only the rest is captured;
  //   - auto-advance / pre-buffered next tracks get their own recording, so
  //     their bytes never contaminate the current clip's file.
  let rec = null;            // current stream's recording
  let recHistory = new Map(); // clipId -> closed, complete recording
  let recOrder = [];          // LRU order of recHistory
  let endedEl = null;         // audio element with the 'ended' listener

  function newRec(clipId) {
    return {
      clipId: clipId || null,
      chunks: [],          // recorded bytes, in append order
      total: 0,
      files: [0],          // file-start offsets (each a detected ftyp box)
      fileFtyp: [false],   // true when that start really is an ftyp box
      firstFtyp: false,    // the stream began with ftyp (has a file prefix)
      pending: null,       // {offset, at, src} unconfirmed new-file start
      complete: false,     // the track played to the end
      lastGrowth: 0,
      tail: new Uint8Array(0), // last <=7 bytes (an ftyp box can span appends)
    };
  }

  function getRec(clipId) {
    if (rec && rec.clipId === clipId) return rec;
    return recHistory.get(clipId) || null;
  }

  function tailOf(chunks) {
    const out = new Uint8Array(7);
    let off = 7;
    for (let i = chunks.length - 1; i >= 0 && off > 0; i--) {
      const c = chunks[i];
      const take = Math.min(c.length, off);
      off -= take;
      out.set(c.subarray(c.length - take), off);
    }
    return off === 7 ? new Uint8Array(0) : out.subarray(0, 7 - off).slice();
  }

  function splitChunks(chunks, offset) {
    const before = [];
    const after = [];
    let off = 0;
    for (const c of chunks) {
      const cEnd = off + c.length;
      if (cEnd <= offset) { before.push(c); off = cEnd; continue; }
      if (off < offset) {
        before.push(c.slice(0, offset - off));
        after.push(c.slice(offset - off));
      } else {
        after.push(c);
      }
      off = cEnd;
    }
    return { before, after };
  }

  // Close the current recording; keep it in history only if it completed.
  function retireRec() {
    const r = rec;
    rec = null;
    if (!r || !r.clipId) return;
    if (r.complete && r.total >= MIN_BYTES) {
      recHistory.set(r.clipId, r);
      const i = recOrder.indexOf(r.clipId);
      if (i >= 0) recOrder.splice(i, 1);
      recOrder.push(r.clipId);
      while (recOrder.length > REC_HISTORY_MAX) recHistory.delete(recOrder.shift());
    }
  }

  // A fresh MP4 stream begins with an `ftyp` box: [size(4)]"ftyp". Find one
  // in `chunk` (or spanning the previous chunk's tail). Returns the stream
  // offset of the box start, or -1.
  function findFtypStart(chunk, tail, start) {
    // A box header can straddle two appendBuffer calls: check the tail first
    // (it is the earlier offset if it matches).
    if (tail.length > 0) {
      const n = Math.min(chunk.length, 7);
      const span = new Uint8Array(tail.length + n);
      span.set(tail, 0);
      span.set(chunk.subarray(0, n), tail.length);
      for (let i = 0; i + 8 <= span.length; i++) {
        if (i + 7 < tail.length) continue; // fully inside the tail: seen before
        if (span[i + 4] !== 102 || span[i + 5] !== 116 || span[i + 6] !== 121 || span[i + 7] !== 112) continue;
        const size = span[i] * 16777216 + span[i + 1] * 65536 + span[i + 2] * 256 + span[i + 3];
        if (size >= 8 && size < 4096) return start - tail.length + i;
      }
    }
    for (let i = 0; i + 8 <= chunk.length; i++) {
      if (chunk[i + 4] !== 102 || chunk[i + 5] !== 116 || chunk[i + 6] !== 121 || chunk[i + 7] !== 112) continue;
      const size = chunk[i] * 16777216 + chunk[i + 1] * 65536 + chunk[i + 2] * 256 + chunk[i + 3];
      if (size >= 8 && size < 4096) return start + i;
    }
    return -1;
  }

  function appendChunk(u8) {
    if (!rec) rec = newRec(playbarSongId());
    if (rec.total >= REC_CLIP_MAX) return; // safety valve
    const chunk = u8.slice(); // copy: the app may reuse its buffer
    const start = rec.total;
    const found = findFtypStart(chunk, rec.tail, start);
    if (found >= 0) {
      if (found === 0) {
        // a file start at offset 0 is the stream's first file — even when the
        // ftyp box spans the first two appends and is only detected now
        rec.firstFtyp = true;
        rec.fileFtyp[0] = true;
      } else if (!rec.pending) {
        rec.pending = { offset: found, at: Date.now() };
      }
    }
    rec.chunks.push(chunk);
    rec.total += chunk.length;
    rec.lastGrowth = Date.now();
    const prevTail = rec.tail;
    const newTail = new Uint8Array(Math.min(prevTail.length + chunk.length, 7));
    const takePrev = Math.min(prevTail.length, Math.max(0, 7 - chunk.length));
    const takeChunk = Math.min(chunk.length, 7 - takePrev);
    newTail.set(prevTail.subarray(prevTail.length - takePrev), 0);
    newTail.set(chunk.subarray(chunk.length - takeChunk), takePrev);
    rec.tail = newTail;
  }

  function onEnded() {
    if (!rec || !rec.firstFtyp || rec.total < MIN_BYTES) return;
    const pb = playbarSongId();
    if (pb && pb !== rec.clipId) return; // stale: the player already moved on
    rec.complete = true;
  }

  function recPoll() {
    const a = getMainAudio();
    if (a) {
      if (a !== endedEl) {
        if (endedEl) endedEl.removeEventListener('ended', onEnded);
        endedEl = a;
        a.addEventListener('ended', onEnded);
      }
      // backup for the 'ended' event (throttled page, missed event)
      if (rec && a.ended && rec.firstFtyp && rec.total >= MIN_BYTES) rec.complete = true;
    }
    const pb = playbarSongId();
    if (rec && pb) {
      if (rec.clipId === null) {
        rec.clipId = pb; // attribute an unattributed recording
        return;
      }
      if (pb !== rec.clipId) {
        // the player moved to a different clip: close this recording
        let handed = [];
        if (rec.pending) {
          const parts = splitChunks(rec.chunks, rec.pending.offset);
          rec.chunks = parts.before;
          rec.total = rec.pending.offset;
          rec.tail = tailOf(parts.before);
          rec.pending = null;
          handed = parts.after; // the new clip's bytes, already received
        }
        retireRec();
        rec = newRec(pb);
        for (const c of handed) appendChunk(c);
        return;
      }
    }
    if (rec && rec.pending && Date.now() - rec.pending.at >= REC_GRACE_MS) {
      const p = rec.pending;
      const now = getMainAudio();
      if (now && !now.ended) {
        // a fresh stream for the current clip while the track is still in
        // progress: the app recreated its MediaSource and re-streamed from
        // byte 0 — the new file supersedes the old one
        rec.files.push(p.offset);
        rec.fileFtyp.push(true);
        rec.pending = null;
        rec.complete = false; // the new stream must play to the end again
      } else {
        // the current track has ended (or no audio element): a foreign stream
        // (e.g. the player pre-buffering the next queue track) — this clip's
        // file ends at the boundary
        const parts = splitChunks(rec.chunks, p.offset);
        rec.chunks = parts.before;
        rec.total = p.offset;
        rec.tail = tailOf(parts.before);
        rec.pending = null;
        retireRec();
        rec = newRec(null); // unattributed until the playbar moves
        for (const c of parts.after) appendChunk(c);
      }
    }
  }

  // ---- Capture session ------------------------------------------------------
  // One archive at a time. The recorder above runs continuously; `capture`
  // marks the active archive (and receives a whole-file Blob if the app ever
  // uses progressive delivery instead of MediaSource).
  let capture = null; // {clipId, btn, blob}

  (function hookAppendBuffer() {
    const orig = SourceBuffer.prototype.appendBuffer;
    SourceBuffer.prototype.appendBuffer = function (data) {
      try {
        if (data) {
          let u8;
          if (data instanceof Uint8Array) u8 = data;
          else if (data instanceof ArrayBuffer) u8 = new Uint8Array(data);
          else if (data && data.buffer instanceof ArrayBuffer)
            u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          else u8 = null; // Blob appends: rare, handled via the blob path
          if (u8 && u8.byteLength) appendChunk(u8);
        }
      } catch (e) {
        /* never break playback */
      }
      return orig.call(this, data);
    };
  })();

  // Progressive-delivery fallback: if the app ever creates one big audio Blob,
  // capture it directly.
  (function hookCreateObjectURL() {
    const orig = URL.createObjectURL;
    URL.createObjectURL = function (obj) {
      try {
        if (capture && obj instanceof Blob && obj.type && obj.type.startsWith('audio') && obj.size >= MIN_BYTES) {
          capture.blob = obj;
        }
      } catch (e) {}
      return orig.call(this, obj);
    };
  })();

  // ---- MP4 helpers -----------------------------------------------------------
  // A fresh MP4 stream begins with an `ftyp` box: [size(4)] "ftyp".
  const FTYPE = [102, 116, 121, 112]; // 'f' 't' 'y' 'p'
  function isFtypBox(u8) {
    return u8.length >= 8 && u8[4] === 102 && u8[5] === 116 && u8[6] === 121 && u8[7] === 112;
  }

  /** The target's last recorded file: from its last ftyp start to the end of
   *  its recording (cut at an unconfirmed boundary). Null if unavailable. */
  function assembleRec(r) {
    const n = r.files.length;
    const start = r.files[n - 1];
    if (!r.fileFtyp[n - 1]) return null;
    const end = r.pending ? Math.min(r.total, r.pending.offset) : r.total;
    if (end <= start) return null;
    const out = new Uint8Array(end - start);
    let pos = 0;
    let off = 0;
    for (const c of r.chunks) {
      const cEnd = off + c.length;
      if (cEnd <= start) { off = cEnd; continue; }
      if (off >= end) break;
      const from = Math.max(start, off) - off;
      const to = Math.min(end, cEnd) - off;
      out.set(c.subarray(from, to), pos);
      pos += to - from;
      off = cEnd;
    }
    return pos === out.length ? out : null;
  }

  // If the player auto-advanced to the next track right after the target
  // ended, the next track's own ftyp box is appended after our data. Split at
  // the second ftyp box so we keep only the target file. (Live boundary
  // tracking normally prevents this; kept as a safety net.)
  function splitAtSecondFtyp(bytes) {
    if (!isFtypBox(bytes)) return bytes; // file doesn't even start with ftyp
    for (let i = 8; i + 4 <= bytes.length; i++) {
      if (bytes[i] === 102 && bytes[i + 1] === 116 && bytes[i + 2] === 121 && bytes[i + 3] === 112) {
        // require a plausible box size (4 bytes before) to avoid false hits
        const size = bytes[i - 4] * 16777216 + bytes[i - 3] * 65536 + bytes[i - 2] * 256 + bytes[i - 1];
        if (size >= 8 && size < 4096) return bytes.slice(0, i - 4);
      }
    }
    return bytes;
  }

  /** Verify the assembled file is a sane fragmented MP4. Returns null or an error string.
   *  The box walk is lenient: it stops (without failing) at an `mdat` with
   *  unknown length (size 0 / 0xFFFFFFFF — legal in streamed MP4) or at a
   *  truncated box; completeness itself is proven by the recorder, this is
   *  a sanity net. */
  function walkBoxes(bytes, visit) {
    const u32 = (o) => bytes[o] * 16777216 + bytes[o + 1] * 65536 + bytes[o + 2] * 256 + bytes[o + 3];
    let o = 0;
    while (o + 8 <= bytes.length) {
      const size = u32(o);
      const type = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]);
      if (type === 'mdat' && (size === 0 || size === 0xFFFFFFFF)) break; // reads to the end
      if (size < 8 || o + size > bytes.length) break;
      visit(o, size, type);
      o += size;
    }
  }

  function verifyMp4(bytes) {
    if (!isFtypBox(bytes)) return 'data does not start with an ftyp box';
    if (bytes.length < MIN_BYTES) return `file too small (${bytes.length} bytes)`;
    let sawMoov = false;
    let moofs = 0;
    walkBoxes(bytes, (o, size, type) => {
      if (type === 'moov') sawMoov = true;
      if (type === 'moof') moofs++;
    });
    if (!sawMoov) return 'no moov box found';
    if (moofs < 2) return `too few fragments (${moofs})`;
    return null;
  }

  /** baseMediaTime of every moof fragment, in file order. */
  function fragBaseTimes(bytes) {
    const u32 = (o) => bytes[o] * 16777216 + bytes[o + 1] * 65536 + bytes[o + 2] * 256 + bytes[o + 3];
    const s4 = (o) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
    const times = [];
    walkBoxes(bytes, (o, size, type) => {
      if (type !== 'moof') return;
      let p = o + 8;
      while (p + 8 <= o + size) {
        const s2 = u32(p);
        if (s2 < 8 || p + s2 > o + size) break;
        if (s4(p + 4) === 'traf') {
          let q = p + 8;
          while (q + 8 <= p + s2) {
            const s3 = u32(q);
            if (s3 < 8 || q + s3 > p + s2) break;
            if (s4(q + 4) === 'tfdt') {
              const ver = bytes[q + 8];
              const hi = u32(q + 12);
              times.push(ver === 0 ? hi : hi * 4294967296 + u32(q + 16));
            }
            q += s3;
          }
        }
        p += s2;
      }
    });
    return times;
  }

  /**
   * Verify fragment times are contiguous. Catches a stale prefix: if the
   * player dropped its MediaSource and re-streamed from the playhead, a naive
   * prefix+tail concatenation would be silently gapped.
   */
  function verifyContinuity(bytes) {
    const times = fragBaseTimes(bytes);
    if (times.length < 2) return null; // not enough visible fragments to check
    const d = [];
    for (let i = 1; i < times.length; i++) {
      const dt = times[i] - times[i - 1];
      if (dt <= 0) return 'fragment times go backwards';
      d.push(dt);
    }
    d.sort((a, b) => a - b);
    const med = d[d.length >> 1];
    for (let i = 1; i < times.length; i++) {
      if (times[i] - times[i - 1] > med * 4) return 'fragment time gap (buffer was dropped)';
    }
    return null;
  }

  // ---- Player control ----------------------------------------------------------
  function boostPlayback() {
    const a = getMainAudio();
    if (!a) return;
    try {
      if (a.__srWasMuted === undefined) a.__srWasMuted = a.muted;
      a.muted = true;
      a.playbackRate = CAPTURE_RATE;
      a.defaultPlaybackRate = CAPTURE_RATE;
      if (a.paused) a.play().catch(() => {});
    } catch (e) {}
  }

  function resetPlayer() {
    const a = getMainAudio();
    if (!a) return;
    try {
      a.playbackRate = 1;
      a.defaultPlaybackRate = 1;
      a.muted = a.__srWasMuted || false;
      delete a.__srWasMuted;
      if (!a.paused) a.pause();
    } catch (e) {}
  }

  /** Resume the playbar's current track (no-op if already playing). */
  function resumeCurrent() {
    const a = getMainAudio();
    if (!a || !a.paused) return;
    try {
      if (a.__srWasMuted === undefined) a.__srWasMuted = a.muted;
      a.muted = true; // the capture is muted; boostPlayback() picks the rate
    } catch (e) {}
    const pb = document.querySelector('[aria-label="Playbar: Play button"]');
    if (pb) { pb.click(); return; }
    a.play().catch(() => {});
  }

  // ---- Waiting ------------------------------------------------------------------
  /**
   * Wait until the target clip's recording shows a file prefix (a fresh
   * stream from byte 0). Returns {status: 'fresh'|'midfile'|'blob'|'nodata'}.
   */
  async function waitForRecFtyp(clipId, timeoutMs = NO_DATA_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (capture && capture.blob) return { status: 'blob' };
      const r = getRec(clipId);
      if (r) {
        if (r.firstFtyp || r.files.length > 1) return { status: 'fresh', rec: r };
        if (r.total > 0) return { status: 'midfile', rec: r };
      }
      await sleep(100);
    }
    return { status: 'nodata' };
  }

  /**
   * Wait until the target clip's file is fully buffered: it played to the
   * end, the player moved on (auto-advance), or the byte total stops growing
   * while the playhead is at the end.
   */
  async function waitForTarget(clipId, timeoutMs = MAX_WAIT_MS) {
    const deadline = Date.now() + timeoutMs;
    let plateauTotal = -1;
    let plateauAt = 0;
    while (Date.now() < deadline) {
      const r = getRec(clipId);
      if (r) {
        if (r.complete) return 'complete';
        if (rec !== r) return 'switched'; // the player moved to another clip
        if (r.total >= MIN_BYTES) {
          if (r.total !== plateauTotal) {
            plateauTotal = r.total;
            plateauAt = Date.now();
          } else if (Date.now() - plateauAt >= 6000) {
            const a = getMainAudio();
            const atEnd = a && (a.ended || (a.duration && isFinite(a.duration) && a.currentTime >= a.duration - 2));
            if (atEnd) return 'plateau'; // buffering finished; keep waiting if it was a stall
          }
        }
      }
      await sleep(150);
    }
    return 'timeout';
  }

  // ---- Download ---------------------------------------------------------------
  function sanitize(name) {
    return (
      (name || 'untitled')
        .replace(/[\\/:*?"<>|#%&{}$!'@+=`]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120) || 'untitled'
    );
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  /**
   * Deliver the captured blob to disk.
   * Prefers a local receiver when one is running (sandboxed browsers block
   * anchor downloads); falls back to the in-page anchor download.
   * Returns 'receiver' or 'anchor'.
   */
  async function deliverBlob(blob, filename) {
    try {
      const r = await fetch(RECEIVER_URL, {
        method: 'POST',
        // Percent-encode: header values must stay latin-1 (titles with
        // curly quotes etc. would otherwise be mangled).
        headers: { 'X-Filename': encodeURIComponent(filename), 'Content-Type': 'application/octet-stream' },
        body: blob,
        signal: AbortSignal.timeout(RECEIVER_TIMEOUT_MS),
      });
      if (r.ok) {
        console.log(`[suno-archiver] saved via receiver: ${filename}`);
        return 'receiver';
      }
    } catch (e) { /* receiver not running — use the anchor */ }
    downloadBlob(blob, filename);
    return 'anchor';
  }

  // ---- Archive flow ---------------------------------------------------------------
  // Tracks already loaded in the player are captured in place — the recorder
  // holds their bytes from stream start, so no navigation is needed:
  //   - played to the end in this document: saved instantly, no playback;
  //   - partially played: resumed (muted, 4x) and only the rest captured;
  //   - not loaded yet: the row's play control is clicked and the whole
  //     stream is captured.
  // The single navigation to the song page remains only as a fallback for a
  // track whose file prefix we never recorded (e.g. it started playing
  // before this document did).
  async function archiveClip(row, btn, force) {
    const clipId = clipIdFromRow(row);
    if (!clipId) {
      setButtonState(btn, 'idle', 'Could not find clip id in artwork URL');
      return;
    }

    const archived = getArchived();
    if (archived[clipId] && !force) {
      setButtonState(btn, 'archived', `Archived ${new Date(archived[clipId].at).toLocaleString()} — Shift+click to re-download`);
      return;
    }
    if (capture) {
      setButtonState(btn, 'idle', 'Another archive is in progress — wait for it to finish');
      return;
    }
    if (getPending()) {
      setButtonState(btn, 'idle', 'An archive is already pending');
      return;
    }

    const title = row.getAttribute('aria-label') || clipId;

    // Instant path: this track played to the end in this document, so the
    // recorder already holds its complete file. No playback, no navigation.
    const rec0 = getRec(clipId);
    if (rec0 && rec0.complete) {
      const bytes = assembleRec(rec0);
      if (bytes) {
        const err = verifyMp4(bytes) || verifyContinuity(bytes);
        if (!err) {
          capture = { clipId, btn, blob: null };
          try {
            await finishCapture(clipId, title, btn, new Blob([bytes], { type: 'audio/mp4' }));
            return;
          } catch (e) {
            console.warn('[suno-archiver] instant save failed; falling back to playback capture', e);
          }
          capture = null;
        }
      }
    }

    const alreadyLoaded = playbarSongId() === clipId;
    const pending = {
      clipId,
      title,
      at: Date.now(),
      returnUrl: location.href,
      navigated: 0,
    };
    setPending(pending);

    if (alreadyLoaded) {
      // In-place capture needs the file prefix recorded for this clip.
      let r = getRec(clipId);
      if (!r) {
        // the playbar may have changed just now; give the recorder a moment
        const d = Date.now() + 1500;
        while (!r && Date.now() < d) {
          await sleep(200);
          r = getRec(clipId);
        }
      }
      if (!r || !r.firstFtyp) {
        // no usable prefix (the track started before this script did, or the
        // stream is a mid-file resume): a fresh document is the only way to
        // byte 0.
        pending.navigated = 1;
        setPending(pending);
        setButtonState(btn, 'downloading', 'Starting capture…');
        console.log('[suno-archiver] no in-place prefix for', clipId, '— navigating fresh');
        setTimeout(() => (location.href = `/song/${clipId}`), 300);
        return;
      }
    }

    await runCapture(clipId, title, btn, row, alreadyLoaded);
  }

  /** The actual capture; runs in the current document. */
  async function runCapture(clipId, title, btn, row, alreadyLoaded) {
    const onSongPage = new RegExp(`/song/${clipId}$`, 'i').test(location.pathname);
    capture = { clipId, btn, blob: null };
    try {
      setButtonState(btn, 'downloading', 'Buffering + capturing (muted, fast-forward)…');

      // Start (or resume) playback.
      if (onSongPage) {
        const pb = document.querySelector('[aria-label="Playbar: Play button"]');
        if (!pb) throw new Error('playbar play button not found on song page');
        pb.click();
      } else if (row && !alreadyLoaded) {
        // The row's artwork div is the play control; a plain row.click()
        // does NOT start playback.
        const play =
          row.querySelector('.clip-image-container[aria-label^="Play "]') ||
          row.querySelector('[aria-label^="Play "]');
        if (play) play.click();
        else row.click();
      } else {
        resumeCurrent(); // already-loaded track: resume from the playhead
      }

      // Wait for the file prefix (a fresh stream from byte 0).
      const start = await waitForRecFtyp(clipId);
      if (start.status === 'midfile') {
        // The player resumed an already-loaded track mid-file without a
        // recorded prefix: do the single fresh navigation.
        capture = null;
        const p = getPending();
        if (p && p.navigated < 1) {
          p.navigated = 1;
          p.at = Date.now();
          setPending(p);
          setButtonState(btn, 'downloading', 'Mid-file resume — navigating for a fresh start…');
          console.log('[suno-archiver] mid-file resume detected, navigating fresh');
          setTimeout(() => (location.href = `/song/${clipId}`), 300);
          return;
        }
        throw new Error('player keeps resuming mid-file — open the song page manually and retry');
      }
      if (start.status === 'blob') {
        const bytes = new Uint8Array(await capture.blob.arrayBuffer());
        const err = verifyMp4(bytes);
        if (err) throw new Error(`captured data invalid: ${err}`);
        await finishCapture(clipId, title, btn, new Blob([bytes], { type: 'audio/mp4' }));
        return;
      }
      if (start.status !== 'fresh') throw new Error('track did not start streaming');

      // Fast-forward (muted) so the rest of the stream finishes quickly.
      boostPlayback();

      // Wait for the target file to be fully buffered.
      const endReason = await waitForTarget(clipId);
      if (endReason === 'timeout') throw new Error('capture timed out — retry');
      if (endReason === 'switched') throw new Error('player switched tracks during capture — retry');

      // Stop the player immediately (don't let the next track run on), then
      // let any final appends land. Arm the auto-advance guard NOW: the app
      // may start the next track within ~2s, around our pause.
      resetPlayer();
      armStopGuard(clipId);
      await sleep(SETTLE_MS);

      const r = getRec(clipId);
      if (!r) throw new Error('recording lost');
      let bytes = assembleRec(r);
      if (!bytes) throw new Error('no complete file in recording');
      bytes = splitAtSecondFtyp(bytes); // safety net for a missed live boundary
      const err = verifyMp4(bytes) || verifyContinuity(bytes);
      if (err) {
        const p = getPending();
        if (err.startsWith('fragment time') && p && p.navigated < 1) {
          // the player dropped its MediaSource and re-streamed from the
          // playhead: our recorded prefix is stale — get a fresh stream
          capture = null;
          p.navigated = 1;
          p.at = Date.now();
          setPending(p);
          setButtonState(btn, 'downloading', 'Stale buffer — navigating for a fresh start…');
          console.log('[suno-archiver] fragment time discontinuity, navigating fresh');
          setTimeout(() => (location.href = `/song/${clipId}`), 300);
          return;
        }
        throw new Error(`captured data invalid: ${err}`);
      }

      await finishCapture(clipId, title, btn, new Blob([bytes], { type: 'audio/mp4' }));
    } catch (e) {
      resetPlayer();
      capture = null;
      setPending(null);
      if (btn) setButtonState(btn, 'idle', `Failed: ${e.message} — click to retry`);
      console.error('[suno-archiver]', e);
    }
  }

  let stopGuard = null;

  /**
   * The app auto-advances to the next track ~0.5-2s after our target ends —
   * around/after our own resetPlayer, so a single pause cannot prevent it.
   * Arm a short-lived guard: if the (currently idle) player starts a
   * different clip after arming, stop it — the user asked for an archive,
   * not a new song. If the player is already playing something when we arm
   * (e.g. the user was listening to the next track while archiving a
   * finished one), leave it alone. The capture path arms this right at
   * resetPlayer (before the advance can land); the instant path arms it in
   * finishCapture.
   */
  function armStopGuard(clipId) {
    try {
      if (stopGuard) return; // already armed
      const a = getMainAudio();
      if (!a || !a.paused) return;
      const srcAtEnd = a.currentSrc;
      const stop = () => {
        try {
          const pb = playbarSongId();
          const newTrack = !!a.currentSrc && a.currentSrc !== srcAtEnd;
          if (!a.paused && (newTrack || (pb && pb !== clipId))) a.pause();
        } catch (_) {}
      };
      a.addEventListener('play', stop);
      stopGuard = {
        a,
        stop,
        timer: setTimeout(() => disarmStopGuard(), 8000),
      };
    } catch (_) {}
  }

  function disarmStopGuard() {
    if (!stopGuard) return;
    clearTimeout(stopGuard.timer);
    try { stopGuard.a.removeEventListener('play', stopGuard.stop); } catch (_) {}
    stopGuard = null;
  }

  /** Deliver to disk, mark archived, clear pending, return if we navigated. */
  async function finishCapture(clipId, title, btn, blob) {
    const filename = `${sanitize(title)} (${clipId.slice(0, 8)}).${EXT}`;
    await deliverBlob(blob, filename);

    const archived = getArchived();
    archived[clipId] = { title, at: new Date().toISOString() };
    setArchived(archived);

    const pending = getPending();
    const returnUrl = pending && pending.returnUrl;
    setPending(null);
    setButtonState(btn, 'archived', 'Archived — Shift+click to re-download');
    console.log(`[suno-archiver] archived ${title} (${clipId}), ${blob.size} bytes`);
    capture = null;
    armStopGuard(clipId);

    // If we navigated here, return the user to where they were.
    if (returnUrl && returnUrl !== location.href) {
      setTimeout(() => (location.href = returnUrl), 1500);
    }
  }

  // Auto-resume after a navigation (fresh song page, or interrupted reload).
  async function resumePending() {
    const pending = getPending();
    if (!pending || Date.now() - pending.at > PENDING_TTL_MS) {
      if (pending) setPending(null);
      return;
    }
    const { clipId, title, navigated, returnUrl } = pending;
    const onSongPage = new RegExp(`/song/${clipId}$`, 'i').test(location.pathname);

    if (!onSongPage) {
      // We expected to be on the song page but aren't (e.g., the user
      // navigated somewhere). Go there once; if we already navigated once,
      // give up instead of looping.
      if (navigated < 1) {
        pending.navigated = 1;
        pending.at = Date.now();
        setPending(pending);
        setTimeout(() => (location.href = `/song/${clipId}`), 300);
        return;
      }
      setPending(null);
      console.error('[suno-archiver] not on song page and already navigated once — giving up');
      return;
    }

    // Wait for the page to be ready (playbar play button present).
    const deadline = Date.now() + 60_000;
    let btn = null;
    while (Date.now() < deadline) {
      btn = document.querySelector('[aria-label="Playbar: Play button"]');
      if (btn && playbarSongId() === clipId) break;
      await sleep(1000);
    }
    if (!btn || playbarSongId() !== clipId) {
      setPending(null);
      console.error('[suno-archiver] song page did not become ready — giving up');
      return;
    }

    await sleep(1000);
    await runCapture(clipId, title || clipId, null, null, true);
  }

  // ---- UI --------------------------------------------------------------------------
  function makeButton(row) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute(BTN_ATTR, '');
    btn.style.cssText = [
      'position:absolute', 'top:6px', 'right:6px', 'z-index:5',
      'display:flex', 'align-items:center', 'justify-content:center',
      'width:28px', 'height:28px', 'border:none', 'border-radius:6px',
      'background:transparent', 'color:#9ca3af', 'cursor:pointer',
      'font-size:14px', 'padding:0',
    ].join(';');
    btn.addEventListener('mouseenter', () => (btn.style.background = 'rgba(255,255,255,0.08)'));
    btn.addEventListener('mouseleave', () => (btn.style.background = 'transparent'));
    btn.addEventListener('click', (e) => {
      e.stopPropagation(); // don't let the row's own play handler fire
      archiveClip(row, btn, e.shiftKey);
    });
    return btn;
  }

  function setButtonState(btn, state, tip) {
    if (!btn) return;
    btn.textContent = state === 'archived' ? '✓' : state === 'downloading' ? '⋯' : '⬇';
    btn.style.color = state === 'archived' ? '#4ade80' : '#9ca3af';
    btn.disabled = state === 'downloading';
    if (tip) btn.title = tip;
  }

  function decorate(row) {
    if (row.hasAttribute(BTN_ATTR) || row.querySelector(`[${BTN_ATTR}]`)) return;
    if (!clipIdFromRow(row)) return;

    const btn = makeButton(row);
    const archived = getArchived();
    if (archived[clipIdFromRow(row)]) {
      setButtonState(btn, 'archived', 'Archived — Shift+click to re-download');
    } else {
      setButtonState(btn, 'idle', 'Archive this track locally (plays it briefly, muted, to capture) — Shift+click to re-download');
    }
    row.style.position = 'relative';
    row.appendChild(btn);
  }

  function scan() {
    document.querySelectorAll('.clip-row[role="group"]').forEach(decorate);
  }

  const observer = new MutationObserver(scan);
  function start() {
    observer.observe(document.body, { childList: true, subtree: true });
    scan();
    setInterval(recPoll, REC_POLL_MS);
    resumePending();
    console.log('[suno-archiver] active v0.6.0');
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }

  // Test hook (used by test/recorder.test.js; harmless in the browser).
  try {
    window.__sunoripper = {
      rec: () => rec,
      history: () => recHistory,
      appendChunk,
      recPoll,
      getRec,
      assembleRec,
      verifyMp4,
      verifyContinuity,
      splitAtSecondFtyp,
      waitForRecFtyp,
      waitForTarget,
    };
  } catch (e) {}
})();