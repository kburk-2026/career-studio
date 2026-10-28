// POST /api/answer?job=12   { question, char_limit }    -> drafts and saves a new answer
// POST /api/answer?id=34                                -> redrafts an existing answer
//
// The character limit is enforced here, not trusted to the model: an
// over-limit draft is sent back to be shortened (twice at most), and as a last
// resort trimmed at a sentence boundary and flagged.
import { handle, json, requireOwner, rest, restWrite, readJson, idParam, v, HttpError } from "./_lib/supabase.js";
import { generate } from "./_lib/ai/index.js";
import { withBudget } from "./_lib/limits.js";
import { profileContext, ANSWER_SYSTEM, ANSWER_SCHEMA, answerContent } from "./_lib/prompts.js";
import { checkText, evidenceNumbers, undash } from "./_lib/guard.js";

const MAX_SHORTEN = 2;

// Cuts to the last full sentence that fits; falls back to the last whole word.
export function trimToLimit(text, limit) {
  if (!limit || text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "), cut.endsWith(".") ? cut.length - 1 : -1);
  if (end > limit * 0.5) return cut.slice(0, end + 1).trim();
  return cut.replace(/\s+\S*$/, "").replace(/[,;:]$/, "").trim() + ".";
}

export const POST = handle(async (request) => {
  const session = await requireOwner(request);
  const params = new URL(request.url).searchParams;
  const body = await readJson(request);

  let answerId = null;
  let jobId;
  let question;
  let limit;
  if (params.has("id")) {
    answerId = idParam(request);
    const [a] = await rest(session, `application_answers?id=eq.${answerId}&select=job_id,question,char_limit`);
    if (!a) throw new HttpError(404, "Answer not found.");
    ({ job_id: jobId, question, char_limit: limit } = a);
  } else {
    jobId = idParam(request, "job");
    question = v.text(body.question, "Question", { max: 2000, required: true });
    limit = v.int(body.char_limit, "Character limit", { min: 50, max: 100_000 });
  }

  const [[job], facts] = await Promise.all([
    rest(session, `jobs?id=eq.${jobId}&select=company,role_title,jd_text,application_answers(count)`),
    rest(session, "profile_facts?select=kind,group_title,text,verified&verified=is.true&order=kind,group_title,position"),
  ]);
  if (!job) throw new HttpError(404, "Job not found.");
  if (!facts.length) throw new HttpError(400, "Your profile has no confirmed facts yet.");

  const clean = (s) => String(s).replace(/["<>]/g, "");
  const ask = (previous) =>
    withBudget(session, () => generate({
      task: "analyst", system: ANSWER_SYSTEM, cachedContext: profileContext(facts), schema: ANSWER_SCHEMA,
      content: answerContent({ posting: job.jd_text, company: clean(job.company), role: clean(job.role_title), question, limit, previous }),
    }));

  let { data } = await ask();
  let text = undash(data.answer).trim();
  for (let i = 0; i < MAX_SHORTEN && limit && text.length > limit && !data.needs_owner; i++) {
    ({ data } = await ask(text));
    text = undash(data.answer).trim();
  }
  const flags = checkText(text, evidenceNumbers(...facts.map((f) => f.text), job.jd_text || ""));
  if (limit && text.length > limit) {
    text = trimToLimit(text, limit);
    flags.push({ kind: "length", message: "The draft ran long and was trimmed to fit. Read the ending." });
  }
  if (data.needs_owner) flags.push({ kind: "owner", message: data.note || "This question needs your own answer." });

  const fields = { answer: data.needs_owner ? "" : text, final: false };
  const [saved] = answerId
    ? await restWrite(session, "PATCH", `application_answers?id=eq.${answerId}&select=id,question,answer,char_limit,final`, fields)
    : await restWrite(session, "POST", "application_answers?select=id,question,answer,char_limit,final", {
        job_id: jobId, position: (job.application_answers?.[0]?.count ?? 0) + 1, question, char_limit: limit, ...fields,
      });
  return json(answerId ? 200 : 201, { answer: saved, flags });
});
