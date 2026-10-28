import { test } from "node:test";
import assert from "node:assert/strict";
import { numbersIn, evidenceNumbers, checkText, checkSummary, undash } from "../api/_lib/guard.js";
import { preferenceMatch } from "../api/_lib/prefmatch.js";
import { isPrivateAddress, assertPublicUrl, htmlToText } from "../api/_lib/fetch_posting.js";
import { summarize, monthlyCap } from "../api/_lib/limits.js";
import { costOf } from "../api/_lib/ai/claude.js";
import { scoreReview } from "../api/review.js";
import { profileContext, REVIEW_SCHEMA } from "../api/_lib/prompts.js";

test("numbers are normalized and checked against evidence", () => {
  assert.deepEqual(numbersIn("4,000 students, $2 million, 35,598 views, 3.5 years"), ["4000", "2", "35598", "3.5"]);
  const ev = evidenceNumbers("Served more than 4,000 students", "a team of seven");
  assert.deepEqual(checkText("Led 7 people serving 4,000 students", ev), []);
  const issues = checkText("Grew enrollment 40% for 4,000 students", ev);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].value, "40");
});

test("dashes, filler phrases, and title claims are caught", () => {
  const ev = new Set();
  assert.equal(checkText("Product leader — learning", ev)[0].kind, "dash");
  assert.equal(checkText("Successfully launched a platform", ev)[0].kind, "phrase");
  assert.equal(checkSummary("VP of Learning with 20 years").length, 1);
  assert.equal(checkSummary("Product leader with 20 years").length, 0);
  assert.equal(undash("Design – build — ship"), "Design - build - ship");
});

test("preference match flags salary, arrangement, and industry", () => {
  const prefs = { salary_min: 95000, arrangement: "Remote", industries_preferred: "Higher education, EdTech", industries_avoid: "Gambling", level: "Director" };
  const low = preferenceMatch(prefs, { salary_min: 90000, salary_max: 110000, arrangement: "onsite", industry: "Gambling", level: "director" });
  assert.deepEqual(low.map((m) => m.status), ["no", "no", "no", "ok"]);
  assert.match(low[1].text, /below your \$95k minimum/);
  const good = preferenceMatch(prefs, { salary_min: 140000, salary_max: 170000, arrangement: "remote", industry: "EdTech", level: "senior" });
  assert.deepEqual(good.map((m) => m.status), ["ok", "ok", "ok", "warn"]);
  const unknown = preferenceMatch(prefs, { arrangement: "unknown" });
  assert.deepEqual(unknown.map((m) => m.status), ["warn", "warn"]);
});

test("links to private or local addresses are refused", async () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "::ffff:127.0.0.1"]) {
    assert.ok(isPrivateAddress(ip), ip);
  }
  assert.ok(!isPrivateAddress("93.184.216.34"));
  await assert.rejects(assertPublicUrl("http://example.com/job"), /https/);
  await assert.rejects(assertPublicUrl("https://169.254.169.254/latest/meta-data"), /private/);
  await assert.rejects(assertPublicUrl("https://user:pw@example.com/"), /sign-in/);
  await assert.rejects(assertPublicUrl("https://example.com:8443/"), /port/);
  await assert.rejects(assertPublicUrl("file:///etc/passwd"), /https/);
});

test("posting HTML becomes readable text without scripts", () => {
  const text = htmlToText("<html><head><title>x</title></head><body><script>steal()</script><h1>Role</h1><ul><li>Canvas</li><li>Power BI</li></ul><p>Salary&nbsp;$120,000</p></body></html>");
  assert.ok(!text.includes("steal"));
  assert.match(text, /- Canvas/);
  assert.match(text, /Salary \$120,000/);
});

test("budget summary counts this month's spend and today's calls", () => {
  const now = new Date("2026-10-28T12:00:00Z");
  const rows = [
    { cost_usd: "0.05", created_at: "2026-10-28T10:00:00Z" },
    { cost_usd: "0.10", created_at: "2026-10-02T10:00:00Z" },
  ];
  const s = summarize(rows, now);
  assert.equal(s.callsToday, 1);
  assert.ok(Math.abs(s.spent - 0.15) < 1e-9);
  assert.equal(monthlyCap(), 15);
});

test("cost uses per-model prices, with cache writes and reads", () => {
  assert.equal(costOf("claude-sonnet-5-5", { input_tokens: 1_000_000, output_tokens: 100_000 }), 2 + 1);
  assert.equal(costOf("claude-opus-5-5", { cache_creation_input_tokens: 1_000_000 }), 5);
  assert.ok(Math.abs(costOf("claude-opus-5-5", { cache_read_input_tokens: 1_000_000 }) - 0.2) < 1e-9);
  assert.equal(costOf("some-new-model", { input_tokens: 1_000_000 }), 4, "unknown models are priced high");
});

const aiReview = {
  company: "Acme", role_title: "PM",
  posting_facts: { salary_min: null, salary_max: null, arrangement: "remote", location: "Remote", industry: "EdTech", level: "senior", employment_type: null },
  requirements: [],
  scores: { core: { score: 3, reason: "a" }, shape: { score: 2, reason: "b" }, domain: { score: 4, reason: "c" }, scope: { score: 3, reason: "d" }, tools: { score: 2, reason: "e" }, quals: { score: 2, reason: "f — g" } },
  screening: "highly_selective",
  strengths: ["Led a portfolio serving 4,000 students"],
  gaps: ["No SCORM"],
  summary: "Grew revenue 300%.",
};

test("fit and odds are computed in code, not taken from the model", () => {
  const facts = [{ verified: true, text: "Portfolio serving more than 4,000 students" }];
  const r = scoreReview(aiReview, { arrangement: "Remote" }, facts, "posting text");
  assert.equal(r.fit_score, 70);
  assert.equal(r.odds_score, 55);
  assert.equal(r.fit_breakdown.reasons.quals, "f - g", "dashes removed");
  assert.equal(r.pref_match[0].status, "ok");
  assert.deepEqual(r.flags.map((f) => f.value), ["300"], "an invented number is flagged");
});

test("only confirmed facts reach the model", () => {
  const ctx = profileContext([
    { kind: "skill", group_title: "Tools", text: "Canvas", verified: true },
    { kind: "skill", group_title: "Tools", text: "Storyline", verified: false },
  ], { salary_min: 95000, location: null });
  assert.match(ctx, /Canvas/);
  assert.ok(!ctx.includes("Storyline"));
  assert.match(ctx, /salary min: 95000/);
  assert.ok(!ctx.includes("location"));
});

test("review schema is strict", () => {
  const walk = (s) => {
    if (s.type === "object") {
      assert.equal(s.additionalProperties, false);
      assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort());
      Object.values(s.properties).forEach(walk);
    }
    if (s.type === "array") walk(s.items);
  };
  walk(REVIEW_SCHEMA);
});
