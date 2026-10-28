import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { POST as uploadPOST, detectType, safeName } from "../api/upload.js";
import { POST as profilePOST } from "../api/profile.js";
import { POST as buildPOST, factsFromEntry } from "../api/build.js";
import { EXTRACT_SCHEMA } from "../api/_lib/prompts.js";

const realFetch = globalThis.fetch;
const ENV = { SUPABASE_URL: "https://ref.supabase.co", SUPABASE_ANON_KEY: "anon", ALLOWED_EMAIL: "owner@example.com", ANTHROPIC_API_KEY: "test-key" };
let calls;

const extracted = {
  name: "Jordan Avery", contact: "Remote", summary: "",
  roles: [{ org: "Northfield", title: "Lead Designer", dates: "2019 – present" }],
  results: [{ employer: "Northfield", text: "Cut review rounds from 3 to 2." }],
  skills: [{ group: "Tools", items: ["Canvas"] }],
  education: [{ text: "MEd", dates: "2010" }],
};

function fake() {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ u, method: init.method || "GET", body: init.body });
    if (u.endsWith("/auth/v1/user")) return Response.json({ id: "u1", email: "owner@example.com" });
    if (u.includes("api.anthropic.com")) {
      return Response.json({ id: "m", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: JSON.stringify(extracted) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } });
    }
    if (u.includes("/rpc/record_ai_usage")) return new Response(null, { status: 204 });
    if (u.includes("/storage/v1/object/docs/")) return Response.json({ Key: "ok" });
    if (init.method === "POST") return Response.json([{ id: 5, ...(JSON.parse(init.body)[0] || JSON.parse(init.body)) }]);
    return Response.json([]);
  };
}

const req = (path, body, headers = {}) => new Request(`http://x/api/${path}`, { method: "POST", headers: { Authorization: "Bearer t", ...headers }, body });

beforeEach(() => { Object.assign(process.env, ENV); fake(); });
afterEach(() => { globalThis.fetch = realFetch; for (const k of Object.keys(ENV)) delete process.env[k]; });

test("file type comes from the file's bytes, not its name", () => {
  assert.equal(detectType(Buffer.from("%PDF-1.7 ...")), "pdf");
  assert.equal(detectType(Buffer.from("PK\u0003\u0004...")), "docx");
  assert.equal(detectType(Buffer.from("<html>")), null);
  assert.equal(safeName("../../etc/My Résumé (final).pdf", "pdf"), "_etc_My_R_sum_final_.pdf", "no slashes survive");
});

test("an upload is stored in the owner's folder, read, and returned for confirmation", async () => {
  const res = await uploadPOST(req("upload", "%PDF-1.4 fake resume bytes", { "X-File-Name": encodeURIComponent("cv.pdf"), "Content-Type": "application/pdf" }));
  const out = await res.json();
  assert.equal(res.status, 201);
  const stored = calls.find((c) => c.u.includes("/storage/v1/object/docs/"));
  assert.match(stored.u, /\/docs\/u1\/uploads\/\d+-cv\.pdf$/, "stored under the owner's own folder");
  assert.equal(out.extracted.roles[0].dates, "2019 - present", "dashes removed");
  assert.ok(!calls.some((c) => c.u.includes("profile_facts")), "nothing joins the profile before confirmation");
});

test("non-resume files are refused before anything is stored or read", async () => {
  const res = await uploadPOST(req("upload", "<html>not a resume</html>"));
  assert.equal(res.status, 415);
  assert.ok(!calls.some((c) => c.u.includes("storage") || c.u.includes("anthropic")));
});

test("ticked items save as confirmed only with explicit confirmation", async () => {
  assert.equal((await profilePOST(req("profile?batch=1", JSON.stringify({ facts: [{ kind: "skill", group: "Tools", text: "Canvas" }] })))).status, 400);
  const res = await profilePOST(req("profile?batch=1", JSON.stringify({ confirmed: true, source: "upload", facts: [{ kind: "skill", group: "Tools", text: "Canvas" }, { kind: "result", group: "Northfield", text: "Cut review rounds from 3 to 2." }] })));
  assert.equal(res.status, 201);
  const written = JSON.parse(calls.find((c) => c.u.includes("profile_facts") && c.method === "POST").body);
  assert.ok(written.every((f) => f.verified === true && f.source === "upload"));
  assert.equal((await profilePOST(req("profile?batch=1", JSON.stringify({ confirmed: true, facts: [{ kind: "salary", text: "x" }] })))).status, 400);
});

test("build turns entered roles, skills, and education into facts", () => {
  const facts = factsFromEntry({
    roles: [{ org: "Northfield", title: "Lead Designer", dates: "2019 - present", results: ["Cut review rounds from 3 to 2."] }],
    skills: [{ group: "Tools", items: ["Canvas", "Moodle"] }],
    education: [{ text: "MEd", dates: "2010" }],
  });
  assert.deepEqual(facts.map((f) => f.kind), ["role", "result", "skill", "skill", "education"]);
  assert.equal(facts[0].text, "Lead Designer, Northfield (2019 - present)");
});

test("build needs a name, a role, and the accuracy confirmation", async () => {
  const body = (b) => JSON.stringify(b);
  assert.equal((await buildPOST(req("build", body({ name: "J", roles: [{ org: "A", title: "B" }] })))).status, 400);
  assert.equal((await buildPOST(req("build", body({ confirmed: true, roles: [{ org: "A", title: "B" }] })))).status, 400);
  assert.equal((await buildPOST(req("build", body({ confirmed: true, name: "J", roles: [] })))).status, 400);
});

test("extraction schema is strict", () => {
  const walk = (s) => {
    if (s.type === "object") { assert.equal(s.additionalProperties, false); assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort()); Object.values(s.properties).forEach(walk); }
    if (s.type === "array") walk(s.items);
  };
  walk(EXTRACT_SCHEMA);
});
