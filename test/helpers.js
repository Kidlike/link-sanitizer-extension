// Test harness. Loads an extension source file into a fresh V8 context with
// mocked browser globals (chrome, fetch, document, timers), then exposes the
// file's top-level bindings so tests can assert against the real code without
// modifying it. Extension scripts aren't importable modules, so this vm-based
// approach is how we unit test them.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");

// Evaluate `file` in `context`. `expose` is the list of top-level identifiers
// to capture onto globalThis.__exposed so the caller can reach them. Because it
// all runs as one script, appended code can see the file's const/function
// declarations.
function loadSource(file, context, expose) {
  let src = fs.readFileSync(path.join(ROOT, file), "utf8");
  src += `\n;globalThis.__exposed = { ${expose.join(", ")} };`;
  vm.createContext(context);
  vm.runInContext(src, context, { filename: file });
  return context.__exposed;
}

// A recording console so test output stays clean and warn/debug lines can be
// asserted on (e.g. the oversized-entry warning).
function makeConsole() {
  const messages = [];
  const record = (level) => (...args) => messages.push({ level, text: args.join(" ") });
  return {
    messages,
    debug: record("debug"),
    log: record("log"),
    warn: record("warn"),
    error: record("error"),
    find: (substr) => messages.find((m) => m.text.includes(substr)),
  };
}

// In-memory stand-in for chrome.storage.local, matching the async API surface
// the code uses: get(null) / get(string) / get(string[]), set, remove, clear.
function makeStorage(initial = {}) {
  const store = { ...initial };
  return {
    store,
    local: {
      async get(keys) {
        if (keys == null) return { ...store };
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of list) if (k in store) out[k] = store[k];
        return out;
      },
      async set(obj) {
        Object.assign(store, obj);
      },
      async remove(keys) {
        for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
      },
      async clear() {
        for (const k of Object.keys(store)) delete store[k];
      },
    },
  };
}

// Minimal Response-likes for the fetch mock.
function jsonResponse(obj, { ok = true, status = 200 } = {}) {
  const body = JSON.stringify(obj);
  return { ok, status, async text() { return body; }, async json() { return JSON.parse(body); } };
}

function rawResponse(text, { ok = true, status = 200 } = {}) {
  return { ok, status, async text() { return text; }, async json() { return JSON.parse(text); } };
}

// Controllable setTimeout/clearTimeout so debounce logic is deterministic.
function makeTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeout: (fn) => {
      const id = nextId++;
      pending.set(id, fn);
      return id;
    },
    clearTimeout: (id) => {
      pending.delete(id);
    },
    pendingCount: () => pending.size,
    flush: () => {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
    },
  };
}

// A fake <a> element that records the animations run on it. animate() returns a
// cancelable handle (mirroring the Web Animations API) so the pulsing
// in-progress glow can be started and cancelled like the real thing.
function fakeAnchor(href) {
  return {
    href,
    dataset: {},
    animations: [],
    animate(keyframes, options) {
      const anim = { keyframes, options, cancelled: false, cancel() { this.cancelled = true; } };
      this.animations.push(anim);
      return anim;
    },
  };
}

module.exports = {
  ROOT,
  loadSource,
  makeConsole,
  makeStorage,
  jsonResponse,
  rawResponse,
  makeTimers,
  fakeAnchor,
};
