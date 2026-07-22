// Content script: watches for links under the pointer, asks the background
// worker to clean them, and swaps the href in place.

// User-tunable settings live in chrome.storage.local under the `settings` key
// and are edited on the options page (options.html/js). We hold a live copy
// here, seeded with defaults and refreshed whenever storage changes, so edits
// take effect on open pages without a reload. Keep DEFAULT_HOVER_DELAY_MS in
// sync with the options page.
const SETTINGS_KEY = "settings";
const DEFAULT_HOVER_DELAY_MS = 200;

const settings = {
  // How long the pointer must rest on a link before we clean it.
  hoverDelayMs: DEFAULT_HOVER_DELAY_MS,
  // Hosts on which the extension does nothing at all (see disabledHere).
  ignoredHosts: [],
};

// True when the *current page* is on an ignored host, in which case we never
// touch its links. Recomputed by applySettings() whenever the list changes.
let disabledHere = false;

// True when `pageHost` equals `entry` or is a subdomain of it, so a single
// "kagi.com" entry also silences "www.kagi.com". Mirrors the subdomain
// heuristic used by isSameSite below.
function hostMatches(pageHost, entry) {
  const host = String(pageHost).toLowerCase();
  const target = String(entry).trim().toLowerCase();
  if (!host || !target) return false;
  return host === target || host.endsWith("." + target);
}

function isIgnoredHost(pageHost, list) {
  return Array.isArray(list) && list.some((entry) => hostMatches(pageHost, entry));
}

// Merge a stored settings object over the defaults, validating each field so a
// malformed value can't break hovering. Recomputes disabledHere for this page.
function applySettings(stored) {
  const next = stored && typeof stored === "object" ? stored : {};
  const delay = Math.round(Number(next.hoverDelayMs));
  settings.hoverDelayMs = Number.isFinite(delay) && delay >= 0 ? delay : DEFAULT_HOVER_DELAY_MS;
  settings.ignoredHosts = Array.isArray(next.ignoredHosts) ? next.ignoredHosts : [];
  disabledHere = isIgnoredHost(location.hostname, settings.ignoredHosts);
}

// Load settings once at startup, then keep them current. Guarded because the
// unit-test sandbox mocks only chrome.runtime, not chrome.storage.
if (chrome.storage?.local?.get) {
  chrome.storage.local
    .get(SETTINGS_KEY)
    .then((stored) => applySettings(stored?.[SETTINGS_KEY]))
    .catch((error) => console.warn("[Link Sanitizer] failed to load settings:", String(error)));
}
if (chrome.storage?.onChanged?.addListener) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[SETTINGS_KEY]) {
      applySettings(changes[SETTINGS_KEY].newValue);
    }
  });
}

// Tracks links we've already processed so we don't re-clean on every hover.
const processed = new WeakSet();

let hoverTimer = null;

document.addEventListener(
  "mouseover",
  (event) => {
    // Stay completely out of the way on ignored sites.
    if (disabledHere) return;

    const anchor = event.target.closest?.("a[href]");
    if (!anchor || processed.has(anchor)) return;

    // Debounce: only act if the pointer lingers on the link.
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => handleLink(anchor), settings.hoverDelayMs);
  },
  true
);

// True when `url` points to the same site as the current page — the same host,
// or a subdomain relationship in either direction (e.g. example.com <->
// www.example.com). This is a lightweight heuristic, not a Public Suffix List
// lookup, so tighten it to an exact host match if subdomain grouping is wrong
// for your use.
function isSameSite(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const here = location.hostname.toLowerCase();
    if (!host || !here) return false;
    return host === here || host.endsWith("." + here) || here.endsWith("." + host);
  } catch {
    return false;
  }
}

function handleLink(anchor) {
  const original = anchor.href;
  if (!original || !/^https?:/i.test(original)) return;

  // Skip the site's own internal links: there's nothing to clean on links that
  // stay on the current site, and it avoids pointless API calls. Mark them
  // processed so we don't re-evaluate on every hover.
  if (isSameSite(original)) {
    processed.add(anchor);
    return;
  }

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
