// Background service worker: performs the cross-origin call to slashcopy.com.
// Content scripts can't reliably fetch cross-origin (page CSP/CORS), so the
// request is proxied here where host_permissions grant access (which also
// exempts the request from page CORS enforcement).

// Public, no-auth endpoint. Rate-limited to 100 requests/hour per IP.
// Docs: https://slashcopy.com/apidocs.html
const API_ENDPOINT = "https://slashcopy.com/api/url/clean/public";

// In-memory cache: original URL -> cleaned URL, so we never hit the API twice
// for the same link. Backed by chrome.storage.local (see below) so it survives
// service-worker restarts AND extension reloads — critical for staying under
// the API's 100 requests/hour rate limit while developing.
//
// The Map doubles as the recency order: JS Maps iterate in insertion order, so
// the FIRST key is the oldest / least-recently-used. Cache hits re-insert their
// key to move it to the back, making this a rolling LRU. When a new entry would
// push the estimated footprint past MAX_CACHE_BYTES, the oldest entries are
// evicted (from the front) until it fits.
const cache = new Map();

// De-dupes concurrent requests for the same URL into a single fetch.
const inFlight = new Map();

// Storage keys are namespaced so we can hydrate only our entries and never
// collide with other stored settings.
const STORAGE_PREFIX = "clean:";

// Byte budget for the whole cache. ~4 MiB leaves headroom under
// chrome.storage.local's ~5 MiB quota so writes don't start failing.
// Overridable via a global so the unit tests can force eviction cheaply; in the
// extension this global is undefined and the default applies.
const MAX_CACHE_BYTES = globalThis.LINK_SANITIZER_MAX_CACHE_BYTES ?? 4 * 1024 * 1024;

const encoder = new TextEncoder();

// Running estimate of the persisted footprint, kept in sync with `cache`.
let cacheBytes = 0;

// Estimated bytes one entry occupies in storage: namespaced key + value, UTF-8.
// An estimate is fine — the budget's headroom absorbs the JSON framing we omit.
function entryBytes(originalUrl, cleaned) {
  return (
    encoder.encode(STORAGE_PREFIX + originalUrl).length + encoder.encode(cleaned).length
  );
}

// Evict least-recently-used entries (front of the Map) until `incomingSize`
// more bytes would fit within the budget. Removes evicted keys from storage.
function evictToFit(incomingSize) {
  const evictedKeys = [];
  for (const key of cache.keys()) {
    if (cacheBytes + incomingSize <= MAX_CACHE_BYTES) break;
    cacheBytes -= entryBytes(key, cache.get(key));
    cache.delete(key);
    evictedKeys.push(STORAGE_PREFIX + key);
  }
  if (evictedKeys.length) {
    chrome.storage.local
      .remove(evictedKeys)
      .catch((error) => console.warn("[Link Sanitizer] failed to evict:", String(error)));
    console.debug(
      "[Link Sanitizer]",
      `evicted ${evictedKeys.length} entr${evictedKeys.length === 1 ? "y" : "ies"}, ~${cacheBytes} bytes in cache`
    );
  }
}

// Insert (or refresh) an entry, evicting the oldest as needed, and persist it.
// We only ever call this for successful cleans, so errors never poison the cache.
function addToCache(originalUrl, cleaned) {
  const size = entryBytes(originalUrl, cleaned);
  if (size > MAX_CACHE_BYTES) {
    // Bigger than the whole budget — evicting everything still wouldn't help.
    // Hand the value back to the caller but don't store it.
    console.warn("[Link Sanitizer]", `not caching oversized entry (~${size} bytes): ${originalUrl}`);
    return;
  }

  // Replacing an existing entry: reclaim its old footprint first.
  if (cache.has(originalUrl)) {
    cacheBytes -= entryBytes(originalUrl, cache.get(originalUrl));
    cache.delete(originalUrl);
  }

  evictToFit(size);

  cache.set(originalUrl, cleaned);
  cacheBytes += size;

  chrome.storage.local
    .set({ [STORAGE_PREFIX + originalUrl]: cleaned })
    .catch((error) => console.warn("[Link Sanitizer] failed to persist cache:", String(error)));
}

// Hydrate the in-memory Map from persistent storage once at startup. The
// service worker re-runs this file every time it wakes, so this repopulates the
// cache after it was torn down. cleanUrl() awaits `ready` before reading the
// cache to avoid a race where an early message misses hydrated entries.
const ready = (async () => {
  try {
    const stored = await chrome.storage.local.get(null);
    for (const [key, value] of Object.entries(stored)) {
      if (key.startsWith(STORAGE_PREFIX) && typeof value === "string") {
        const originalUrl = key.slice(STORAGE_PREFIX.length);
        cache.set(originalUrl, value);
        cacheBytes += entryBytes(originalUrl, value);
      }
    }
    // A previous run (or an older, larger budget) may have left us over-budget.
    evictToFit(0);
    console.debug("[Link Sanitizer]", `hydrated ${cache.size} link(s), ~${cacheBytes} bytes`);
  } catch (error) {
    console.warn("[Link Sanitizer] failed to load cache:", String(error));
  }
})();

async function cleanUrl(originalUrl) {
  await ready;
  if (cache.has(originalUrl)) {
    // Refresh recency: delete + re-insert moves this key to the back (newest),
    // so frequently-hovered links resist eviction. Footprint is unchanged, so
    // no storage write is needed.
    const cleaned = cache.get(originalUrl);
    cache.delete(originalUrl);
    cache.set(originalUrl, cleaned);
    return cleaned;
  }
  if (inFlight.has(originalUrl)) {
    return inFlight.get(originalUrl);
  }

  const promise = (async () => {
    const res = await fetch(API_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ url: originalUrl }),
    });
    if (!res.ok) {
      // Include the response body so 429s (rate limit) and other errors are
      // legible in the service-worker console.
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      const message =
        res.status === 429
          ? `rate limited (100 requests/hour per IP): ${detail}`
          : `HTTP ${res.status}: ${detail}`;
      console.warn("[Link Sanitizer]", `cleanUrl failed for ${originalUrl} — ${message}`);
      throw new Error(message);
    }

    const cleaned = await parseCleanedUrl(res, originalUrl);
    console.debug("[Link Sanitizer]", `${originalUrl} -> ${cleaned}`);
    addToCache(originalUrl, cleaned);
    return cleaned;
  })();

  inFlight.set(originalUrl, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(originalUrl);
  }
}

// SlashCopy responds with JSON: { cleanedUrl, contentVerified,
// similarityPercentage, remainingRequests }. We only need cleanedUrl; fall
// back to the original if it's missing or not a usable URL.
async function parseCleanedUrl(res, fallback) {
  const data = await res.json().catch(() => null);
  const value = data?.cleanedUrl;
  return typeof value === "string" && isValidUrl(value) ? value : fallback;
}

function isValidUrl(value) {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "CLEAN_URL" || typeof message.url !== "string") {
    return false;
  }

  cleanUrl(message.url)
    .then((cleaned) => sendResponse({ ok: true, cleaned }))
    .catch((error) => sendResponse({ ok: false, error: String(error) }));

  // Keep the message channel open for the async response.
  return true;
});
