import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { POST as jobsPOST, PATCH as jobsPATCH } from "../api/jobs.js";
import { POST as answersPOST, PATCH as answersPATCH } from "../api/answers.js";
import { POST as factPOST, PATCH as profilePATCH, cleanPrefs } from "../api/profile.js";
import { PATCH as docPATCH } from "../api/documents.js";

const realFetch = globalThis.fetch;
const ENV = { SUPABASE_URL: "https://ref.supabase.co", SUPABASE_ANON_KEY: "anon", ALLOWED_EMAIL: "owner@example.com" };
let writes;

// Fake Supabase: the token "good" is the owner; reads answer from `tables`,
// writes are recorded and echoed back (or answered by `onWrite`).
function fake({ tables = {}, onWrite } = {}) {
  writes = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith("/auth/v1/user")) {
      return init.headers.Authorization === "Bearer good" ? Response.json({ id: "u1", email: "owner@example.com" }) : new Response("{}", { status: 401 });
    }
    const table = u.split("/rest/v1/")[1].split("?")[0];
    if (!init.method || init.method === "GET") return Response.json(tables[table] ?? []);
    const body = init.body ? JSON.parse(init.body) : undefined;
    writes.push({ method: init.method, table, url: u, body, prefer: init.headers.Prefer });
    if (onWrite) return onWrite({ method: init.method, table, body });
    return Response.json([{ id: 9, group_title: body?.group_title, ...body }]);
  };
}

const req = (method, path, body, token = "good") =>
  new Request(`http://x/api/${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(() => Object.assign(process.env, ENV));
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of Object.keys(ENV)) delete process.env[k];
});

test("writes are refused without the owner's session", async () => {
  fake();
  assert.equal((await jobsPOST(req("POST", "jobs", { company: "A", role_title: "R" }, "bad"))).status, 401);
  assert.equal(writes.length, 0);
});

test("new jobs start In progress; bad statuses and links are rejected", async () => {
  fake();
  assert.equal((await jobsPOST(req("POST", "jobs", { company: "A", role_title: "R" }))).status, 201);
  assert.equal(writes[0].body.status, "IN_PROGRESS");
  assert.equal((await jobsPOST(req("POST", "jobs", { company: "A", role_title: "R", status: "HIRED" }))).status, 400);
  assert.equal((await jobsPOST(req("POST", "jobs", { company: "A", role_title: "R", source_url: "javascript:alert(1)" }))).status, 400);
  assert.equal((await jobsPOST(req("POST", "jobs", { role_title: "R" }))).status, 400);
});

test("moving to Applied fills in today's date when none is set", async () => {
  fake({ tables: { jobs: [{ applied_on: null }] } });
  const res = await jobsPATCH(req("PATCH", "jobs?id=4", { status: "APPLIED" }));
  assert.equal(res.status, 200);
  assert.match(writes[0].body.applied_on, /^\d{4}-\d{2}-\d{2}$/);
});

test("editing an answer means it is no longer the submitted version", async () => {
  fake();
  await answersPATCH(req("PATCH", "answers?id=3", { answer: "new text" }));
  assert.equal(writes[0].body.final, false);
  await answersPATCH(req("PATCH", "answers?id=3", { final: true }));
  assert.equal(writes[1].body.final, true);
});

test("new answers need a job the user can see", async () => {
  fake({ tables: { jobs: [] } });
  assert.equal((await answersPOST(req("POST", "answers", { job_id: 5, question: "Why?" }))).status, 404);
});

test("new facts always start unverified, whatever the request says", async () => {
  fake();
  await factPOST(req("POST", "profile", { kind: "skill", group: "Product", text: "Roadmapping", verified: true }));
  assert.equal(writes[0].body.verified, false);
  assert.equal((await factPOST(req("POST", "profile", { kind: "salary", text: "x" }))).status, 400);
});

test("changing a fact's wording un-verifies it and keeps the old version", async () => {
  fake({ tables: { profile_facts: [{ id: 2, text: "Led a team of 7", verified: true, history: [] }] } });
  await profilePATCH(req("PATCH", "profile?fact=2", { text: "Led a team of 8", verified: true }));
  assert.equal(writes[0].body.verified, false, "an edit can't confirm itself in the same request");
  assert.equal(writes[0].body.history[0].text, "Led a team of 7");
});

test("preferences save as an upsert and validate types", async () => {
  fake();
  await profilePATCH(req("PATCH", "profile", { salary_min: 110000, arrangement: "Remote" }));
  assert.match(writes[0].prefer, /merge-duplicates/);
  assert.equal(writes[0].body.user_id, "u1");
  assert.throws(() => cleanPrefs({ salary_min: "lots" }));
  assert.deepEqual(Object.keys(cleanPrefs({ salary_min: 1, unknown: "x" })), ["salary_min"]);
});

test("the sent-document lock message reaches the user", async () => {
  fake({ onWrite: () => Response.json({ code: "P0001", message: "Sent documents are locked. Make a copy to edit." }, { status: 400 }) });
  const res = await docPATCH(req("PATCH", "documents?id=1", { content: { summary: "x" } }));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "Sent documents are locked. Make a copy to edit.");
});

test("other database errors stay generic", async () => {
  fake({ onWrite: () => Response.json({ code: "42501", message: "permission denied for table secret_stuff" }, { status: 403 }) });
  const res = await docPATCH(req("PATCH", "documents?id=1", { title: "x" }));
  assert.equal(res.status, 502);
  assert.ok(!(await res.text()).includes("secret_stuff"));
});

test("oversized bodies are refused", async () => {
  fake();
  const res = await answersPATCH(req("PATCH", "answers?id=1", { answer: "x".repeat(70 * 1024) }));
  assert.equal(res.status, 413);
});
