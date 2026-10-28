import { test } from "node:test";
import assert from "node:assert/strict";
import { esc, formatDate, filterJobs, computeStats, fitFromBreakdown, profileStrength, localToday } from "../public/js/format.js";

const jobs = [
  { id: 1, company: "Beta", role_title: "Designer", status: "APPLIED", applied_on: "2026-10-01", fit_score: 70 },
  { id: 2, company: "Alpha", role_title: "Specialist", status: "INTERVIEWING", applied_on: "2026-10-05", fit_score: 90 },
  { id: 3, company: "Gamma", role_title: "Manager", status: "EMPLOYER_REJECTED", applied_on: "2026-09-01", fit_score: null },
  { id: 4, company: "Delta", role_title: "Lead", status: "PENDING_REVIEW", applied_on: null, fit_score: 99 },
  { id: 5, company: "Epsilon", role_title: "PM", status: "IN_PROGRESS", applied_on: null, fit_score: 80 },
  { id: 6, company: "Zeta", role_title: "Old", status: "EMAILED", applied_on: "2026-08-01", fit_score: null },
];

test("esc neutralizes HTML", () => {
  assert.equal(esc(`<img src=x onerror="a">'`), "&lt;img src=x onerror=&quot;a&quot;&gt;&#39;");
  assert.equal(esc(null), "");
});

test("unknown dates stay blank instead of being guessed", () => {
  assert.equal(formatDate(null), "—");
  assert.equal(formatDate("2026-10-05"), "Oct 5, 2026");
  assert.equal(localToday(new Date(2026, 9, 27, 23, 30)), "2026-10-27");
});

test("unknown statuses stay hidden; in-progress jobs come first", () => {
  assert.deepEqual(filterJobs(jobs).map((j) => j.id), [5, 2, 1, 3, 6]);
});

test("filters by status (EMAILED counts as Applied), search, and fit", () => {
  assert.deepEqual(filterJobs(jobs, { status: "APPLIED" }).map((j) => j.id), [1, 6]);
  assert.deepEqual(filterJobs(jobs, { query: "designer" }).map((j) => j.id), [1]);
  assert.deepEqual(filterJobs(jobs, { sort: "fit" }).map((j) => j.id), [2, 5, 1, 3, 6]);
});

test("stats separate sent applications from in-progress ones", () => {
  assert.deepEqual(computeStats(jobs), { submitted: 4, inProgress: 1, interviewing: 1, offers: 0, declined: 1, avgFit: 80 });
  assert.equal(computeStats([]).avgFit, null);
});

test("fit score follows the six-part rubric", () => {
  assert.equal(fitFromBreakdown({ core: 4, shape: 4, domain: 4, scope: 4, tools: 4, quals: 4 }), 100);
  assert.equal(fitFromBreakdown({ core: 3, shape: 2, domain: 4, scope: 3, tools: 2, quals: 2 }), 70);
  assert.equal(fitFromBreakdown({ core: 3, shape: 2 }), null);
  assert.equal(fitFromBreakdown({ core: 5, shape: 2, domain: 4, scope: 3, tools: 2, quals: 2 }), null);
});

test("profile strength names what's missing", () => {
  const empty = profileStrength({}, []);
  assert.equal(empty.percent, 0);
  assert.ok(empty.missing[1].startsWith("Desired salary"));
  const some = profileStrength({ salary_min: 100000, arrangement: "Remote" }, [{ kind: "skill", verified: true }]);
  assert.equal(some.percent, 30);
});
