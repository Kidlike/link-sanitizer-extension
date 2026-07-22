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

  // If the extension was reloaded, updated, or removed, this now-stale content
  // script loses its connection and any chrome.runtime.* call throws
  // "Extension context invalidated". chrome.runtime.id goes undefined in that
  // state. Nothing works until the page is reloaded, so bail quietly.
  if (!chrome.runtime?.id) return;

  // Mark immediately so rapid re-hovers don't queue duplicate work.
  processed.add(anchor);

  try {
    chrome.runtime.sendMessage({ type: "CLEAN_URL", url: original }, (response) => {
      // The call failed (worker unavailable, non-200 from SlashCopy, rate
      // limit, etc.). Signal that the link was NOT sanitized so the user can
      // decide.
      if (chrome.runtime.lastError || !response?.ok) {
        const reason = chrome.runtime.lastError?.message || response?.error || "unknown error";
        console.warn("[Link Sanitizer] not cleaned:", original, "—", reason);
        flashResult(anchor, false);
        return;
      }

      // Success: the link is now safe to click. Swap the href only if it
      // actually changed; either way the glow tells the user the work is done.
      if (response.cleaned && response.cleaned !== original) {
        anchor.href = response.cleaned;
        anchor.dataset.linkSanitizerOriginal = original;
      }
      flashResult(anchor, true);
    });
  } catch {
    // Context invalidated in the gap between the guard and the send. Ignore —
    // a page reload re-injects a fresh content script.
  }
}

// Subtle confirmation that the work finished: a brief glow that fades out.
// Green means the link was checked and is safe to click; orange means the
// SlashCopy call failed and the link is unchanged. Uses the Web Animations API
// so nothing is left on the element afterwards (the animation doesn't persist)
// and it isn't blocked by page CSP the way an injected <style> or inline style
// attribute would be. box-shadow glows without affecting layout.
function flashResult(anchor, success) {
  const rgb = success ? "52, 199, 89" : "255, 149, 0";
  anchor.animate?.(
    [
      { boxShadow: `0 0 0 2px rgba(${rgb}, 0.7)` },
      { boxShadow: `0 0 0 2px rgba(${rgb}, 0)` },
    ],
    { duration: 700, easing: "ease-out" }
  );
}
