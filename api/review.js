// POST /api/review            { text } or { url }  -> review of a new posting (not saved)
// POST /api/review?job=12     -> review the posting already saved on job 12, and save the result
//
// The model scores six rubric dimensions; the fit score, screening odds, and
// preference match are computed here in code.
import { handle, json, requireOwner, rest, restWrite, readJson, idParam, v, HttpError } from "./_lib/supabase.js";
import { generate } from "./_lib/ai/index.js";
import { withBudget } from "./_lib/limits.js";
import { fetchPosting } from "./_lib/fetch_posting.js";
import { profileContext, REVIEW_SYSTEM, REVIEW_SCHEMA, reviewContent } from "./_lib/prompts.js";
import { preferenceMatch } from "./_lib/prefmatch.js";
import { checkText, evidenceNumbers, undash } from "./_lib/guard.js";
import { fitFromBreakdown, RUBRIC } from "../public/js/format.js";

const SCREENING_PENALTY = { standard: 0, selective: 8, highly_selective: 15 };

export function scoreReview(ai, prefs, facts, posting) {
  const breakdown = Object.fromEntries(RUBRIC.map(([k]) => [k, ai.scores[k].score]));
  const reasons = Object.fromEntries(RUBRIC.map(([k]) => [k, undash(ai.scores[k].reason)]));
  const fit = fitFromBreakdown(breakdown);
  const odds = Math.max(0, fit - (SCREENING_PENALTY[ai.screening] ?? 0));
  const strengths = ai.strengths.map(undash).slice(0, 6);
  const gaps = ai.gaps.map(undash).slice(0, 6);

  // Any number the model used must come from the profile or the posting.
  // Preferences (like a salary minimum) are the owner's own numbers too.
  const evidence = evidenceNumbers(posting, ...facts.filter((f) => f.verified).map((f) => f.text), ...Object.values(prefs).filter((x) => x != null).map(String));
  const flags = [...strengths, ...gaps, ai.summary].flatMap((t) => checkText(t, evidence).filter((i) => i.kind === "number"));

  return {
    company: ai.company,
    role_title: ai.role_title,
    location: ai.posting_facts.location,
    fit_score: fit,
    odds_score: odds,
    fit_breakdown: { ...breakdown, reasons, screening: ai.screening },
    pref_match: preferenceMatch(prefs, ai.posting_facts),
    posting_facts: ai.posting_facts,
    strengths,
    gaps,
    requirements: ai.requirements.map((r) => ({ ...r, requirement: undash(r.requirement), evidence: undash(r.evidence) })),
    summary: undash(ai.summary),
    flags,
  };
}

export const POST = handle(async (request) => {
  const session = await requireOwner(request);
  const params = new URL(request.url).searchParams;
  const body = await readJson(request, 128 * 1024);

  let posting;
  let sourceUrl = null;
  let jobId = null;
  if (params.has("job")) {
    jobId = idParam(request, "job");
    const [job] = await rest(session, `jobs?id=eq.${jobId}&select=jd_text,source_url`);
    if (!job) throw new HttpError(404, "Job not found.");
    posting = job.jd_text;
    if (!posting && job.source_url) ({ text: posting } = await fetchPosting(job.source_url));
    if (!posting) throw new HttpError(400, "This job has no posting text to review. Add it first.");
  } else if (body.url) {
    const url = v.text(body.url, "Link", { max: 2000 });
    ({ text: posting, finalUrl: sourceUrl } = await fetchPosting(url));
  } else {
    posting = v.text(body.text, "Posting", { max: 60_000, required: true });
    if (posting.length < 200) throw new HttpError(400, "That posting looks too short. Paste the full description.");
  }

  const [facts, prefRows] = await Promise.all([
    rest(session, "profile_facts?select=kind,group_title,text,url,verified&verified=is.true&order=kind,group_title,position"),
    rest(session, "profile_prefs?select=*"),
  ]);
  const { user_id, updated_at, ...prefs } = prefRows[0] || {};
  if (!facts.length) throw new HttpError(400, "Your profile has no confirmed facts yet. Add and confirm some first.");

  const { data } = await withBudget(session, () =>
    generate({ task: "analyst", system: REVIEW_SYSTEM, cachedContext: profileContext(facts, prefs), content: reviewContent(posting), schema: REVIEW_SCHEMA }),
  );
  const review = scoreReview(data, prefs, facts, posting);

  if (jobId) {
    await restWrite(session, "PATCH", `jobs?id=eq.${jobId}&select=id`, {
      fit_score: review.fit_score, odds_score: review.odds_score, fit_breakdown: review.fit_breakdown,
      pref_match: review.pref_match, posting_facts: review.posting_facts, strengths: review.strengths, gaps: review.gaps,
    });
  }
  return json(200, { ...review, jd_text: posting, source_url: sourceUrl, saved_to: jobId });
});
