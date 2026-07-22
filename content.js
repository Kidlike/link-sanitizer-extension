// Content script: watches for links under the pointer, asks the background
// worker to clean them, and swaps the href in place.

const HOVER_DELAY_MS = 200;

// Tracks links we've already processed so we don't re-clean on every hover.
const processed = new WeakSet();

let hoverTimer = null;

document.addEventListener(
  "mouseover",
  (event) => {
    const anchor = event.target.closest?.("a[href]");
    if (!anchor || processed.has(anchor)) return;

    // Debounce: only act if the pointer lingers on the link.
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => handleLink(anchor), HOVER_DELAY_MS);
  },
  true
);

function handleLink(anchor) {
  const original = anchor.href;
  if (!original || !/^https?:/i.test(original)) return;

  // Mark immediately so rapid re-hovers don't queue duplicate work.
  processed.add(anchor);

  chrome.runtime.sendMessage({ type: "CLEAN_URL", url: original }, (response) => {
    if (chrome.runtime.lastError) {
      // Service worker unavailable, etc. Leave the link untouched.
      return;
    }
    if (!response?.ok || !response.cleaned) return;
    if (response.cleaned === original) return;

    anchor.href = response.cleaned;
    anchor.dataset.linkSanitizerOriginal = original;
  });
}
