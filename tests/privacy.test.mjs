import { test } from "node:test";
import assert from "node:assert/strict";
import { scanText } from "../scripts/check_privacy.mjs";

const kinds = (text, canaries) => scanText("f", text, canaries).map((h) => h.kind);

// Fake values are assembled at runtime so this file doesn't trip the scanner itself.
const FAKE_KEY = ["sk", "ant", "api03", "abcdefghijklmnop"].join("-");
const FAKE_JWT = ["eyJhbGciOiJIUzI1", "eyJyb2xlIjoic2VydmljZV9y", "c2lnbmF0dXJlLXZhbHVl"].join(".");
const FAKE_EMAIL = ["someone", "gmail.com"].join("@");
const FAKE_PHONE = ["555", "123", "4567"].join("-");

test("flags secrets without echoing them", () => {
  const hits = scanText("f", `key = ${FAKE_KEY}`, []);
  assert.equal(hits.length, 1);
  assert.ok(!JSON.stringify(hits).includes("abcdefghijklmnop"));
  assert.ok(kinds(`token ${FAKE_JWT}`).includes("JWT / Supabase key"));
});

test("flags contact details but allows placeholders", () => {
  assert.deepEqual(kinds(`mail me at ${FAKE_EMAIL}`), ["Email address"]);
  assert.deepEqual(kinds(`call ${FAKE_PHONE}`), ["Phone number"]);
  assert.deepEqual(kinds("use you@example.com"), []);
  assert.deepEqual(kinds("Co-Authored-By: Claude <noreply@anthropic.com>"), []);
});

test("canaries match whole words, case-insensitive", () => {
  assert.equal(kinds("Applied to ACME Corp today", ["Acme Corp"]).length, 1);
  assert.equal(kinds("Acmeville", ["Acme"]).length, 0);
});
