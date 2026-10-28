import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { transition, oneQuestion, MAX_MAIN } from "../api/_lib/coach/machine.js";
import { GET as coachGET, POST as coachPOST } from "../api/coach.js";

test("the turn order is enforced", () => {
  assert.equal(transition("AWAIT_ANSWER", "answer", { hasFollowUp: true, mainCount: 1 }), "AWAIT_FOLLOWUP");
  assert.equal(transition("AWAIT_FOLLOWUP", "answer", { mainCount: 1 }), "ASK_MAIN");
  assert.equal(transition("ASK_MAIN", "next", { mainCount: 1 }), "AWAIT_ANSWER");
  assert.equal(transition("AWAIT_FOLLOWUP", "answer", { mainCount: MAX_MAIN }), "DONE");
  assert.equal(transition("AWAIT_ANSWER", "end"), "DONE");
  assert.throws(() => transition("AWAIT_ANSWER", "next"), /Answer the current question first/);
  assert.throws(() => transition("AWAIT_FOLLOWUP", "next"), /Answer the follow-up question first/);
  assert.throws(() => transition("ASK_MAIN", "answer"), /Ask for the next question first/);
  assert.throws(() => transition("ASK_MAIN", "next", { mainCount: MAX_MAIN }), /last of 6/);
});

test("one question per turn", () => {
  assert.equal(oneQuestion("Tell me about X. How did you measure it? And what would you change?"), "Tell me about X. How did you measure it?");
  assert.equal(oneQuestion("Walk me through your approach."), "Walk me through your approach.");
});

// Fake Supabase holding one session, plus a fake Claude.
const realFetch = globalThis.fetch;
const ENV = { SUPABASE_URL: "https://ref.supabase.co", SUPABASE_ANON_KEY: "anon", ALLOWED_EMAIL: "owner@example.com", ANTHROPIC_API_KEY: "k" };
const SID = "11111111-2222-3333-4444-555555555555";
let db, aiCalls;

function fake(aiReply) {
  aiCalls = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = decodeURIComponent(String(url));
    const m = init.method || "GET";
    if (u.endsWith("/auth/v1/user")) return Response.json({ id: "u1", email: "owner@example.com" });
    if (u.includes("api.anthropic.com")) {
      aiCalls++;
      return Response.json({ id: "m", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: JSON.stringify(aiReply) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
    }
    if (u.includes("record_ai_usage")) return new Response(null, { status: 204 });
    if (u.includes("/rest/v1/ai_usage")) return Response.json([]);
    if (u.includes("/rest/v1/jobs")) return Response.json([{ id: 1, company: "Acme", role_title: "PM", jd_text: "posting" }]);
    if (u.includes("/rest/v1/profile_facts")) return Response.json([{ kind: "result", group_title: "SDI", text: "Saved 20 hours a week", verified: true }]);
    if (u.includes("/rest/v1/coach_sessions")) {
      if (m === "PATCH") {
        const want = u.match(/state=eq\.([A-Z_]+)/)?.[1];
        if (want && want !== db.session.state) return Response.json([]);
        Object.assign(db.session, JSON.parse(init.body));
        return Response.json([db.session]);
      }
      return Response.json([db.session]);
    }
    if (u.includes("/rest/v1/coach_turns")) {
      if (m === "POST") { const t = { id: db.turns.length + 1, answered_at: null, ...JSON.parse(init.body) }; db.turns.push(t); return Response.json([t]); }
      if (m === "PATCH") { const id = Number(u.match(/id=eq\.(\d+)/)[1]); const t = db.turns.find((x) => x.id === id); Object.assign(t, JSON.parse(init.body)); return Response.json([t]); }
      return Response.json(db.turns);
    }
    return Response.json([]);
  };
}

const post = (action, body = {}) => coachPOST(new Request(`http://x/api/coach?session=${SID}&action=${action}`, { method: "POST", headers: { Authorization: "Bearer t", "Content-Type": "application/json" }, body: JSON.stringify(body) }));

beforeEach(() => {
  Object.assign(process.env, ENV);
  db = { session: { id: SID, job_id: 1, state: "AWAIT_ANSWER", prep: {}, main_count: 1 }, turns: [{ id: 1, position: 1, kind: "main", question: "Q1?", answered_at: null }] };
});
afterEach(() => { globalThis.fetch = realFetch; for (const k of Object.keys(ENV)) delete process.env[k]; });

test("asking for the next question before answering is refused without spending anything", async () => {
  fake({ question: "Q2?" });
  const res = await post("next");
  assert.equal(res.status, 409);
  assert.equal(aiCalls, 0);
});

test("an answer gets feedback and exactly one follow-up; the follow-up must be answered before moving on", async () => {
  fake({ score: 4, worked: ["clear"], improve: ["shorter"], improved_answer: "I saved 20 hours a week and grew sales 300%.", new_facts: ["Trained 12 faculty"], follow_up: "How did you measure it? Who signed off?" });
  const res = await post("answer", { answer: "I saved my team 20 hours a week by centralizing content." });
  const out = await res.json();
  assert.equal(res.status, 200);
  assert.equal(out.session.state, "AWAIT_FOLLOWUP");
  assert.equal(out.turns.at(-1).question, "How did you measure it?", "bundled questions cut to one");
  assert.deepEqual(out.turns[0].guard_flags.map((f) => f.value), ["300"], "invented number in the stronger answer is flagged");
  assert.deepEqual(out.turns[0].critique.new_facts, ["Trained 12 faculty"]);
  assert.equal((await post("next")).status, 409, "next is refused until the follow-up is answered");
});

test("a second window that already moved the session gets a 409", async () => {
  fake({ score: 3, worked: [], improve: [], improved_answer: "ok", new_facts: [], follow_up: "" });
  const realState = db.session.state;
  globalThis.fetch = ((inner) => async (url, init = {}) => {
    if (String(url).includes("coach_sessions") && init.method === "PATCH") db.session.state = "ASK_MAIN"; // someone else answered first
    return inner(url, init);
  })(globalThis.fetch);
  const res = await post("answer", { answer: "A long enough answer about my work here." });
  assert.equal(res.status, 409);
  assert.equal(realState, "AWAIT_ANSWER");
});

test("coach endpoints need the owner", async () => {
  globalThis.fetch = async () => new Response("{}", { status: 401 });
  const res = await coachGET(new Request("http://x/api/coach?job=1", { headers: { Authorization: "Bearer nope" } }));
  assert.equal(res.status, 401);
});
