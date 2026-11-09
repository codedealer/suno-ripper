// srx-hooks.js — injectable instrumentation for Suno clip capture.
// Installs hooks: SourceBuffer.appendBuffer (decrypted audio), URL.createObjectURL
// (single-blob path), fetch + XHR (endpoint/token learning). Exposes window.__srx.
(() => {
  if (window.__srx && window.__srx.installed) return 'already installed';
  const S = window.__srx = {
    installed: true,
    ver: 1,
    log: [],           // {t, u, ...} network + blob events (capped)
    chunks: [],        // Uint8Array copies of decrypted audio for current epoch
    total: 0,
    appendCount: 0,
    lastAppendAt: 0,
    lastSig: null,     // first 4 bytes (as string) of last appended chunk
    firstSig: null,
    epoch: 0,          // increments on start()
    active: null,      // {label, at}
    blob: null,        // {url,size,type} if single-blob path used
    msEvents: [],      // MediaSource lifecycle events
  };

  const pushLog = (e) => {
    try {
      S.log.push(e);
      if (S.log.length > 500) S.log.splice(0, 250);
    } catch (err) {}
  };

  const asU8 = (d) => {
    if (d instanceof Uint8Array) return d;
    if (d instanceof ArrayBuffer) return new Uint8Array(d);
    if (d && d.buffer instanceof ArrayBuffer) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
    return null;
  };

  // --- Hook 1: SourceBuffer.appendBuffer — decrypted audio lands here -------
  const origAppend = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (data) {
    try {
      if (S.active) {
        const u8 = asU8(data);
        if (u8 && u8.byteLength) {
          const copy = new Uint8Array(u8.byteLength);
          copy.set(u8);
          S.chunks.push(copy);
          S.total += u8.byteLength;
          S.appendCount++;
          S.lastAppendAt = Date.now();
          const sig = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
          if (!S.firstSig) S.firstSig = sig;
          S.lastSig = sig;
        }
      }
    } catch (e) { pushLog({ t: 'appendhook-err', m: String(e && e.message) }); }
    return origAppend.call(this, data);
  };

  // --- Hook 2: MediaSource.addSourceBuffer — new track source detection ------
  const origASB = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (type) {
    try {
      pushLog({ t: 'ms-addSourceBuffer', type: String(type), ms: Date.now() });
      S.msEvents.push({ at: Date.now(), type: String(type) });
    } catch (e) {}
    return origASB.call(this, type);
  };

  // --- Hook 3: URL.createObjectURL — single-blob path ------------------------
  const origCOU = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    const url = origCOU.call(this, obj);
    try {
      if (obj instanceof Blob && obj.type && obj.type.startsWith('audio')) {
        pushLog({ t: 'bloburl', type: obj.type, size: obj.size, ms: Date.now() });
        if (S.active && obj.size >= 500_000) S.blob = { url, size: obj.size, type: obj.type, at: Date.now() };
      }
    } catch (e) {}
    return url;
  };

  // --- Hook 4: fetch — endpoint + auth learning ------------------------------
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || String(input);
      let auth = null;
      try {
        const h = (init && init.headers) || (input && typeof input === 'object' && input.headers);
        if (h) {
          if (h instanceof Headers) auth = h.get('authorization') || h.get('x-api-key');
          else auth = h['authorization'] || h['Authorization'] || h['x-api-key'];
        }
      } catch (e) {}
      pushLog({ t: 'fetch', u: url.slice(0, 240), auth: auth ? String(auth).slice(0, 90) : null, ms: Date.now() });
    } catch (e) {}
    return origFetch.apply(this, arguments);
  };

  // --- Hook 5: XHR — endpoint learning ---------------------------------------
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { pushLog({ t: 'xhr', m: String(method), u: String(url).slice(0, 240), ms: Date.now() }); } catch (e) {}
    return origOpen.apply(this, arguments);
  };

  // --- Control API -------------------------------------------------------------
  S.start = (label) => {
    S.epoch++;
    S.active = { label: String(label || 'capture'), at: Date.now() };
    S.chunks = []; S.total = 0; S.appendCount = 0;
    S.lastAppendAt = 0; S.lastSig = null; S.firstSig = null;
    S.blob = null;
    return 'started epoch ' + S.epoch;
  };
  S.stop = () => { S.active = null; return 'stopped'; };
  S.status = () => ({
    active: S.active ? S.active.label : null,
    epoch: S.epoch,
    total: S.total,
    appends: S.appendCount,
    firstSig: S.firstSig,
    lastSig: S.lastSig,
    lastAppendAgeMs: S.lastAppendAt ? Date.now() - S.lastAppendAt : null,
    blob: S.blob ? { size: S.blob.size, type: S.blob.type } : null,
  });
  S.audio = () => {
    const els = [...document.querySelectorAll('audio')];
    const a = els.find((x) => (x.currentSrc || '').startsWith('blob:')) || els[0];
    if (!a) return null;
    return {
      src: a.currentSrc,
      t: a.currentTime,
      dur: a.duration,
      paused: a.paused,
      rate: a.playbackRate,
      muted: a.muted,
      bufStart: a.buffered.length ? a.buffered.start(0) : null,
      bufEnd: a.buffered.length ? a.buffered.end(a.buffered.length - 1) : null,
    };
  };
  S.logTail = (n = 25) => S.log.slice(-n);

  console.log('[srx] hooks installed, epoch API ready');
  return 'installed';
})();