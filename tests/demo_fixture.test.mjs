import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { STATUS, fitFromBreakdown } from "../public/js/format.js";
import { docText } from "../public/js/doc.js";

const read = (p) => JSON.parse(readFileSync(new URL(`../public/demo/${p}`, import.meta.url), "utf8"));
const list = read("applications.json");
const details = Object.fromEntries(
  readdirSync(new URL("../public/demo/jobs/", import.meta.url)).map((f) => [Number(f.replace(".json", "")), read(`jobs/${f}`)]),
);

test("every demo file is marked fictional", () => {
  assert.equal(list.fictional, true);
  assert.equal(read("profile.json").fictional, true);
  assert.equal(read("documents.json").fictional, true);
  for (const d of Object.values(details)) assert.equal(d.fictional, true, `job ${d.id}`);
});

test("list rows match their detail files", () => {
  for (const j of list.jobs) {
    const d = details[j.id];
    assert.ok(d, `missing detail for ${j.id}`);
    assert.equal(d.company, j.company);
    assert.equal(d.status, j.status);
    assert.equal(d.answers.length, j.answer_count, `answer_count for ${j.id}`);
    assert.ok(STATUS[j.status], `unknown status on ${j.id}`);
    if (d.fit_breakdown) assert.equal(fitFromBreakdown(d.fit_breakdown), j.fit_score, `fit breakdown for ${j.id}`);
  }
});

test("interviewing roles have a complete coach prep", () => {
  for (const j of list.jobs.filter((x) => x.status === "INTERVIEWING")) {
    const c = details[j.id].coach;
    assert.ok(c, `no coach for ${j.id}`);
    assert.ok(c.priorities.length >= 3 && c.priorities.length <= 5, "3-5 priorities");
    assert.ok(c.stories.length >= 5 && c.stories.length <= 6, "5-6 stories");
    assert.ok(c.concern && c.first_question);
    // One main question (with at most one sub-part), never a batch.
    assert.ok((c.first_question.match(/\?/g) || []).length <= 2, "first_question is a batch");
  }
});

test("coach numbers are grounded in the demo profile", () => {
  const profileText = JSON.stringify(read("profile.json"));
  const profileNumbers = new Set(profileText.match(/\d+/g));
  for (const d of Object.values(details)) {
    for (const s of d.coach?.stories || []) {
      for (const n of `${s.situation} ${s.action} ${s.result}`.match(/\d+/g) || []) {
        assert.ok(profileNumbers.has(n), `story "${s.title}" uses ${n}, which is not in the profile`);
      }
    }
  }
});

test("demo documents use only profile numbers and no em or en dashes", () => {
  const profileNumbers = new Set(JSON.stringify(read("profile.json")).match(/\d+/g));
  for (const doc of read("documents.json").documents) {
    if (!doc.content) continue;
    const text = docText(doc.kind, doc.content);
    assert.ok(!/[\u2013\u2014]/.test(text), `dash in ${doc.title}`);
    for (const n of text.match(/\d+/g) || []) {
      if (/^(19|20)\d\d$/.test(n)) continue; // employment years
      assert.ok(profileNumbers.has(n), `${doc.title} uses ${n}, which is not in the profile`);
    }
  }
});

test("demo facts include unverified items so the confirm flow is visible", () => {
  const facts = read("profile.json").facts;
  assert.ok(facts.some((f) => !f.verified));
  assert.ok(new Set(facts.map((f) => f.id)).size === facts.length, "fact ids are unique");
});

test("the recorded demo review is fictional and internally consistent", () => {
  const r = read("review.json");
  assert.equal(r.fictional, true);
  assert.equal(fitFromBreakdown(r.fit_breakdown), r.fit_score);
  const profileNumbers = new Set(JSON.stringify(read("profile.json")).match(/\d+/g));
  for (const n of [...r.strengths, ...r.gaps].join(" ").match(/\d+/g) || []) assert.ok(profileNumbers.has(n), `review uses ${n}`);
});
