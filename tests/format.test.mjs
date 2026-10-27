import { test } from "node:test";
import assert from "node:assert/strict";
import { esc, formatDate, filterJobs, computeStats } from "../public/js/format.js";

const jobs = [
  { id: 1, company: "Beta", role_title: "Designer", status: "APPLIED", applied_on: "2026-10-01", fit_score: 70 },
  { id: 2, company: "Alpha", role_title: "Specialist", status: "INTERVIEWING", applied_on: "2026-10-05", fit_score: 90 },
  { id: 3, company: "Gamma", role_title: "Manager", status: "EMPLOYER_REJECTED", applied_on: null, fit_score: null },
  { id: 4, company: "Delta", role_title: "Lead", status: "PENDING_REVIEW", applied_on: null, fit_score: 99 },
];

test("esc neutralizes HTML", () => {
  assert.equal(esc(`<img src=x onerror="a">'`), "&lt;img src=x onerror=&quot;a&quot;&gt;&#39;");
  assert.equal(esc(null), "");
});

test("unknown dates stay blank instead of being guessed", () => {
  assert.equal(formatDate(null), "—");
  assert.equal(formatDate("2026-10-05"), "Oct 5, 2026");
});

test("dashboard shows sent applications only", () => {
  assert.deepEqual(filterJobs(jobs).map((j) => j.id), [2, 1, 3]);
});

test("filters by status and search, sorts by fit", () => {
  assert.deepEqual(filterJobs(jobs, { status: "INTERVIEWING" }).map((j) => j.id), [2]);
  assert.deepEqual(filterJobs(jobs, { query: "designer" }).map((j) => j.id), [1]);
  assert.deepEqual(filterJobs(jobs, { sort: "fit" }).map((j) => j.id), [2, 1, 3]);
});

test("stats ignore unsent rows and missing fit scores", () => {
  assert.deepEqual(computeStats(jobs), { submitted: 3, interviewing: 1, offers: 0, declined: 1, avgFit: 80 });
  assert.equal(computeStats([]).avgFit, null);
});
