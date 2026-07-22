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

  // Pulse an off-white glow while the worker analyzes the link; it loops until
  // we cancel it and replace it with the green/orange result glow.
  const progress = startProgress(anchor);

  try {
    chrome.runtime.sendMessage({ type: "CLEAN_URL", url: original }, (response) => {
      stopProgress(progress);

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
    stopProgress(progress);
  }
}

// All hover feedback is the same box-shadow "glow", drawn with the Web
// Animations API: not blocked by page CSP (unlike an injected <style> or inline
// style attribute), self-cleaning (nothing persists once the animation ends or
// is cancelled), and layout-neutral (box-shadow doesn't reflow).
//   - analyzing: off-white glow, pulsing on a loop until the result replaces it
//   - cleaned:   brief green glow (safe to click)
//   - failed:    brief orange glow (link unchanged)
const GLOW_GREEN = "52, 199, 89";
const GLOW_ORANGE = "255, 149, 0";
const GLOW_OFF_WHITE = "245, 245, 240";

// In-progress indicator: an off-white glow that pulses (alternating in/out)
// forever until stopProgress() cancels it. Returns the Animation handle, or
// undefined if the platform lacks element.animate — stopProgress() tolerates
// either.
function startProgress(anchor) {
  return anchor.animate?.(
    [
      { boxShadow: `0 0 0 2px rgba(${GLOW_OFF_WHITE}, 0.15)` },
      { boxShadow: `0 0 0 2px rgba(${GLOW_OFF_WHITE}, 0.85)` },
    ],
    { duration: 700, iterations: Infinity, direction: "alternate", easing: "ease-in-out" }
  );
}

function stopProgress(progress) {
  progress?.cancel?.();
}

// Brief result glow that fades out. Green = checked and safe to click; orange =
// the SlashCopy call failed and the link is unchanged.
function flashResult(anchor, success) {
  const rgb = success ? GLOW_GREEN : GLOW_ORANGE;
  anchor.animate?.(
    [
      { boxShadow: `0 0 0 2px rgba(${rgb}, 0.7)` },
      { boxShadow: `0 0 0 2px rgba(${rgb}, 0)` },
    ],
    { duration: 700, easing: "ease-out" }
  );
}
