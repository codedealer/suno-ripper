# suno-ripper

A Tampermonkey userscript that adds a per-track **archive button** to Suno
library rows, capturing your tracks locally as playable `.m4a` files.

## How it works

Suno's official download API is plan-gated, and the stream URLs it serves are
encrypted/hashed. What the *player* actually decodes is different: Suno feeds
**decrypted Opus-in-MP4 (fragmented) bytes** into a `SourceBuffer` via
`appendBuffer()`, and the resulting `blob:` MediaSource is a complete,
standalone fragmented MP4.

The script therefore captures the exact bytes the player consumes:

1. It hooks `SourceBuffer.prototype.appendBuffer` (and falls back to
   `URL.createObjectURL`), collecting chunks per capture session.
2. Clicking **⬇** on a row starts playback of that track (muted, 4×
   fast-forward so it buffers in ~1 minute instead of ~3).
3. If the player would resume the track **mid-file**, the script performs its
   **one allowed navigation** to the track's own page
   (`suno.com/song/<clipId>`) to force a fresh stream from byte 0. It never
   navigates more than once per capture, so it cannot loop.
4. When the track ends (or the player auto-advances — the capture is then cut
   at the next file's `ftyp` box), the script assembles the bytes, validates
   the MP4 box structure, downloads `Title (clipid8).m4a`, and marks the clip
   archived. If it had navigated, it returns you to the page you were on.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Create a new script and paste the contents of
   [`suno-clip-archiver.user.js`](./suno-clip-archiver.user.js)
   (or import the file directly).
3. Open https://suno.com (create/library page). Each completed clip row gets a
   small **⬇** button in its top-right corner.

## Usage

- **Click ⬇** — archives the track. The player briefly plays it muted at 4×;
  the file lands in your normal downloads folder (see *Local receiver* below
  for sandboxed browsers).
- **✓** — already archived (persisted in Tampermonkey storage across runs;
  never re-downloaded).
- **Shift+click** — force re-download.
- **Click after a failure** — retry. The button shows the failure reason in
  its tooltip.

## Notes

- Scope: your own library rows only — one track per click, by design.
- The captured file is the same byte stream the browser decodes: fragmented
  MP4 (`ftyp` + `moov` + `moof`/`mdat` pairs) with an Opus audio track.
  Playable by anything that handles fragmented MP4 (VLC, ffprobe, most
  modern players).
- Capture is validated before saving: a fresh capture must start with `ftyp`,
  contain `moov`, balanced top-level boxes, and ≥10 `moof` fragments.
  Auto-advance contamination is stripped at the second `ftyp`.
- A pending capture survives one page navigation (e.g. the script's own
  fresh-start navigation, or you reloading the page). If the player keeps
  resuming mid-file after the single navigation, the script gives up with a
  clear error instead of looping.
- If you ever see "track did not start streaming", the player didn't start
  the track — click the row once to play it normally, then retry ⬇.

## Local receiver (sandboxed browsers)

Some embedded/sandboxed browsers (e.g. Orca's) block in-page anchor
downloads. The script works around this: before falling back to the anchor,
it tries a tiny local HTTP receiver on `http://127.0.0.1:8765/save`
(percent-encoded `X-Filename` header, CORS-enabled). If one is running, the
file is saved there (to `.orca/browser-downloads/` by default) and the anchor
is skipped.

Run it with:

```bash
python3 inject/receiver.py   # persists; Ctrl-C or kill $(cat inject/receiver.pid)
```

Normal browser installs (Tampermonkey) don't need it — the anchor fallback
is used automatically.

## Testing

`test/gm-shim.js` shims the Tampermonkey `GM_*` APIs on top of `fetch` +
`localStorage`, so the script can be injected into a plain browser tab for
testing (it won't auto-reload across navigations — re-inject after any
navigation you trigger).