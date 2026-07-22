<img align="left" width="48" height="48" src="https://raw.githubusercontent.com/Kidlike/link-sanitizer-extension/refs/heads/master/icons/link-sanitizer-icon-48.png" alt="Link Sanitizer 48px icon">

# Link Sanitizer

A Chromium-compatible (Manifest V3) browser extension that cleans links on
hover. When you rest the pointer on a link, the extension sends the URL to the
[SlashCopy URL-cleaning API](https://slashcopy.com/apidocs.html) and replaces
the link's `href` in the page with the cleaned version.

> [!NOTE]
> 100% Vibe-coded with Claude Opus 4.8


[link-sanitizer-demo.webm](https://github.com/user-attachments/assets/d388fafd-27eb-4be6-8008-8a3a9e056453)


## How it works

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest; declares the content script, background worker, and host permission for `slashcopy.com`. |
| `content.js` | Runs on every page. Debounces hover, then asks the background worker to clean the hovered link and swaps its `href`. |
| `background.js` | Service worker. `POST`s `{ "url": ... }` to `https://slashcopy.com/api/url/clean/public`, reads `cleanedUrl` from the JSON response, caches results, and de-dupes concurrent requests. The cross-origin call lives here because content scripts are blocked by page CSP/CORS. |
| `options.html` / `options.js` | Settings panel (the extension's options page). Edits the hover delay and the per-site disable list. |

The original URL is preserved on the element as `data-link-sanitizer-original`.

Links pointing to the current site (the same host, or a subdomain of it) are
skipped — there's nothing to clean on internal navigation, and it avoids
needless API calls. See `isSameSite` in `content.js`.

### Hover feedback

The content script glows a box-shadow around the link (Web Animations API, so it
works under strict page CSP, self-cleans, and never reflows the page):

| State | Glow |
| --- | --- |
| Analyzing | Off-white, pulsing in/out on a loop until the result arrives. |
| Cleaned (safe to click) | Brief green glow. |
| Failed (e.g. rate-limited; link unchanged) | Brief orange glow. |

## Settings

Open the options page — right-click the extension and choose **Options**, or go
to `chrome://extensions`, open the extension's **Details**, and click
**Extension options**. Two settings are available:

- **Hover delay (ms):** how long the pointer must rest on a link before it's
  cleaned (default `200`). Clearing the field restores the default.
- **Disabled on these sites:** one host per line. On these sites — and their
  subdomains — the extension does nothing at all and never touches links.
  Entering `kagi.com` also covers `www.kagi.com`, `search.kagi.com`, etc. This
  matches on the **page** you're browsing, not on where a link points.

Settings live in `chrome.storage.local` under the `settings` key and apply to
open pages immediately (via `chrome.storage.onChanged`) — no reload needed.

## Tests

Unit tests run on Node's built-in test runner — no dependencies to install:

```
npm test          # or: node --test "test/*.test.js"
```

Each source file is loaded into a `vm` sandbox with mocked browser globals
(`chrome`, `fetch`, `document`, timers) so the real extension code is exercised
without being modified. Coverage includes response parsing, rate-limit/error
handling, in-flight de-duplication, the rolling-LRU cache (eviction, recency,
oversized entries, hydration), the hover debounce, the green/orange feedback,
the configurable hover delay and per-site disable list, and the options-page
input normalization.

## Load it in Chrome / Edge / Brave

1. Go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Hover over links on any page to see them cleaned.

## Notes / TODO

- This is a PoC and uses SlashCopy's **public** API. Should be replaced with self-hosted API.
