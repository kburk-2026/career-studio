// POST   /api/answers          -> add a question (and optional answer) to a job
// PATCH  /api/answers?id=12    -> edit the question/answer, or mark it final
// DELETE /api/answers?id=12    -> remove a question
import { handle, json, requireOwner, rest, restWrite, readJson, idParam, v, HttpError } from "./_lib/supabase.js";

const LIMITS = { question: 2000, answer: 20_000 };

export const POST = handle(async (request) => {
  const session = await requireOwner(request);
  const body = await readJson(request);
  const jobId = v.int(body.job_id, "Job", { min: 1 });
  if (!jobId) throw new HttpError(400, "Job is required.");
  // Confirms the job exists and belongs to this user (RLS hides others').
  const [job] = await rest(session, `jobs?id=eq.${jobId}&select=id,application_answers(count)`);
  if (!job) throw new HttpError(404, "Job not found.");
  const row = {
    job_id: jobId,
    position: (job.application_answers?.[0]?.count ?? 0) + 1,
    question: v.text(body.question, "Question", { max: LIMITS.question, required: true }),
    answer: v.text(body.answer, "Answer", { max: LIMITS.answer }) ?? "",
    char_limit: v.int(body.char_limit, "Character limit", { min: 1, max: 100_000 }),
    final: false,
  };
  const [saved] = await restWrite(session, "POST", "application_answers?select=id,position,question,answer,char_limit,final", row);
  return json(201, saved);
});

export const PATCH = handle(async (request) => {
  const session = await requireOwner(request);
  const id = idParam(request);
  const body = await readJson(request);
  const row = {};
  if ("question" in body) row.question = v.text(body.question, "Question", { max: LIMITS.question, required: true });
  if ("answer" in body) row.answer = v.text(body.answer, "Answer", { max: LIMITS.answer }) ?? "";
  if ("char_limit" in body) row.char_limit = v.int(body.char_limit, "Character limit", { min: 1, max: 100_000 });
  if ("final" in body) row.final = v.bool(body.final, "Final");
  // Changing the text means it is no longer the submitted version.
  if (("answer" in row || "question" in row) && !("final" in row)) row.final = false;
  if (!Object.keys(row).length) throw new HttpError(400, "Nothing to change.");
  const saved = await restWrite(session, "PATCH", `application_answers?id=eq.${id}&select=id,question,answer,char_limit,final`, row);
  if (!saved.length) throw new HttpError(404, "Not found.");
  return json(200, saved[0]);
});

export const DELETE = handle(async (request) => {
  const session = await requireOwner(request);
  const id = idParam(request);
  const gone = await restWrite(session, "DELETE", `application_answers?id=eq.${id}&select=id`);
  if (!gone.length) throw new HttpError(404, "Not found.");
  return json(200, { deleted: id });
});
