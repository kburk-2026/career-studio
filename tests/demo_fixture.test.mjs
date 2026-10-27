import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { SENT_STATUSES } from "../public/js/format.js";

const read = (p) => JSON.parse(readFileSync(new URL(`../public/demo/${p}`, import.meta.url), "utf8"));
const list = read("applications.json");
const details = Object.fromEntries(
  readdirSync(new URL("../public/demo/jobs/", import.meta.url)).map((f) => [Number(f.replace(".json", "")), read(`jobs/${f}`)]),
);

test("every demo file is marked fictional", () => {
  assert.equal(list.fictional, true);
  assert.equal(read("profile.json").fictional, true);
  for (const d of Object.values(details)) assert.equal(d.fictional, true, `job ${d.id}`);
});

test("list rows match their detail files", () => {
  for (const j of list.jobs) {
    const d = details[j.id];
    assert.ok(d, `missing detail for ${j.id}`);
    assert.equal(d.company, j.company);
    assert.equal(d.status, j.status);
    assert.equal(d.answers.length, j.answer_count, `answer_count for ${j.id}`);
    assert.ok(SENT_STATUSES.has(j.status), `unsent status on ${j.id}`);
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
