import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { POST as answerPOST, trimToLimit } from "../api/answer.js";
import { ANSWER_SCHEMA, answerContent } from "../api/_lib/prompts.js";

const realFetch = globalThis.fetch;
const ENV = { SUPABASE_URL: "https://ref.supabase.co", SUPABASE_ANON_KEY: "anon", ALLOWED_EMAIL: "owner@example.com", ANTHROPIC_API_KEY: "test-key" };
let aiReplies, aiCalls, writes;

// Fake Supabase plus a fake Claude that returns queued answers in order.
function fake() {
  aiCalls = 0;
  writes = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("api.anthropic.com")) {
      const answer = aiReplies[aiCalls++];
      return Response.json({
        id: `msg_${aiCalls}`, type: "message", role: "assistant", model: "claude-sonnet-5-5",
        content: [{ type: "text", text: JSON.stringify(answer) }], stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 1000, output_tokens: 200 },
      });
    }
    if (u.endsWith("/auth/v1/user")) return Response.json({ id: "u1", email: "owner@example.com" });
    if (u.includes("/rpc/record_ai_usage")) return new Response(null, { status: 204 });
    if (u.includes("/rest/v1/ai_usage")) return Response.json([]);
    if (u.includes("/rest/v1/jobs")) return Response.json([{ company: "Acme", role_title: "PM", jd_text: "Lead 3 programs.", application_answers: [{ count: 0 }] }]);
    if (u.includes("/rest/v1/profile_facts")) return Response.json([{ kind: "result", group_title: "SDI", text: "Saved roughly 20 hours each week", verified: true }]);
    if (init.method === "POST" || init.method === "PATCH") {
      const body = JSON.parse(init.body);
      writes.push(body);
      return Response.json([{ id: 7, ...body }]);
    }
    return Response.json([]);
  };
}

const req = (body) => new Request("http://x/api/answer?job=1", { method: "POST", headers: { Authorization: "Bearer t", "Content-Type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => { Object.assign(process.env, ENV); fake(); });
afterEach(() => { globalThis.fetch = realFetch; for (const k of Object.keys(ENV)) delete process.env[k]; });

test("an over-limit draft is sent back to be shortened", async () => {
  aiReplies = [
    { answer: "x".repeat(400), needs_owner: false, note: "" },
    { answer: "I saved my team roughly 20 hours each week by centralizing content.", needs_owner: false, note: "" },
  ];
  const res = await answerPOST(req({ question: "Why you?", char_limit: 120 }));
  const out = await res.json();
  assert.equal(res.status, 201);
  assert.equal(aiCalls, 2);
  assert.ok(out.answer.answer.length <= 120);
  assert.deepEqual(out.flags, []);
});

test("if shortening fails twice, the app trims it and says so", async () => {
  const long = "I saved my team roughly 20 hours each week. ".repeat(10);
  aiReplies = [1, 2, 3].map(() => ({ answer: long, needs_owner: false, note: "" }));
  const out = await (await answerPOST(req({ question: "Why you?", char_limit: 100 }))).json();
  assert.equal(aiCalls, 3);
  assert.ok(out.answer.answer.length <= 100);
  assert.ok(out.answer.answer.endsWith("."));
  assert.ok(out.flags.some((f) => f.kind === "length"));
});

test("salary and personal questions are handed back to the owner", async () => {
  aiReplies = [{ answer: "", needs_owner: true, note: "Enter your expected salary yourself." }];
  const out = await (await answerPOST(req({ question: "What are your salary expectations?" }))).json();
  assert.equal(out.answer.answer, "");
  assert.equal(out.flags[0].kind, "owner");
  assert.match(out.flags[0].message, /salary/);
});

test("invented numbers in an answer are flagged", async () => {
  aiReplies = [{ answer: "I grew enrollment 45% and saved 20 hours each week.", needs_owner: false, note: "" }];
  const out = await (await answerPOST(req({ question: "Impact?" }))).json();
  assert.deepEqual(out.flags.map((f) => f.value), ["45"]);
});

test("limits must be sensible and the schema strict", async () => {
  assert.equal((await answerPOST(req({ question: "Why?", char_limit: 10 }))).status, 400);
  assert.equal((await answerPOST(req({ char_limit: 200 }))).status, 400);
  assert.equal(ANSWER_SCHEMA.additionalProperties, false);
  assert.match(answerContent({ question: "Q", limit: 300 }), /300 characters or fewer/);
  assert.equal(trimToLimit("Short.", 100), "Short.");
});
