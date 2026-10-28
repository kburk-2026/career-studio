import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { toListItem, toDetail, GET as jobsGET } from "../api/jobs.js";
import { toGroups } from "../api/profile.js";
import { GET as configGET } from "../api/config.js";
import { parseFragment } from "../public/js/auth.js";

const realFetch = globalThis.fetch;
const ENV = { SUPABASE_URL: "https://ref.supabase.co/rest/v1/", SUPABASE_ANON_KEY: "anon", ALLOWED_EMAIL: "Owner@example.com" };
let calls;

// Fake Supabase: /auth/v1/user answers by token, /rest/v1 records the call.
function fakeSupabase(users) {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers });
    if (String(url).endsWith("/auth/v1/user")) {
      const token = init.headers.Authorization.slice(7);
      return users[token] ? Response.json(users[token]) : new Response("{}", { status: 401 });
    }
    return Response.json([]);
  };
}

beforeEach(() => Object.assign(process.env, ENV));
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of Object.keys(ENV)) delete process.env[k];
});

const req = (path, token) => new Request(`http://x/api/${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

test("no token, bad token, and other accounts are refused", async () => {
  fakeSupabase({ good: { email: "owner@example.com" }, other: { email: "someone@example.com" } });
  assert.equal((await jobsGET(req("jobs"))).status, 401);
  assert.equal((await jobsGET(req("jobs", "expired"))).status, 401);
  assert.equal((await jobsGET(req("jobs", "other"))).status, 403);
  assert.ok(!calls.some((c) => c.url.includes("/rest/v1/")), "no database call before the owner check passes");
});

test("owner requests run as the owner, never the service role", async () => {
  fakeSupabase({ good: { email: "owner@example.com" } });
  const res = await jobsGET(req("jobs", "good"));
  assert.equal(res.status, 200);
  const db = calls.find((c) => c.url.includes("/rest/v1/jobs"));
  assert.ok(db.url.startsWith("https://ref.supabase.co/rest/v1/"), "trailing /rest/v1 in the env var is normalized");
  assert.equal(db.headers.Authorization, "Bearer good");
  assert.equal(db.headers.apikey, "anon");
});

test("detail ids must be positive integers", async () => {
  fakeSupabase({ good: { email: "owner@example.com" } });
  for (const bad of ["abc", "1.5", "-2", "0", "1,2", "1)"]) {
    assert.equal((await jobsGET(req(`jobs?id=${encodeURIComponent(bad)}`, "good"))).status, 400, bad);
  }
  assert.equal((await jobsGET(req("jobs?id=7", "good"))).status, 404);
});

test("config is withheld until the server is configured", async () => {
  delete process.env.ALLOWED_EMAIL;
  assert.equal(configGET().status, 503);
  process.env.ALLOWED_EMAIL = "owner@example.com";
  const body = await configGET().json();
  assert.deepEqual(Object.keys(body).sort(), ["anonKey", "supabaseUrl"]);
});

test("rows are shaped like the demo fixture", () => {
  const item = toListItem({ id: 1, company: "A", role_title: "R", status: "APPLIED", resume_file: "r.pdf", cover_letter_file: null, application_answers: [{ count: 3 }] });
  assert.equal(item.answer_count, 3);
  assert.equal(item.has_resume, true);
  assert.equal(item.has_cover_letter, false);

  const d = toDetail({
    id: 1, company: "A", role_title: "R", status: "APPLIED", strengths: ["s"], gaps: null,
    application_answers: [{ position: 2, question: "Q2", answer: "B" }, { position: 1, question: "Q1", answer: "A" }],
    status_history: [{ status: "INTERVIEWING", changed_at: "2026-10-27" }, { status: "APPLIED", changed_at: "2026-10-19" }],
  });
  assert.deepEqual(d.answers.map((a) => a.question), ["Q1", "Q2"]);
  assert.deepEqual(d.history.map((h) => h.status), ["APPLIED", "INTERVIEWING"]);
  assert.deepEqual(d.gaps, []);
  assert.equal(d.coach, null);
});

test("profile facts group by title", () => {
  const g = toGroups([{ group_title: "A", text: "1", verified: true }, { group_title: "B", text: "2", verified: false }, { group_title: "A", text: "3", verified: false }]);
  assert.deepEqual(g.map((x) => [x.title, x.items.length]), [["A", 2], ["B", 1]]);
});

test("magic-link fragment parsing", () => {
  const ok = parseFragment("#access_token=a&refresh_token=r&expires_in=60&token_type=bearer", 1000);
  assert.deepEqual(ok.session, { access_token: "a", refresh_token: "r", expires_at: 61000 });
  assert.equal(parseFragment("#error=access_denied&error_description=Email+link+is+invalid").error, "Email link is invalid");
  assert.equal(parseFragment(""), null);
  assert.equal(parseFragment("#access_token=a"), null);
});
