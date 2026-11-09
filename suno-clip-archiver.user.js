// ==UserScript==
// @name         Suno Clip Archiver
// @namespace    https://suno.com/
// @version      0.5.0
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
  const SETTLE_MS = 1500;           // let final appends land after end-of-track
  const CAPTURE_RATE = 4;           // fast-forward (muted) so streams finish quickly
  const PENDING_TTL_MS = 10 * 60_000;
  const EXT = 'm4a';
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

  // ---- Capture session ------------------------------------------------------
  // Suno streams encrypted audio; the app decrypts it in-page and feeds the
  // plaintext (fragmented MP4, Opus codec) to MediaSource via
  // SourceBuffer.appendBuffer. We collect those chunks while the target track
  // buffers and concatenate them into the complete file.
  let session = null; // {clipId, chunks, total, firstAt, lastGrowth, blob}

  (function hookAppendBuffer() {
    const orig = SourceBuffer.prototype.appendBuffer;
    SourceBuffer.prototype.appendBuffer = function (data) {
      try {
        if (session && data) {
          let u8;
          if (data instanceof Uint8Array) u8 = data;
          else if (data instanceof ArrayBuffer) u8 = new Uint8Array(data);
          else if (data && data.buffer instanceof ArrayBuffer)
            u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          else if (data instanceof Blob) { u8 = null; } // rare; handled via blob path
          if (u8 && u8.byteLength) {
            const copy = new Uint8Array(u8.byteLength);
            copy.set(u8);
            session.chunks.push(copy);
            session.total += u8.byteLength;
            session.lastGrowth = Date.now();
            if (!session.firstAt) session.firstAt = Date.now();
          }
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
        if (session && obj instanceof Blob && obj.type && obj.type.startsWith('audio') && obj.size >= MIN_BYTES) {
          session.blob = obj;
          session.total = obj.size;
          session.lastGrowth = Date.now();
        }
      } catch (e) {}
      return orig.call(this, obj);
    };
  })();

  function startSession(clipId) {
    session = { clipId, chunks: [], total: 0, blob: null, firstAt: 0, lastGrowth: 0 };
  }
  function stopSession() {
    session = null;
  }

  // ---- MP4 helpers -----------------------------------------------------------
  // A fresh MP4 stream begins with an `ftyp` box: [size(4)] "ftyp". The first
  // appended chunk of a from-scratch stream therefore has "ftyp" at bytes 4-7.
  // If the player resumes an already-loaded track mid-file, the first chunk is
  // a bare `moof` fragment — detectable and handled by navigating fresh.
  const FTYPE = [102, 116, 121, 112]; // 'f' 't' 'y' 'p'
  function isFtypBox(u8) {
    return u8.length >= 8 && u8[4] === 102 && u8[5] === 116 && u8[6] === 121 && u8[7] === 112;
  }

  function concatChunks(captured) {
    const out = new Uint8Array(captured.total);
    let off = 0;
    for (const c of captured.chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  // If the player auto-advanced to the next track right after the target
  // ended, the next track's own ftyp box is appended after our data. Split at
  // the second ftyp box so we keep only the target file.
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

  /** Verify the assembled file is a sane fragmented MP4. Returns null or an error string. */
  function verifyMp4(bytes) {
    if (!isFtypBox(bytes)) return 'data does not start with an ftyp box';
    if (bytes.length < MIN_BYTES) return `file too small (${bytes.length} bytes)`;
    const u32 = (o) => bytes[o] * 16777216 + bytes[o + 1] * 65536 + bytes[o + 2] * 256 + bytes[o + 3];
    let o = 0;
    let sawMoov = false;
    let moofs = 0;
    while (o + 8 <= bytes.length) {
      const size = u32(o);
      const type = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]);
      if (size < 8) return `truncated box "${type}"`;
      if (type === 'moov') sawMoov = true;
      if (type === 'moof') moofs++;
      o += size;
    }
    if (o !== bytes.length) return 'box chain does not end cleanly';
    if (!sawMoov) return 'no moov box found';
    if (moofs < 2) return `too few fragments (${moofs})`;
    return null;
  }

  // ---- Player control ----------------------------------------------------------
  function boostPlayback() {
    const a = getMainAudio();
    if (!a) return;
    try {
      a.__srWasMuted = a.muted;
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

  // ---- Waiting ------------------------------------------------------------------
  /**
   * Wait until the first decrypted chunk arrives.
   * Returns 'fresh' (stream starts with ftyp), 'blob', or 'midfile'
   * (player resumed an already-loaded track — needs a fresh start).
   * Throws if no data arrives within the timeout.
   */
  async function waitForStreamStart(timeoutMs = NO_DATA_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (session.blob) return 'blob';
      if (session.chunks.length > 0) {
        return isFtypBox(session.chunks[0]) ? 'fresh' : 'midfile';
      }
      await sleep(250);
    }
    throw new Error('track did not start streaming');
  }

  function waitEndEvent() {
    return new Promise((resolve) => {
      const a = getMainAudio();
      if (!a) { resolve('no-audio'); return; }
      const onEnd = () => { cleanup(); resolve('ended'); };
      const cleanup = () => a.removeEventListener('ended', onEnd);
      a.addEventListener('ended', onEnd);
      // safety: if the source is swapped (auto-advance), 'ended' may not fire
      const iv = setInterval(() => {
        if (!session) { clearInterval(iv); cleanup(); resolve('session-ended'); }
      }, 1000);
    });
  }

  /** True if the captured bytes already contain a second file (auto-advance). */
  function hasSecondFile(captured) {
    if (captured.chunks.length < 2) return false;
    const bytes = concatChunks(captured);
    return splitAtSecondFtyp(bytes).length !== bytes.length;
  }

  /** Wait until a second ftyp box appears (auto-advance started a new track). */
  function waitSecondFtyp() {
    return new Promise((resolve) => {
      const iv = setInterval(() => {
        if (!session) { clearInterval(iv); resolve('session-ended'); return; }
        if (hasSecondFile(session)) {
          clearInterval(iv);
          resolve('advanced');
        }
      }, 300);
    });
  }

  /** Wait until the byte total stops growing (buffering finished). */
  async function waitForPlateau(plateauMs = 6000, timeoutMs = 60_000) {
    const start = Date.now();
    let lastTotal = 0;
    let lastChange = Date.now();
    while (Date.now() - start < timeoutMs) {
      await sleep(400);
      if (session.total > lastTotal) {
        lastTotal = session.total;
        lastChange = Date.now();
      }
      if (session.total >= MIN_BYTES && Date.now() - lastChange >= plateauMs) return true;
    }
    return false;
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
  // Deterministic state machine (NO reload loops — at most ONE navigation):
  //   1. If the target clip is already loaded in this document's player, a
  //      fresh MediaSource (stream from offset 0) requires a new document,
  //      so we navigate to the song page.
  //   2. Otherwise we click the row's play control in place; a never-loaded
  //      clip always starts a fresh stream from 0.
  //   3. After start, the first appended chunk must begin with ftyp. If not
  //      (unexpected mid-file resume), we navigate to the song page ONCE.
  //   4. We fast-forward (muted) until the track ends. If the player
  //      auto-advances to the next track, we split the capture at the next
  //      file's ftyp box.
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
    if (session) {
      setButtonState(btn, 'idle', 'Another archive is in progress — wait for it to finish');
      return;
    }
    if (getPending()) {
      setButtonState(btn, 'idle', 'An archive is already pending');
      return;
    }

    const title = row.getAttribute('aria-label') || clipId;
    const alreadyLoaded = playbarSongId() === clipId;
    const pending = {
      clipId,
      title,
      at: Date.now(),
      returnUrl: location.href,
      navigated: alreadyLoaded ? 1 : 0,
    };
    setPending(pending);
    setButtonState(btn, 'downloading', 'Starting capture…');
    console.log('[suno-archiver] pending', clipId, alreadyLoaded ? '(navigate fresh)' : '(in place)');

    if (alreadyLoaded) {
      setTimeout(() => (location.href = `/song/${clipId}`), 300);
      return; // resumePending runs after navigation
    }
    await runCapture(clipId, title, btn, row);
  }

  /** The actual capture; runs in the current document. */
  async function runCapture(clipId, title, btn, row) {
    const onSongPage = new RegExp(`/song/${clipId}$`, 'i').test(location.pathname);
    try {
      setButtonState(btn, 'downloading', 'Buffering + capturing (muted, fast-forward)…');
      startSession(clipId);

      // Start playback.
      if (onSongPage) {
        const pb = document.querySelector('[aria-label="Playbar: Play button"]');
        if (!pb) throw new Error('playbar play button not found on song page');
        pb.click();
      } else if (row) {
        // The row's artwork div is the play control; a plain row.click()
        // does NOT start playback.
        const play =
          row.querySelector('.clip-image-container[aria-label^="Play "]') ||
          row.querySelector('[aria-label^="Play "]');
        if (play) play.click();
        else row.click();
      } else {
        throw new Error('no way to start playback');
      }

      const kind = await waitForStreamStart();

      // Mid-file resume (unexpected): do the single fresh navigation.
      if (kind === 'midfile') {
        stopSession();
        resetPlayer();
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

      boostPlayback();

      // Wait for the target track to finish.
      const endReason = await Promise.race([
        waitEndEvent(),
        waitSecondFtyp(),
        (async () => {
          await waitForPlateau();
          return 'plateau';
        })(),
        (async () => {
          await sleep(MAX_WAIT_MS);
          return 'timeout';
        })(),
      ]);
      if (endReason === 'timeout') throw new Error('capture timed out — retry');

      await sleep(SETTLE_MS); // let final appends land
      const captured = session;
      stopSession();
      resetPlayer(); // don't leave the player fast-forwarding the next track

      let bytes;
      if (captured.blob) {
        bytes = new Uint8Array(await captured.blob.arrayBuffer());
      } else {
        bytes = concatChunks(captured);
        bytes = splitAtSecondFtyp(bytes);
      }

      const err = verifyMp4(bytes);
      if (err) throw new Error(`captured data invalid: ${err}`);

      const blob = new Blob([bytes], { type: 'audio/mp4' });
      const filename = `${sanitize(title)} (${clipId.slice(0, 8)}).${EXT}`;
      await deliverBlob(blob, filename);

      const archived = getArchived();
      archived[clipId] = { title, at: new Date().toISOString() };
      setArchived(archived);

      const returnUrl = getPending() && getPending().returnUrl;
      setPending(null);
      setButtonState(btn, 'archived', 'Archived — Shift+click to re-download');
      console.log(`[suno-archiver] archived ${title} (${clipId}), ${blob.size} bytes`);

      // If we navigated here, return the user to where they were.
      if (returnUrl && returnUrl !== location.href) {
        setTimeout(() => (location.href = returnUrl), 1500);
      }
    } catch (e) {
      stopSession();
      resetPlayer();
      setPending(null);
      if (btn) setButtonState(btn, 'idle', `Failed: ${e.message} — click to retry`);
      console.error('[suno-archiver]', e);
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
    await runCapture(clipId, title || clipId, null, null);
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
    resumePending();
    console.log('[suno-archiver] active v0.5.0');
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();