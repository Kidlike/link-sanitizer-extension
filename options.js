// Options page: reads and writes the user's settings in chrome.storage.local
// under the single `settings` key. content.js reads the same key (and reacts to
// changes live via chrome.storage.onChanged), so saving here takes effect on
// open pages without a reload.

// Keep in sync with the defaults in content.js. Duplicated (not imported)
// because content scripts and extension pages don't share a module scope.
const SETTINGS_KEY = "settings";
const DEFAULT_HOVER_DELAY_MS = 200;

// Clamp a hover-delay input to a sane, non-negative integer number of ms,
// falling back to the default when the field is empty or not a number.
function sanitizeDelay(value, fallback = DEFAULT_HOVER_DELAY_MS) {
  // Treat an empty/blank field as "use the default" — Number("") is 0, which we
  // don't want to silently persist as a zero-delay.
  if (value == null || String(value).trim() === "") return fallback;
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Reduce one free-form line to a bare, lowercased host. Tolerates users pasting
// a full URL ("https://kagi.com/foo"), a leading "//", a trailing path, or a
// port — we only want the hostname. Returns "" for anything unusable.
function normalizeHost(line) {
  let host = String(line).trim().toLowerCase();
  if (!host) return "";
  if (host.includes("://")) {
    try {
      host = new URL(host).hostname;
    } catch {
      return "";
    }
  } else {
    // Strip a scheme-relative prefix, any path/query, and a port.
    host = host.replace(/^\/\//, "").split(/[/?#]/)[0].split(":")[0];
  }
  return host;
}

// Parse the textarea into a deduped, order-preserving list of hosts.
function parseIgnoredHosts(text) {
  const seen = new Set();
  const out = [];
  for (const line of String(text).split("\n")) {
    const host = normalizeHost(line);
    if (host && !seen.has(host)) {
      seen.add(host);
      out.push(host);
    }
  }
  return out;
}

// One host per line, for display in the textarea.
function formatIgnoredHosts(list) {
  return (Array.isArray(list) ? list : []).join("\n");
}

// --- DOM wiring (skipped when loaded outside a page, e.g. in unit tests) ---

function initOptionsPage() {
  const ctrlModeInput = document.getElementById("ctrl-mode");
  const delayInput = document.getElementById("hover-delay");
  const hostsInput = document.getElementById("ignored-hosts");
  const saveButton = document.getElementById("save");
  const status = document.getElementById("status");
  if (!ctrlModeInput || !delayInput || !hostsInput || !saveButton) return;

  let statusTimer = null;
  function showStatus(message, isError = false) {
    status.textContent = message;
    status.classList.toggle("error", isError);
    status.classList.add("show");
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => status.classList.remove("show"), 2000);
  }

  // Populate the form from stored settings (or defaults on first run).
  chrome.storage.local.get(SETTINGS_KEY).then((stored) => {
    const settings = stored?.[SETTINGS_KEY] ?? {};
    // Ctrl mode is opt-out: default to on unless explicitly stored as false.
    ctrlModeInput.checked = settings.ctrlMode !== false;
    delayInput.value = sanitizeDelay(settings.hoverDelayMs);
    hostsInput.value = formatIgnoredHosts(settings.ignoredHosts);
  });

  saveButton.addEventListener("click", () => {
    const settings = {
      ctrlMode: ctrlModeInput.checked,
      hoverDelayMs: sanitizeDelay(delayInput.value),
      ignoredHosts: parseIgnoredHosts(hostsInput.value),
    };
    chrome.storage.local
      .set({ [SETTINGS_KEY]: settings })
      .then(() => {
        // Reflect the normalized values back so the user sees what was saved.
        delayInput.value = settings.hoverDelayMs;
        hostsInput.value = formatIgnoredHosts(settings.ignoredHosts);
        showStatus("Saved.");
      })
      .catch((error) => showStatus("Couldn't save: " + String(error), true));
  });
}

if (typeof document !== "undefined" && document.getElementById) {
  initOptionsPage();
}
