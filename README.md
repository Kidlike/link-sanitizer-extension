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

## Load it in Chrome / Edge / Brave

1. Go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Hover over links on any page to see them cleaned.

## Notes / TODO

- Uses SlashCopy's **public** endpoint, which is rate-limited to 100
  requests/hour per IP. For heavier use, switch to the authenticated
  `/api/url/clean` endpoint with a JWT bearer token.
- Add an options page / toggle to enable per-site.
- Consider persisting the cache via `chrome.storage` (permission already
  declared) so it survives service-worker restarts.
- Add an icon set and `action` popup if a UI is wanted.
