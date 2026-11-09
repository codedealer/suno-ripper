# suno-ripper

A Tampermonkey userscript that adds a per-track **archive button** to Suno library
rows, downloading your tracks locally as `.m4a`.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Create a new script and paste the contents of
   [`suno-clip-archiver.user.js`](./suno-clip-archiver.user.js)
   (or import the file directly).
3. Open https://suno.com (create/library page). Each completed clip row gets a
   small **⬇** button in its top-right corner.

## Usage

- **Click ⬇** — resolves the track's stream URL via Suno's library API and
  downloads it as `Title (abc12345).m4a`.
- **✓** — already archived (persisted in Tampermonkey storage across runs;
  never re-downloaded).
- **Shift+click** — force re-download.
- **Click after a failure** — retry.

## Notes

- No hardcoded CDN URLs: stream URLs come from Suno's own
  `POST /a/api/unified/library` response (`media_urls`), with a
  learned-pattern + HEAD-probe fallback for clips missing from the API map.
- The script borrows the session token from the app's own `fetch` calls
  (wrapped at `document-start`). If you ever see
  "Could not capture session token", play any track once and retry.
- One track per click by design (keeps automation footprint minimal).
- The official download API (`/a/api/download/clip/{id}`) is plan-gated and
  returns `not_authorized` on free accounts, hence the stream-URL route.

## Testing

`test/gm-shim.js` shims the Tampermonkey `GM_*` APIs on top of `fetch` +
`localStorage` for testing the script in a plain browser/eval context.