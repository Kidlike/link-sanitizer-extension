# Link Sanitizer

A Chromium-compatible (Manifest V3) browser extension that cleans links on
hover. When you rest the pointer on a link, the extension sends the URL to the
[SlashCopy URL-cleaning API](https://slashcopy.com/apidocs.html) and replaces
the link's `href` in the page with the cleaned version.

## How it works

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest; declares the content script, background worker, and host permission for `slashcopy.com`. |
| `content.js` | Runs on every page. Debounces hover, then asks the background worker to clean the hovered link and swaps its `href`. |
| `background.js` | Service worker. `POST`s `{ "url": ... }` to `https://slashcopy.com/api/url/clean/public`, reads `cleanedUrl` from the JSON response, caches results, and de-dupes concurrent requests. The cross-origin call lives here because content scripts are blocked by page CSP/CORS. |

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

## Tests

Unit tests run on Node's built-in test runner — no dependencies to install:

```
npm test          # or: node --test "test/*.test.js"
```

Each source file is loaded into a `vm` sandbox with mocked browser globals
(`chrome`, `fetch`, `document`, timers) so the real extension code is exercised
without being modified. Coverage includes response parsing, rate-limit/error
handling, in-flight de-duplication, the rolling-LRU cache (eviction, recency,
oversized entries, hydration), the hover debounce, and the green/orange feedback.

## Load it in Chrome / Edge / Brave

1. Go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Hover over links on any page to see them cleaned.

## Notes / TODO

- Uses SlashCopy's **public** endpoint, which is rate-limited to 100
  requests/hour per IP. For heavier use, switch to the authenticated
  `/api/url/clean` endpoint with a JWT bearer token.
- Cleaned URLs are cached in `chrome.storage.local` (keys prefixed `clean:`), so
  the cache survives service-worker restarts and extension reloads and we don't
  re-hit the API for links we've already seen. The cache is a rolling LRU bounded
  to ~4 MiB (`MAX_CACHE_BYTES`): when a new entry would exceed the budget, the
  oldest / least-recently-used entries are evicted until it fits. Cache hits
  refresh recency. To wipe it entirely, run `chrome.storage.local.clear()` in the
  service-worker console.
- Add an options page / toggle to enable per-site.
- Add an icon set and `action` popup if a UI is wanted.
