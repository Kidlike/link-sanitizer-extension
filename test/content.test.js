// Unit tests for content.js: the hover debounce, the guards in handleLink
// (non-http, invalidated extension context), the success/failure feedback, and
// the flashResult glow colors.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadSource, makeConsole, makeTimers, fakeAnchor } = require("./helpers");

const GREEN = "52, 199, 89";
const ORANGE = "255, 149, 0";
const OFF_WHITE = "245, 245, 240";

// Sandbox content.js with mocked document, chrome.runtime, and timers.
// `nextResponse` shapes what sendMessage's callback receives:
//   { response } and/or { lastError }. `throwOnSend` simulates the context
//   dying between the guard and the send.
function setup({ runtimeId = "ext-id", invalidated = false, nextResponse, throwOnSend = false, pageHost = "example.com" } = {}) {
  const timers = makeTimers();
  const consoleMock = makeConsole();
  const sendCalls = [];
  const handlers = {};

  const chrome = {
    runtime: {
      id: invalidated ? undefined : runtimeId,
      lastError: undefined,
      sendMessage(msg, cb) {
        sendCalls.push(msg);
        if (throwOnSend) throw new Error("Extension context invalidated.");
        const r = typeof nextResponse === "function" ? nextResponse(msg) : nextResponse;
        chrome.runtime.lastError = r?.lastError;
        cb(r?.response);
        chrome.runtime.lastError = undefined;
      },
    },
  };
  const document = {
    addEventListener(type, handler) {
      handlers[type] = handler;
    },
  };

  const context = {
    chrome,
    document,
    console: consoleMock,
    location: { hostname: pageHost },
    URL,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  };
  const api = loadSource("content.js", context, [
    "handleLink", "flashResult", "startProgress", "stopProgress", "isSameSite", "processed",
    "applySettings", "isIgnoredHost", "hostMatches", "settings", "DEFAULT_HOVER_DELAY_MS",
  ]);

  return {
    api,
    timers,
    consoleMock,
    sendCalls,
    getHandler: () => handlers.mouseover,
    getKeydownHandler: () => handlers.keydown,
  };
}

// The box-shadow color of the first animation (used for direct flashResult
// tests) and the last animation (the result glow, after handleLink runs the
// pulsing progress glow first).
const firstShadow = (anchor) => anchor.animations[0].keyframes[0].boxShadow;
const resultShadow = (anchor) => anchor.animations.at(-1).keyframes[0].boxShadow;

test("flashResult glows green on success, orange on failure", () => {
  const { api } = setup();
  const ok = fakeAnchor("h");
  const bad = fakeAnchor("h");
  api.flashResult(ok, true);
  api.flashResult(bad, false);
  assert.match(firstShadow(ok), new RegExp(GREEN));
  assert.match(firstShadow(bad), new RegExp(ORANGE));
});

test("flashResult tolerates elements without the Web Animations API", () => {
  const { api } = setup();
  assert.doesNotThrow(() => api.flashResult({ dataset: {} }, true)); // no .animate
});

test("startProgress pulses an off-white glow forever until stopped", () => {
  const { api } = setup();
  const anchor = fakeAnchor("h");

  const progress = api.startProgress(anchor);

  assert.match(firstShadow(anchor), new RegExp(OFF_WHITE));
  assert.equal(anchor.animations[0].options.iterations, Infinity); // loops
  assert.equal(anchor.animations[0].options.direction, "alternate"); // in/out pulse
  assert.equal(progress.cancelled, false);

  api.stopProgress(progress);
  assert.equal(progress.cancelled, true);
});

test("startProgress / stopProgress tolerate a missing Web Animations API", () => {
  const { api } = setup();
  let progress;
  assert.doesNotThrow(() => (progress = api.startProgress({ dataset: {} }))); // no .animate
  assert.equal(progress, undefined);
  assert.doesNotThrow(() => api.stopProgress(progress)); // no-op on undefined
});

