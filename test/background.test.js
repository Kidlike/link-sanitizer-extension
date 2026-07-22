// Unit tests for background.js (service worker): response parsing, the SlashCopy
// call, error/rate-limit handling, in-flight de-duplication, and the persistent
// rolling-LRU cache.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  loadSource,
  makeConsole,
  makeStorage,
  jsonResponse,
} = require("./helpers");

// Build a fresh sandboxed background.js with mocked chrome/fetch. `fetchImpl`
// receives (url, init, callIndex) and returns a Response-like. Storage can be
// pre-seeded, and the cache budget can be shrunk to force eviction.
function setup({ storage = {}, fetchImpl, maxCacheBytes } = {}) {
  const store = makeStorage(storage);
  const consoleMock = makeConsole();
  const calls = [];
  let messageListener;

  const chrome = {
    storage: store,
    runtime: { onMessage: { addListener: (fn) => (messageListener = fn) } },
  };
  const fetchMock = async (url, init) => {
    calls.push({ url, init });
    return fetchImpl(url, init, calls.length);
  };

  const context = { chrome, console: consoleMock, fetch: fetchMock, TextEncoder, URL };
  if (maxCacheBytes != null) context.LINK_SANITIZER_MAX_CACHE_BYTES = maxCacheBytes;

  const api = loadSource("background.js", context, [
    "cleanUrl", "parseCleanedUrl", "isValidUrl", "addToCache",
    "entryBytes", "cache", "ready", "STORAGE_PREFIX",
  ]);

  return { api, store, consoleMock, calls, getListener: () => messageListener };
}

const OK = (cleanedUrl) => () => jsonResponse({ cleanedUrl });

test("isValidUrl accepts absolute URLs and rejects junk", () => {
  const { api } = setup({ fetchImpl: OK("x") });
  assert.equal(api.isValidUrl("https://example.com/a?b=1"), true);
  assert.equal(api.isValidUrl("http://x"), true);
  assert.equal(api.isValidUrl("example.com"), false); // no scheme
  assert.equal(api.isValidUrl("not a url"), false);
});

test("parseCleanedUrl extracts cleanedUrl, else falls back", async () => {
  const { api } = setup({ fetchImpl: OK("x") });
  const fb = "https://original";

  assert.equal(
    await api.parseCleanedUrl(jsonResponse({ cleanedUrl: "https://clean" }), fb),
    "https://clean"
  );
  // Missing field -> fallback.
  assert.equal(await api.parseCleanedUrl(jsonResponse({ nope: 1 }), fb), fb);
  // Present but not a valid URL -> fallback.
  assert.equal(await api.parseCleanedUrl(jsonResponse({ cleanedUrl: "??" }), fb), fb);
  // Non-JSON body -> fallback (json() rejects, caught).
  assert.equal(
    await api.parseCleanedUrl({ async json() { throw new Error("bad"); } }, fb),
    fb
  );
});

test("cleanUrl returns the cleaned URL, caches it, and persists it", async () => {
  const url = "https://site.com/p?utm_source=x";
  const { api, store, calls } = setup({ fetchImpl: OK("https://site.com/p") });
  await api.ready;

  assert.equal(await api.cleanUrl(url), "https://site.com/p");
  assert.equal(calls.length, 1);
  // POST with a JSON body carrying the original URL.
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { url });
  // Persisted under the namespaced key.
  assert.equal(store.store["clean:" + url], "https://site.com/p");

  // Second call is served from cache — no second fetch.
  assert.equal(await api.cleanUrl(url), "https://site.com/p");
  assert.equal(calls.length, 1);
});

test("cleanUrl rejects on 429 and does not cache the failure", async () => {
  const url = "https://a.com";
  const { api, store, calls } = setup({
    fetchImpl: () => jsonResponse({ error: "Rate limit exceeded" }, { ok: false, status: 429 }),
  });
  await api.ready;

  await assert.rejects(() => api.cleanUrl(url), /rate limited/i);
  assert.equal(api.cache.has(url), false);
  assert.equal(store.store["clean:" + url], undefined);
  // A retry still hits the network (nothing was cached).
  await assert.rejects(() => api.cleanUrl(url), /rate limited/i);
  assert.equal(calls.length, 2);
});

test("cleanUrl surfaces other HTTP errors with the status", async () => {
  const { api } = setup({
    fetchImpl: () => jsonResponse({}, { ok: false, status: 500 }),
  });
  await api.ready;
  await assert.rejects(() => api.cleanUrl("https://a.com"), /HTTP 500/);
});

