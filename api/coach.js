// GET    /api/coach?job=12                           -> latest session for the job, with its turns
// POST   /api/coach?job=12&action=start              -> new session: prep plus the first question
// POST   /api/coach?session=ID&action=answer {answer} -> feedback, stronger answer, follow-up
// POST   /api/coach?session=ID&action=next           -> next main question
// POST   /api/coach?session=ID&action=end            -> end the session
// DELETE /api/coach?session=ID                       -> delete the session and its turns
//
// Turn order is enforced by machine.js and by conditional updates (the state
// must still be what we read), so a double click or a second tab gets a 409
// instead of a skipped question.
import { handle, json, requireOwner, rest, restWrite, readJson, idParam, v, HttpError } from "./_lib/supabase.js";
import { generate } from "./_lib/ai/index.js";
import { withBudget } from "./_lib/limits.js";
import { transition, oneQuestion, MAX_MAIN } from "./_lib/coach/machine.js";
import {
  profileContext, coachJobContext, coachAnswerContent, coachNextContent,
  COACH_START_SYSTEM, COACH_START_SCHEMA, COACH_ANSWER_SYSTEM, COACH_ANSWER_SCHEMA, COACH_NEXT_SYSTEM, COACH_NEXT_SCHEMA,
} from "./_lib/prompts.js";
import { checkText, evidenceNumbers, undash } from "./_lib/guard.js";
import { undashAll } from "./generate.js";

const TURN = "id,position,kind,question,answer,critique,improved_answer,guard_flags,answered_at";
const SESSION = "id,job_id,state,prep,main_count,created_at";
const uuid = (s) => (/^[0-9a-f-]{36}$/i.test(s || "") ? s : null);

async function loadJob(session, jobId) {
  const [job] = await rest(session, `jobs?id=eq.${jobId}&select=id,company,role_title,jd_text`);
  if (!job) throw new HttpError(404, "Job not found.");
  return job;
}
const loadFacts = (session) => rest(session, "profile_facts?select=kind,group_title,text,url,verified&verified=is.true&order=kind,group_title,position");

async function loadSession(session, request) {
  const id = uuid(new URL(request.url).searchParams.get("session"));
  if (!id) throw new HttpError(400, "Invalid session.");
  const [s] = await rest(session, `coach_sessions?id=eq.${id}&select=${SESSION}`);
  if (!s) throw new HttpError(404, "Session not found.");
  return s;
}

// Moves the session only if nobody else moved it first.
async function move(session, s, to, extra = {}) {
  const rows = await restWrite(session, "PATCH", `coach_sessions?id=eq.${s.id}&state=eq.${s.state}&select=${SESSION}`, { state: to, ...extra });
  if (!rows.length) throw new HttpError(409, "This session changed in another window. Reload to continue.");
  return rows[0];
}

const ai = (session, args) => withBudget(session, () => generate({ task: "analyst", ...args }));

export const GET = handle(async (request) => {
  const session = await requireOwner(request);
  const jobId = idParam(request, "job");
  const [s] = await rest(session, `coach_sessions?job_id=eq.${jobId}&select=${SESSION}&order=created_at.desc&limit=1`);
  if (!s) return json(200, { session: null, turns: [], max_main: MAX_MAIN });
  const turns = await rest(session, `coach_turns?session_id=eq.${s.id}&select=${TURN}&order=position`);
  return json(200, { session: s, turns, max_main: MAX_MAIN });
});