test("handleLink swaps the href, preserves the original, and flashes green", () => {
  const original = "https://site.com/p?utm_source=x";
  const { api, sendCalls } = setup({ nextResponse: { response: { ok: true, cleaned: "https://site.com/p" } } });
  const anchor = fakeAnchor(original);

  api.handleLink(anchor);

  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].type, "CLEAN_URL");
  assert.equal(sendCalls[0].url, original);
  assert.equal(anchor.href, "https://site.com/p");
  assert.equal(anchor.dataset.linkSanitizerOriginal, original);
  // First animation was the off-white pulse (now cancelled), last is the result.
  assert.match(firstShadow(anchor), new RegExp(OFF_WHITE));
  assert.equal(anchor.animations[0].cancelled, true);
  assert.match(resultShadow(anchor), new RegExp(GREEN));
  assert.equal(api.processed.has(anchor), true);
});

test("handleLink flashes green without swapping when already clean", () => {
  const original = "https://site.com/p";
  const { api } = setup({ nextResponse: { response: { ok: true, cleaned: original } } });
  const anchor = fakeAnchor(original);

  api.handleLink(anchor);

  assert.equal(anchor.href, original);
  assert.equal(anchor.dataset.linkSanitizerOriginal, undefined); // no data attr set
  assert.match(resultShadow(anchor), new RegExp(GREEN));
});

test("handleLink flashes orange and logs when the worker reports failure", () => {
  const { api, consoleMock } = setup({ nextResponse: { response: { ok: false, error: "rate limited" } } });
  const anchor = fakeAnchor("https://a.com");

  api.handleLink(anchor);

  assert.equal(anchor.href, "https://a.com"); // unchanged
  assert.match(resultShadow(anchor), new RegExp(ORANGE));
  assert.ok(consoleMock.find("rate limited"));
});

test("handleLink flashes orange on chrome.runtime.lastError", () => {
  const { api } = setup({ nextResponse: { lastError: { message: "no receiver" } } });
  const anchor = fakeAnchor("https://a.com");
  api.handleLink(anchor);
  assert.match(resultShadow(anchor), new RegExp(ORANGE));
});

test("handleLink ignores non-http links", () => {
  const { api, sendCalls } = setup({ nextResponse: { response: { ok: true, cleaned: "x" } } });
  for (const href of ["mailto:a@b.com", "javascript:void 0", ""]) {
    api.handleLink(fakeAnchor(href));
  }
  assert.equal(sendCalls.length, 0);
});

test("isSameSite matches the page host and its subdomains, not other sites", () => {
  const { api } = setup({ pageHost: "example.com" });
  // Same host and subdomain relationships in both directions.
  assert.equal(api.isSameSite("https://example.com/a"), true);
  assert.equal(api.isSameSite("https://www.example.com/a"), true);
  assert.equal(api.isSameSite("http://blog.example.com/x?y=1"), true);
  // Different sites.
  assert.equal(api.isSameSite("https://other.com/a"), false);
  assert.equal(api.isSameSite("https://notexample.com/a"), false); // not a real subdomain
  assert.equal(api.isSameSite("https://example.com.evil.com/a"), false);
});

test("handleLink skips same-site links (no send, no glow) and marks them processed", () => {
  const { api, sendCalls } = setup({ pageHost: "example.com" });
  const anchor = fakeAnchor("https://www.example.com/page?utm_source=x");

  api.handleLink(anchor);

  assert.equal(sendCalls.length, 0); // never asked the worker to clean it
  assert.equal(anchor.animations.length, 0); // no progress pulse, no result glow
  assert.equal(anchor.href, "https://www.example.com/page?utm_source=x"); // untouched
  assert.equal(api.processed.has(anchor), true); // won't be re-evaluated
});

test("handleLink still cleans cross-site links", () => {
  const { api, sendCalls } = setup({
    pageHost: "example.com",
    nextResponse: { response: { ok: true, cleaned: "https://other.com/p" } },
  });
  const anchor = fakeAnchor("https://other.com/p?utm_source=x");

  api.handleLink(anchor);

  assert.equal(sendCalls.length, 1);
  assert.equal(anchor.href, "https://other.com/p");
});

test("handleLink bails quietly when the extension context is invalidated", () => {
  const { api, sendCalls } = setup({ invalidated: true }); // chrome.runtime.id gone
  const anchor = fakeAnchor("https://a.com");
  assert.doesNotThrow(() => api.handleLink(anchor));
  assert.equal(sendCalls.length, 0); // never attempted the send
});

test("handleLink swallows a synchronous send throw (context died mid-call)", () => {
  const { api } = setup({ throwOnSend: true });
  assert.doesNotThrow(() => api.handleLink(fakeAnchor("https://a.com")));
});

// --- mouseover debounce ---

