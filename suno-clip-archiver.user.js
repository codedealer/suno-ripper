// ==UserScript==
// @name         Suno Clip Archiver
// @namespace    https://suno.com/
// @version      0.2.0
// @description  Adds a per-track archive button to Suno library rows, downloading the audio locally. Resolves stream URLs via Suno's own library API (no hardcoded CDN). Remembers archived tracks between runs; Shift+click forces re-download.
// @author       you
// @match        https://suno.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // ---- Config -------------------------------------------------------------
  const API_BASE = 'https://suno.com/a/api';
  const PAGE_SIZE = 100; // clips per library API page
  const PAGE_DELAY_MS = 1500; // politeness delay between pages / downloads
  const ARCHIVED_KEY = 'sunoripper.archivedClips'; // GM storage: clipId -> {title, at, url}
  const EXT = 'm4a';
  // --------------------------------------------------------------------------

  const BTN_ATTR = 'data-sunoripper-btn';

  // ---- Storage -------------------------------------------------------------
  function getArchived() {
    const v = GM_getValue(ARCHIVED_KEY, null);
    return v && typeof v === 'object' ? v : {};
  }
  function setArchived(map) {
    GM_setValue(ARCHIVED_KEY, map);
  }

  // ---- Auth token capture ---------------------------------------------------
  // The page keeps its JWT in memory only. We borrow the `authorization`
  // header from the app's own periodic API calls (they fire on load, on
  // navigation, and whenever you play a track).
  const captured = { headers: null, waiters: [] };

  (function hookFetch() {
    const of = window.fetch;
    window.fetch = function (...args) {
      try {
        const input = args[0];
        const init = args[1] || {};
        const h = new Headers(init.headers || (input && input.headers) || {});
        const a = h.get('authorization');
        if (a && a.startsWith('Bearer ')) {
          captured.headers = {
            authorization: a,
            'browser-token': h.get('browser-token') || '',
            'device-id': h.get('device-id') || '',
            at: Date.now(),
          };
          captured.waiters.splice(0).forEach((w) => w());
        }
      } catch (e) {
        /* never break the page */
      }
      return of.apply(this, args);
    };
  })();

  function waitForToken(timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      if (captured.headers) return resolve(captured.headers);
      const t = setTimeout(() => {
        captured.waiters.splice(0);
        reject(new Error('Could not capture session token. Interact with the page (e.g. play a track) and retry.'));
      }, timeoutMs);
      captured.waiters.push(() => {
        clearTimeout(t);
        resolve(captured.headers);
      });
    });
  }

  async function api(path, headers, body) {
    const res = await fetch(API_BASE + path, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...headers,
      },
      body: JSON.stringify(body || {}),
    });
    if (res.status === 401) throw new Error('Session expired — refresh the page and retry.');
    if (!res.ok) throw new Error(`API ${res.status} for ${path}`);
    return res.json();
  }

  // ---- Media URL resolution --------------------------------------------------
  // Primary: Suno's library API returns `media_urls` with the real stream URL
  // for every clip (https://<dist>.cloudfront.net/<ws>/clip/<id>.m4a).
  // Fallback: derive from the row's artwork image (image_<clipId>.jpeg) using
  // a CDN host/prefix learned from any API-provided URL we have seen.
  const clipUrls = new Map(); // clipId -> { url, title }
  let libLoad = null;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function loadLibrary(headers) {
    if (libLoad) return libLoad;
    libLoad = (async () => {
      let page = 1;
      for (;;) {
        const data = await api('/unified/library', headers, { page, size: PAGE_SIZE });
        for (const feed of data.feeds || []) {
          for (const item of feed.items || []) {
            const c = item.content_item;
            if (!c || c.entity_type !== 'song_schema' || !c.id) continue;
            const m = (c.media_urls || []).find((x) => /m4a|mp3/i.test(x.url || x.content_type || ''));
            if (m && m.url && !clipUrls.has(c.id)) {
              clipUrls.set(c.id, { url: m.url, title: c.title });
            }
          }
        }
        const total = (data.feeds || []).reduce((n, f) => n + (f.item_count || 0), 0);
        if (page * PAGE_SIZE >= total || !data.feeds) break;
        page++;
        await sleep(PAGE_DELAY_MS);
      }
      console.log(`[suno-archiver] library map: ${clipUrls.size} clips`);
    })();
    libLoad.catch(() => (libLoad = null)); // allow retry after failure
    return libLoad;
  }

  function clipIdFromRow(row) {
    const img = row.querySelector('img');
    if (!img || !img.src) return null;
    const m = img.src.match(/image_([0-9a-f-]{36})/i);
    return m ? m[1] : null;
  }

  function learnedPattern() {
    // e.g. "https://d2lwuy8qc234o3.cloudfront.net/1" from any known stream URL
    for (const { url } of clipUrls.values()) {
      const m = url.match(/^(https:\/\/[^/]+\/[^/]+)\/clip\/[0-9a-f-]{36}\./i);
      if (m) return m[1];
    }
    return null;
  }

  async function resolveMediaUrl(row, headers) {
    const clipId = clipIdFromRow(row);
    if (!clipId) throw new Error('No clip id found in row artwork');

    if (clipUrls.has(clipId)) return clipUrls.get(clipId);

    await loadLibrary(headers);
    if (clipUrls.has(clipId)) return clipUrls.get(clipId);

    const prefix = learnedPattern();
    if (prefix) {
      const url = `${prefix}/clip/${clipId}.${EXT}`;
      const probe = await probeUrl(url);
      if (probe) return { url, title: row.getAttribute('aria-label') };
    }
    throw new Error('Track not found in library API — play it once, then retry');
  }

  function probeUrl(url) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'HEAD',
        url,
        timeout: 15000,
        onload: (res) => resolve(res.status === 200),
        onerror: () => resolve(false),
        ontimeout: () => resolve(false),
      });
    });
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

  function fetchMedia(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        binary: true,
        binaryCharset: 'utf-8',
        timeout: 180000,
        onload: (res) => {
          if (res.status === 200 && res.response) {
            const bytes = Uint8Array.from(atob(res.response), (c) => c.charCodeAt(0));
            resolve(new Blob([bytes], { type: 'audio/mp4' }));
          } else {
            reject(new Error(`Download failed (HTTP ${res.status})`));
          }
        },
        onerror: (res) => reject(new Error(`Network error (status=${res.status})`)),
        ontimeout: () => reject(new Error('Download timed out')),
      });
    });
  }

  // ---- UI ----------------------------------------------------------------------
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
    btn.addEventListener('click', (e) => handleArchive(row, btn, e.shiftKey));
    return btn;
  }

  function setButtonState(btn, state, tip) {
    btn.textContent = state === 'archived' ? '✓' : state === 'downloading' ? '⋯' : '⬇';
    btn.style.color = state === 'archived' ? '#4ade80' : '#9ca3af';
    btn.disabled = state === 'downloading';
    if (tip) btn.title = tip;
  }

  async function handleArchive(row, btn, force) {
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

    try {
      setButtonState(btn, 'downloading', 'Resolving + downloading…');
      const headers = await waitForToken();
      const { url, title } = await resolveMediaUrl(row, headers);
      const blob = await fetchMedia(url);
      downloadBlob(blob, `${sanitize(title)} (${clipId.slice(0, 8)}).${EXT}`);
      archived[clipId] = { title, at: new Date().toISOString(), url };
      setArchived(archived);
      setButtonState(btn, 'archived', 'Archived — Shift+click to re-download');
      console.log(`[suno-archiver] archived ${title} (${clipId})`);
    } catch (err) {
      setButtonState(btn, 'idle', `Failed: ${err.message} — click to retry`);
      console.error('[suno-archiver]', err);
    }
  }

  function decorate(row) {
    if (row.hasAttribute(BTN_ATTR) || row.querySelector(`[${BTN_ATTR}]`)) return;
    if (row.getAttribute('data-clip-status') !== 'complete') return;
    const clipId = clipIdFromRow(row);
    if (!clipId) return;

    const btn = makeButton(row);
    const archived = getArchived();
    if (archived[clipId]) {
      setButtonState(btn, 'archived', 'Archived — Shift+click to re-download');
    } else {
      setButtonState(btn, 'idle', 'Archive this track locally (Shift+click to force re-download)');
    }
    row.style.position = 'relative';
    row.appendChild(btn);
  }

  function scan() {
    document.querySelectorAll('[data-testid="clip-row"]').forEach(decorate);
  }

  const observer = new MutationObserver(scan);
  function start() {
    observer.observe(document.body, { childList: true, subtree: true });
    scan();
    console.log('[suno-archiver] active');
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();