test("concurrent cleanUrl calls for the same URL share one fetch", async () => {
  const { api, calls } = setup({
    fetchImpl: () => new Promise((r) => setImmediate(() => r(jsonResponse({ cleanedUrl: "https://c" })))),
  });
  await api.ready;

  const [a, b] = await Promise.all([api.cleanUrl("https://u"), api.cleanUrl("https://u")]);
  assert.equal(a, "https://c");
  assert.equal(b, "https://c");
  assert.equal(calls.length, 1); // de-duped
});

test("cache hydrates from storage on startup", async () => {
  const { api, calls } = setup({
    storage: { "clean:https://a": "https://a/clean", "unrelated": "keep" },
    fetchImpl: OK("should-not-be-called"),
  });
  await api.ready;

  assert.equal(api.cache.get("https://a"), "https://a/clean");
  // Served from the hydrated cache, no fetch.
  assert.equal(await api.cleanUrl("https://a"), "https://a/clean");
  assert.equal(calls.length, 0);
});

// --- Rolling-LRU eviction (tiny budget so small entries trigger it) ---

// Pad `cleaned` so an entry occupies exactly `total` bytes: key + value.
function sized(api, key, total) {
  const overhead = api.entryBytes(key, "");
  return "x".repeat(total - overhead);
}

test("addToCache evicts the oldest entries until the newcomer fits", async () => {
  const { api, store } = setup({ fetchImpl: OK("x"), maxCacheBytes: 250 });
  await api.ready;

  const v = (k) => sized(api, k, 100); // each entry is exactly 100 bytes
  api.addToCache("A", v("A"));
  api.addToCache("B", v("B"));
  api.addToCache("C", v("C")); // 300 > 250 -> evict oldest (A)

  assert.deepEqual([...api.cache.keys()], ["B", "C"]);
  assert.equal(store.store["clean:A"], undefined); // removed from storage too
  assert.ok(store.store["clean:B"]);
  assert.ok(store.store["clean:C"]);
});

test("a cache hit refreshes recency so it survives the next eviction", async () => {
  const { api } = setup({ fetchImpl: OK("x"), maxCacheBytes: 250 });
  await api.ready;

  const v = (k) => sized(api, k, 100);
  api.addToCache("A", v("A"));
  api.addToCache("B", v("B"));

  // Touch A via cleanUrl's hit path -> moves A to newest.
  await api.cleanUrl("A");

  api.addToCache("C", v("C")); // evicts the now-oldest, which is B
  assert.equal(api.cache.has("A"), true);
  assert.equal(api.cache.has("B"), false);
  assert.equal(api.cache.has("C"), true);
});

test("an entry larger than the whole budget is not cached and evicts nothing", async () => {
  const { api, consoleMock } = setup({ fetchImpl: OK("x"), maxCacheBytes: 250 });
  await api.ready;

  api.addToCache("A", sized(api, "A", 100));
  api.addToCache("HUGE", sized(api, "HUGE", 300)); // > 250

  assert.equal(api.cache.has("HUGE"), false);
  assert.deepEqual([...api.cache.keys()], ["A"]); // untouched
  assert.ok(consoleMock.find("oversized"));
});

// --- Message listener ---

test("onMessage handles CLEAN_URL and ignores everything else", async () => {
  const { api, getListener } = setup({ fetchImpl: OK("https://a/clean") });
  await api.ready;
  const listener = getListener();

  const result = await new Promise((resolve) => {
    const keptOpen = listener({ type: "CLEAN_URL", url: "https://a" }, {}, resolve);
    assert.equal(keptOpen, true); // async channel stays open
  });
  assert.equal(result.ok, true);
  assert.equal(result.cleaned, "https://a/clean");

  // Wrong type / bad payload -> not handled.
  assert.equal(listener({ type: "OTHER" }, {}, () => {}), false);
  assert.equal(listener({ type: "CLEAN_URL", url: 42 }, {}, () => {}), false);
});

test("onMessage reports failures as { ok: false }", async () => {
  const { api, getListener } = setup({
    fetchImpl: () => jsonResponse({}, { ok: false, status: 429 }),
  });
  await api.ready;

  const result = await new Promise((resolve) => {
    getListener()({ type: "CLEAN_URL", url: "https://a" }, {}, resolve);
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /rate limited/i);
});