// ctrlKey defaults to true because ctrl mode is on by default; debounce tests
// below aren't about ctrl, so they hover "with Ctrl held". Ctrl-mode tests pass
// it explicitly.
function hoverEvent(anchor, ctrlKey = true) {
  return { ctrlKey, target: { closest: () => anchor } };
}

test("hovering a link schedules one debounced clean that runs on flush", () => {
  const { api, timers, sendCalls, getHandler } = setup({
    nextResponse: { response: { ok: true, cleaned: "https://a" } },
  });
  const handler = getHandler();
  const anchor = fakeAnchor("https://a?utm=1");

  handler(hoverEvent(anchor));
  handler(hoverEvent(anchor)); // rapid re-hover: cleared + rescheduled, still one pending
  assert.equal(timers.pendingCount(), 1);
  assert.equal(sendCalls.length, 0); // nothing sent until the delay elapses

  timers.flush();
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].url, "https://a?utm=1");
});

test("hovering a non-link schedules nothing", () => {
  const { timers, getHandler } = setup();
  getHandler()({ target: { closest: () => null } });
  assert.equal(timers.pendingCount(), 0);
});

test("an already-processed link is not re-scheduled", () => {
  const { api, timers, getHandler } = setup({ nextResponse: { response: { ok: true, cleaned: "https://a" } } });
  const anchor = fakeAnchor("https://a");

  api.processed.add(anchor); // pretend it was already handled
  getHandler()(hoverEvent(anchor));
  assert.equal(timers.pendingCount(), 0);
});

// --- settings: hover delay + ignored hosts ---

test("defaults apply before any stored settings load", () => {
  const { api, timers, getHandler } = setup({ nextResponse: { response: { ok: true, cleaned: "https://a" } } });
  assert.equal(api.settings.hoverDelayMs, api.DEFAULT_HOVER_DELAY_MS);
  assert.equal(api.DEFAULT_HOVER_DELAY_MS, 200);

  getHandler()(hoverEvent(fakeAnchor("https://a")));
  assert.equal(timers.lastDelay(), 200); // debounce uses the default delay
});

test("applySettings clamps the hover delay and uses it for the debounce", () => {
  const { api, timers, getHandler } = setup({ nextResponse: { response: { ok: true, cleaned: "https://a" } } });

  api.applySettings({ hoverDelayMs: 750 });
  assert.equal(api.settings.hoverDelayMs, 750);
  getHandler()(hoverEvent(fakeAnchor("https://a")));
  assert.equal(timers.lastDelay(), 750);
});

test("applySettings falls back to the default for a malformed delay", () => {
  const { api } = setup();
  for (const bad of [{ hoverDelayMs: -1 }, { hoverDelayMs: "abc" }, {}, null]) {
    api.applySettings(bad);
    assert.equal(api.settings.hoverDelayMs, api.DEFAULT_HOVER_DELAY_MS);
  }
});

test("isIgnoredHost matches the host and its subdomains, not lookalikes", () => {
  const { api } = setup();
  const list = ["kagi.com"];
  assert.equal(api.isIgnoredHost("kagi.com", list), true);
  assert.equal(api.isIgnoredHost("www.kagi.com", list), true);
  assert.equal(api.isIgnoredHost("search.kagi.com", list), true);
  assert.equal(api.isIgnoredHost("notkagi.com", list), false);
  assert.equal(api.isIgnoredHost("kagi.com.evil.com", list), false);
  assert.equal(api.isIgnoredHost("kagi.com", []), false);
});

test("ctrl mode is on by default and gates hovering on the Ctrl key", () => {
  const { api, timers, getHandler } = setup({ nextResponse: { response: { ok: true, cleaned: "https://a" } } });
  assert.equal(api.settings.ctrlMode, true); // default

  const handler = getHandler();
  handler(hoverEvent(fakeAnchor("https://a"), false)); // hover WITHOUT ctrl
  assert.equal(timers.pendingCount(), 0); // nothing scheduled

  handler(hoverEvent(fakeAnchor("https://a"), true)); // hover WITH ctrl
  assert.equal(timers.pendingCount(), 1); // now it debounces
});

test("disabling ctrl mode triggers on a bare hover", () => {
  const { api, timers, getHandler } = setup({ nextResponse: { response: { ok: true, cleaned: "https://a" } } });

  api.applySettings({ ctrlMode: false });
  assert.equal(api.settings.ctrlMode, false);

  getHandler()(hoverEvent(fakeAnchor("https://a"), false)); // no ctrl needed
  assert.equal(timers.pendingCount(), 1);
});