export const POST = handle(async (request) => {
  const session = await requireOwner(request);
  const action = new URL(request.url).searchParams.get("action");

  if (action === "start") {
    const job = await loadJob(session, idParam(request, "job"));
    const facts = await loadFacts(session);
    if (!facts.length) throw new HttpError(400, "Your profile has no confirmed facts yet.");
    const { data } = await ai(session, {
      system: COACH_START_SYSTEM, cachedContext: profileContext(facts), schema: COACH_START_SCHEMA,
      content: `${coachJobContext(job)}\n\nPrepare the candidate and ask the first question.`,
    });
    const prep = undashAll({ priorities: data.priorities, concern: data.concern, stories: data.stories });
    const [s] = await restWrite(session, "POST", `coach_sessions?select=${SESSION}`, { job_id: job.id, state: "AWAIT_ANSWER", prep, main_count: 1 });
    const [turn] = await restWrite(session, "POST", `coach_turns?select=${TURN}`, { session_id: s.id, position: 1, kind: "main", question: oneQuestion(undash(data.first_question)) });
    return json(201, { session: s, turns: [turn], max_main: MAX_MAIN });
  }

  const s = await loadSession(session, request);
  const turns = await rest(session, `coach_turns?session_id=eq.${s.id}&select=${TURN}&order=position`);
  const job = await loadJob(session, s.job_id);

  if (action === "answer") {
    const answer = v.text((await readJson(request)).answer, "Answer", { max: 8000, required: true });
    const open = turns.filter((t) => !t.answered_at).pop();
    if (!open || !["AWAIT_ANSWER", "AWAIT_FOLLOWUP"].includes(s.state)) transition(s.state, "answer"); // throws the right 409
    if (!open) throw new HttpError(409, "No question is waiting for an answer.");
    const facts = await loadFacts(session);
    const { data } = await ai(session, { system: COACH_ANSWER_SYSTEM, cachedContext: profileContext(facts), schema: COACH_ANSWER_SCHEMA, content: coachAnswerContent(job, open, answer) });
    const fb = undashAll(data);
    const followUp = open.kind === "main" ? oneQuestion(fb.follow_up) : "";
    const flags = checkText(fb.improved_answer, evidenceNumbers(...facts.map((f) => f.text), answer, job.jd_text || ""));
    const to = transition(s.state, "answer", { hasFollowUp: Boolean(followUp), mainCount: s.main_count });
    const moved = await move(session, s, to);
    const [answered] = await restWrite(session, "PATCH", `coach_turns?id=eq.${open.id}&select=${TURN}`, {
      answer, answered_at: new Date().toISOString(), improved_answer: fb.improved_answer, guard_flags: flags,
      critique: { score: fb.score, worked: fb.worked, improve: fb.improve, new_facts: fb.new_facts },
    });
    const out = turns.map((t) => (t.id === answered.id ? answered : t));
    if (followUp && to === "AWAIT_FOLLOWUP") {
      const [f] = await restWrite(session, "POST", `coach_turns?select=${TURN}`, { session_id: s.id, position: turns.length + 1, kind: "followup", question: followUp });
      out.push(f);
    }
    return json(200, { session: moved, turns: out, max_main: MAX_MAIN });
  }

  if (action === "next") {
    transition(s.state, "next", { mainCount: s.main_count }); // throws the right 409 before spending anything
    const facts = await loadFacts(session);
    const asked = turns.map((t) => t.question);
    const { data } = await ai(session, { system: COACH_NEXT_SYSTEM, cachedContext: profileContext(facts), schema: COACH_NEXT_SCHEMA, content: coachNextContent(job, s.prep, asked) });
    const moved = await move(session, s, "AWAIT_ANSWER", { main_count: s.main_count + 1 });
    const [turn] = await restWrite(session, "POST", `coach_turns?select=${TURN}`, { session_id: s.id, position: turns.length + 1, kind: "main", question: oneQuestion(undash(data.question)) });
    return json(200, { session: moved, turns: [...turns, turn], max_main: MAX_MAIN });
  }

  if (action === "end") {
    const moved = s.state === "DONE" ? s : await move(session, s, "DONE");
    return json(200, { session: moved, turns, max_main: MAX_MAIN });
  }

  throw new HttpError(400, "Unknown action.");
});

export const DELETE = handle(async (request) => {
  const session = await requireOwner(request);
  const s = await loadSession(session, request);
  await restWrite(session, "DELETE", `coach_sessions?id=eq.${s.id}&select=id`);
  return json(200, { deleted: s.id });
});
