// GET /api/jobs          -> { meta, jobs: [list items] }
// GET /api/jobs?id=123   -> application detail
//
// Shapes match the demo fixture so the UI treats both sources the same.
import { handle, json, requireOwner, rest, HttpError } from "./_lib/supabase.js";

export const SENT = ["APPLIED", "EMAILED", "INTERVIEWING", "OFFER", "EMPLOYER_REJECTED"];

export function toListItem(row) {
  return {
    id: row.id,
    company: row.company,
    role_title: row.role_title,
    location: row.location,
    status: row.status,
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
    status: row.status,
    jd_text: row.jd_text,
    strengths: row.strengths || [],
    gaps: row.gaps || [],
    answers: [...(row.application_answers || [])]
      .sort((a, b) => a.position - b.position)
      .map(({ question, answer }) => ({ question, answer })),
    history: [...(row.status_history || [])]
      .sort((a, b) => String(a.changed_at).localeCompare(String(b.changed_at)))
      .map((h) => ({ status: h.status, at: h.changed_at })),
    coach: null, // live coach arrives in Phase 4
  };
}

export const GET = handle(async (request) => {
  const session = await requireOwner(request);
  const idParam = new URL(request.url).searchParams.get("id");

  if (idParam !== null) {
    const id = Number(idParam);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "Invalid id.");
    const rows = await rest(session,
      `jobs?id=eq.${id}&select=id,company,role_title,status,jd_text,strengths,gaps,` +
      `application_answers(position,question,answer),status_history(status,changed_at)`);
    if (!rows.length) throw new HttpError(404, "Not found.");
    return json(200, toDetail(rows[0]));
  }

  const rows = await rest(session,
    `jobs?status=in.(${SENT.join(",")})&order=applied_on.desc.nullsfirst&select=` +
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