test("ctrl mode, hover-then-ctrl: pressing Ctrl cleans instantly (no delay)", () => {
  const { timers, sendCalls, getHandler, getKeydownHandler } = setup({
    nextResponse: { response: { ok: true, cleaned: "https://a" } },
  });

  getHandler()(hoverEvent(fakeAnchor("https://a?utm=1"), false)); // hover first, no Ctrl
  assert.equal(timers.pendingCount(), 0); // nothing scheduled yet
  assert.equal(sendCalls.length, 0);

  getKeydownHandler()({ key: "Control" }); // then press Ctrl
  assert.equal(timers.pendingCount(), 0); // bypassed the debounce entirely
  assert.equal(sendCalls.length, 1); // cleaned immediately
  assert.equal(sendCalls[0].url, "https://a?utm=1");
});

test("ctrl mode, ctrl-then-hover: hovering with Ctrl held uses the delay", () => {
  const { timers, sendCalls, getHandler, getKeydownHandler } = setup({
    nextResponse: { response: { ok: true, cleaned: "https://a" } },
  });

  getKeydownHandler()({ key: "Control" }); // Ctrl down before hovering anything
  assert.equal(sendCalls.length, 0); // no link under the pointer yet

  getHandler()(hoverEvent(fakeAnchor("https://a?utm=1"), true)); // then hover
  assert.equal(timers.pendingCount(), 1); // debounced, not instant
  assert.equal(sendCalls.length, 0);

  timers.flush();
  assert.equal(sendCalls.length, 1); // fires only after the delay elapses
});

test("keydown does nothing when the pointer isn't on a link", () => {
  const { timers, sendCalls, getKeydownHandler } = setup();
  getKeydownHandler()({ key: "Control" });
  assert.equal(timers.pendingCount(), 0);
  assert.equal(sendCalls.length, 0);
});

test("a non-Ctrl keydown never triggers a clean", () => {
  const { sendCalls, getHandler, getKeydownHandler } = setup();
  getHandler()(hoverEvent(fakeAnchor("https://a"), false));
  getKeydownHandler()({ key: "Shift" });
  assert.equal(sendCalls.length, 0);
});

test("moving off the link clears it, so a later Ctrl press does nothing", () => {
  const { sendCalls, getHandler, getKeydownHandler } = setup();
  getHandler()(hoverEvent(fakeAnchor("https://a"), false)); // hover a link (no ctrl)
  getHandler()({ ctrlKey: false, target: { closest: () => null } }); // move to non-link
  getKeydownHandler()({ key: "Control" });
  assert.equal(sendCalls.length, 0); // hovered was cleared
});

test("the keydown path also stays inert on an ignored host", () => {
  const { api, sendCalls, getHandler, getKeydownHandler } = setup({ pageHost: "kagi.com" });
  api.applySettings({ ignoredHosts: ["kagi.com"] });

  getHandler()(hoverEvent(fakeAnchor("https://other.com/p"), false));
  getKeydownHandler()({ key: "Control" });
  assert.equal(sendCalls.length, 0); // disabled here → nothing cleaned
});

test("applySettings defaults ctrlMode to true when unset or malformed", () => {
  const { api } = setup();
  for (const input of [{}, null, { ctrlMode: "yes" }, { ctrlMode: 1 }]) {
    api.applySettings(input);
    assert.equal(api.settings.ctrlMode, true);
  }
  api.applySettings({ ctrlMode: false });
  assert.equal(api.settings.ctrlMode, false);
});

test("mouseover schedules nothing on an ignored host", () => {
  const { api, timers, getHandler } = setup({ pageHost: "kagi.com" });

  api.applySettings({ ignoredHosts: ["kagi.com"] }); // disables this page
  getHandler()(hoverEvent(fakeAnchor("https://other.com/p?utm=1")));
  assert.equal(timers.pendingCount(), 0); // never even debounced

  // ...and re-enabling (list cleared) restores normal behavior.
  api.applySettings({ ignoredHosts: [] });
  getHandler()(hoverEvent(fakeAnchor("https://other.com/p?utm=1")));
  assert.equal(timers.pendingCount(), 1);
});
