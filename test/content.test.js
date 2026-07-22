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
function setup({ runtimeId = "ext-id", invalidated = false, nextResponse, throwOnSend = false } = {}) {
  const timers = makeTimers();
  const consoleMock = makeConsole();
  const sendCalls = [];
  let mouseoverHandler;

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
      if (type === "mouseover") mouseoverHandler = handler;
    },
  };

  const context = {
    chrome,
    document,
    console: consoleMock,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  };
  const api = loadSource("content.js", context, [
    "handleLink", "flashResult", "startProgress", "stopProgress", "processed", "HOVER_DELAY_MS",
  ]);

  return { api, timers, consoleMock, sendCalls, getHandler: () => mouseoverHandler };
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

function hoverEvent(anchor) {
  return { target: { closest: () => anchor } };
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
