// Unit tests for options.js: the pure normalization/validation helpers behind
// the settings panel. The DOM wiring (initOptionsPage) is skipped when the file
// is loaded without a `document`, so only the pure logic is exercised here.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadSource } = require("./helpers");

function setup() {
  // No `document` in the context, so options.js skips initOptionsPage().
  const context = { URL, Number, Math };
  return loadSource("options.js", context, [
    "sanitizeDelay", "normalizeHost", "parseIgnoredHosts", "formatIgnoredHosts", "DEFAULT_HOVER_DELAY_MS",
  ]);
}

test("sanitizeDelay accepts non-negative numbers and rounds them", () => {
  const api = setup();
  assert.equal(api.sanitizeDelay("300"), 300);
  assert.equal(api.sanitizeDelay(0), 0);
  assert.equal(api.sanitizeDelay(199.6), 200);
});

test("sanitizeDelay falls back to the default on junk or negatives", () => {
  const api = setup();
  assert.equal(api.sanitizeDelay(""), api.DEFAULT_HOVER_DELAY_MS);
  assert.equal(api.sanitizeDelay("abc"), api.DEFAULT_HOVER_DELAY_MS);
  assert.equal(api.sanitizeDelay(-5), api.DEFAULT_HOVER_DELAY_MS);
  assert.equal(api.sanitizeDelay(NaN), api.DEFAULT_HOVER_DELAY_MS);
});

test("normalizeHost reduces varied input to a bare lowercased host", () => {
  const api = setup();
  assert.equal(api.normalizeHost("  KAGI.com  "), "kagi.com");
  assert.equal(api.normalizeHost("https://www.kagi.com/search?q=x"), "www.kagi.com");
  assert.equal(api.normalizeHost("//mail.example.com/inbox"), "mail.example.com");
  assert.equal(api.normalizeHost("example.com:8080/path"), "example.com");
  assert.equal(api.normalizeHost(""), "");
  assert.equal(api.normalizeHost("   "), "");
});

test("parseIgnoredHosts splits lines, normalizes, drops blanks, and dedupes", () => {
  const api = setup();
  const parsed = api.parseIgnoredHosts("kagi.com\n\n  https://KAGI.com/x \nexample.com\nkagi.com\n");
  // Array.from bridges the vm realm so deepEqual compares by value, not prototype.
  assert.deepEqual(Array.from(parsed), ["kagi.com", "example.com"]); // order preserved, no dupes
});

test("formatIgnoredHosts renders one host per line and tolerates non-arrays", () => {
  const api = setup();
  assert.equal(api.formatIgnoredHosts(["a.com", "b.com"]), "a.com\nb.com");
  assert.equal(api.formatIgnoredHosts([]), "");
  assert.equal(api.formatIgnoredHosts(undefined), "");
});
