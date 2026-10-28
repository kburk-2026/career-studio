// GET    /api/jobs          -> { meta, jobs: [list items] }
// GET    /api/jobs?id=123   -> application detail
// POST   /api/jobs          -> create a job (pasted posting; AI review comes in Stage B)
// PATCH  /api/jobs?id=123   -> change status or details
//
// Shapes match the demo fixture so the UI treats both sources the same.
import { handle, json, requireOwner, rest, restWrite, readJson, idParam, v, HttpError } from "./_lib/supabase.js";

export const STATUSES = ["IN_PROGRESS", "APPLIED", "INTERVIEWING", "INTERVIEW_DONE", "OFFER", "EMPLOYER_REJECTED"];

// EMAILED came from the old tracker and means the same as Applied.
const normStatus = (s) => (s === "EMAILED" ? "APPLIED" : s);

export function toListItem(row) {
  return {
    id: row.id,
    company: row.company,
    role_title: row.role_title,
    location: row.location,
    status: normStatus(row.status),
    applied_on: row.applied_on,
    fit_score: row.fit_score,
    odds_score: row.odds_score,
    answer_count: row.application_answers?.[0]?.count ?? 0,
    has_resume: Boolean(row.resume_file),
    has_cover_letter: Boolean(row.cover_letter_file),
  };
}

export function toDetail(row) {
  return {
    id: row.id,
    company: row.company,
    role_title: row.role_title,
    location: row.location,
    status: normStatus(row.status),
    applied_on: row.applied_on,
    source_url: row.source_url,
    jd_text: row.jd_text,
    fit_score: row.fit_score,
    odds_score: row.odds_score,
    fit_breakdown: row.fit_breakdown || null,
    pref_match: row.pref_match || null,
    strengths: row.strengths || [],
    gaps: row.gaps || [],
    answers: [...(row.application_answers || [])]
      .sort((a, b) => a.position - b.position)
      .map(({ id, question, answer, char_limit, final }) => ({ id, question, answer, char_limit, final })),
    history: [...(row.status_history || [])]
      .sort((a, b) => String(a.changed_at).localeCompare(String(b.changed_at)))
      .map((h) => ({ status: normStatus(h.status), at: h.changed_at })),
    coach: null, // live coach arrives after the documents work
  };
}

const today = () => new Date().toISOString().slice(0, 10);

function jobFields(body, { creating }) {
  const row = {};
  if (creating || "company" in body) row.company = v.text(body.company, "Company", { max: 200, required: true });
  if (creating || "role_title" in body) row.role_title = v.text(body.role_title, "Role", { max: 200, required: true });
  if ("location" in body) row.location = v.text(body.location, "Location", { max: 200 });
  if ("source_url" in body) {
    const url = v.text(body.source_url, "Posting link", { max: 2000 });
    if (url && !/^https:\/\//i.test(url)) throw new HttpError(400, "Posting link must start with https://.");
    row.source_url = url;
  }
  if ("jd_text" in body) row.jd_text = v.text(body.jd_text, "Job description", { max: 60_000 });
  if ("notes" in body) row.notes = v.text(body.notes, "Notes", { max: 5000 });
  if ("status" in body) row.status = v.oneOf(body.status, "Status", STATUSES);
  // Results of an AI review, saved along with a new job.
  if ("fit_score" in body) row.fit_score = v.int(body.fit_score, "Fit score", { min: 0, max: 100 });
  if ("odds_score" in body) row.odds_score = v.int(body.odds_score, "Odds score", { min: 0, max: 100 });
  for (const field of ["fit_breakdown", "posting_facts"]) {
    if (field in body) {
      if (body[field] !== null && (typeof body[field] !== "object" || Array.isArray(body[field]))) throw new HttpError(400, `${field} must be an object.`);
      row[field] = body[field];
    }
  }
  for (const field of ["strengths", "gaps", "pref_match"]) {
    if (field in body) {
      if (!Array.isArray(body[field]) || body[field].length > 20) throw new HttpError(400, `${field} must be a short list.`);
      row[field] = body[field];
    }
  }
  if ("applied_on" in body) {
    const d = v.text(body.applied_on, "Applied date", { max: 10 });
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new HttpError(400, "Applied date must be YYYY-MM-DD.");
    row.applied_on = d;
  }
  return row;
}

export const GET = handle(async (request) => {
  const session = await requireOwner(request);
  if (new URL(request.url).searchParams.has("id")) {
    const id = idParam(request);
    const rows = await rest(session,
      `jobs?id=eq.${id}&select=id,company,role_title,location,status,applied_on,source_url,jd_text,` +
      `fit_score,odds_score,fit_breakdown,pref_match,strengths,gaps,` +
      `application_answers(id,position,question,answer,char_limit,final),status_history(status,changed_at)`);
    if (!rows.length) throw new HttpError(404, "Not found.");
    return json(200, toDetail(rows[0]));
  }

  const rows = await rest(session,
    `jobs?order=applied_on.desc.nullsfirst,created_at.desc&select=` +
    `id,company,role_title,location,status,applied_on,fit_score,odds_score,resume_file,cover_letter_file,updated_at,` +
    `application_answers(count)`);
  const latest = rows.map((r) => r.updated_at).sort().pop();
  const meta = session.user.user_metadata || {};
  return json(200, {
    meta: {
      mode: "live",
      candidate: { name: meta.full_name || meta.name || "My job search" },
      email: session.user.email,
      generated_at: latest ? latest.slice(0, 10) : null,
    },
    jobs: rows.map(toListItem),
  });
});

export const POST = handle(async (request) => {
  const session = await requireOwner(request);
  const row = jobFields(await readJson(request, 128 * 1024), { creating: true });
  row.status ||= "IN_PROGRESS";
  if (row.status === "APPLIED" && !row.applied_on) row.applied_on = today();
  const [saved] = await restWrite(session, "POST", "jobs?select=id", row);
  return json(201, { id: saved.id });
});

export const PATCH = handle(async (request) => {
  const session = await requireOwner(request);
  const id = idParam(request);
  const row = jobFields(await readJson(request, 128 * 1024), { creating: false });
  if (!Object.keys(row).length) throw new HttpError(400, "Nothing to change.");
  if (row.status === "APPLIED" && !("applied_on" in row)) {
    const [current] = await rest(session, `jobs?id=eq.${id}&select=applied_on`);
    if (current && !current.applied_on) row.applied_on = today();
  }
  const saved = await restWrite(session, "PATCH", `jobs?id=eq.${id}&select=id,status,applied_on`, row);
  if (!saved.length) throw new HttpError(404, "Not found.");
  return json(200, { ...saved[0], status: normStatus(saved[0].status) });
});
