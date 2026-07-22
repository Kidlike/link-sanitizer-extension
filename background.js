// Background service worker: performs the cross-origin call to slashcopy.com.
// Content scripts can't reliably fetch cross-origin (page CSP/CORS), so the
// request is proxied here where host_permissions grant access (which also
// exempts the request from page CORS enforcement).

// Public, no-auth endpoint. Rate-limited to 100 requests/hour per IP.
// Docs: https://slashcopy.com/apidocs.html
const API_ENDPOINT = "https://slashcopy.com/api/url/clean/public";

// In-memory cache for the lifetime of the service worker. Maps the original
// URL to the cleaned URL so we never hit the API twice for the same link.
const cache = new Map();

// De-dupes concurrent requests for the same URL into a single fetch.
const inFlight = new Map();

async function cleanUrl(originalUrl) {
  if (cache.has(originalUrl)) {
    return cache.get(originalUrl);
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
      throw new Error(`slashcopy.com returned ${res.status}`);
    }

    const cleaned = await parseCleanedUrl(res, originalUrl);
    cache.set(originalUrl, cleaned);
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
