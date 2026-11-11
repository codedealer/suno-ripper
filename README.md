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

1. From document start it hooks `SourceBuffer.prototype.appendBuffer`,
 recording **all** decrypted appends and splitting the stream into complete
 files at `ftyp` box boundaries (a new Suno stream always begins with
 `ftyp`). Recent complete files are kept in memory (LRU, \~3 × 24 MB max),
 so a track that is already loaded in the player is already half-captured.
2. Clicking **⬇** on a row archives that track **in place** — no matter which
 page you are on (create, library, …):
   - If the track is already buffered (playing, paused, or previously played),
    the recorded prefix is reused and the player just finishes buffering the
    rest — **muted, 4× fast-forward, no navigation at all**.
   - If the track is already *fully* buffered (played to the end), the file is
   saved **instantly** with no playback.
   - Only when the recorder has no bytes for the track at all (e.g. it was
   loaded before the script was installed) does the script perform its one
   allowed navigation to the track's own page (`suno.com/song/<clipId>`)
   for a fresh stream from byte 0. It never navigates more than once per
   capture, so it cannot loop.
3. When the track ends, the script stops the player immediately, assembles
 the bytes, validates the MP4 box structure and the fragment-time
 continuity (`tfdt` base times must run without gaps), saves
 `Title (clipid8).m4a`, and marks the clip archived. If it had navigated,
 it returns you to the page you were on.
4. If the player had dropped its MediaSource and re-streamed from the
 playhead (stale prefix detected by the continuity check), the script
 performs the one fresh navigation and re-captures cleanly.

## Ethical considerations

This tool is intended for backing up the personal audio library. It cannot be used for site-wide parsing, content distillation or for commercial purposes.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Create a new script and paste the contents of
 [`suno-clip-archiver.user.js`](./suno-clip-archiver.user.js)
 (or import the file directly).
3. Open [https://suno.com](https://suno.com) (create/library page). Each completed clip row gets a
 small **⬇** button in its top-right corner.

## Usage

- **Click ⬇** — archives the track in place. If it isn't fully buffered yet,
the player briefly finishes it muted at 4× (no page changes); if it already
is, the file is saved instantly. The file lands in your normal downloads
folder (see *Local receiver* below for sandboxed browsers).
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
- Capture is validated before saving: the file must start with `ftyp`,
contain `moov`, have balanced top-level boxes, ≥10 `moof` fragments, and a
gap-free `tfdt` fragment timeline (catches stale prefixes from a
re-streamed MediaSource).
- When a capture ends, the player is stopped immediately. Suno's auto-advance
often starts the *next* track ~1s later — the script watches for that and
pauses it. If you were already listening to another track while archiving a
finished one, that playback is left alone.
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