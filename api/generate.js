// POST /api/generate?job=12&kind=resume|letter
//
// Writes a tailored resume or cover letter for a saved job from the owner's
// confirmed facts and base resume, checks it, and saves it as a draft.
// Problems found by the checks are returned for the owner to fix in the
// editor; nothing is silently rewritten.
import { handle, json, requireOwner, rest, restWrite, idParam, v, HttpError } from "./_lib/supabase.js";
import { generate } from "./_lib/ai/index.js";
import { withBudget } from "./_lib/limits.js";
import { profileContext, RESUME_SYSTEM, LETTER_SYSTEM, RESUME_SCHEMA, LETTER_SCHEMA, writerContent } from "./_lib/prompts.js";
import { evidenceNumbers, checkDraft, undash } from "./_lib/guard.js";
import { dedupeSkills, linksFromPrefs } from "../public/js/doc.js";

// Removes dashes from every string in the draft before any check runs.
export function undashAll(value) {
  if (typeof value === "string") return undash(value);
  if (Array.isArray(value)) return value.map(undashAll);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, x]) => [k, undashAll(x)]));
  return value;
}

const fileSafe = (s) => String(s || "").replace(/[^A-Za-z0-9]+/g, "").slice(0, 40) || "Document";

async function baseResumePdf(session) {
  const [doc] = await rest(session, "documents?select=file_path&source=eq.uploaded&kind=eq.resume&job_id=is.null&file_path=not.is.null&order=created_at.desc&limit=1");
  if (!doc) throw new HttpError(400, "Upload your base resume first. The generator copies its format, dates, and header.");
  const path = doc.file_path.split("/").map(encodeURIComponent).join("/");
  const res = await fetch(`${session.cfg.url}/storage/v1/object/authenticated/docs/${path}`, {
    headers: { apikey: session.cfg.anonKey, Authorization: `Bearer ${session.token}` },
  });
  if (!res.ok) throw new HttpError(502, "Could not read your base resume file.");
  return Buffer.from(await res.arrayBuffer()).toString("base64");
}

export const POST = handle(async (request) => {
  const session = await requireOwner(request);
  const jobId = idParam(request, "job");
  const kind = v.oneOf(new URL(request.url).searchParams.get("kind"), "Kind", ["resume", "letter"]);

  const [job] = await rest(session, `jobs?id=eq.${jobId}&select=company,role_title,jd_text,strengths,gaps`);
  if (!job) throw new HttpError(404, "Job not found.");
  if (!job.jd_text) throw new HttpError(400, "This job has no posting text. Add the posting first.");

  const [facts, pdf] = await Promise.all([
    rest(session, "profile_facts?select=kind,group_title,text,url,verified&verified=is.true&order=kind,group_title,position"),
    baseResumePdf(session),
  ]);
  if (!facts.length) throw new HttpError(400, "Your profile has no confirmed facts yet.");

  const today = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Phoenix" });
  const clean = (s) => String(s).replace(/["<>]/g, "");
  const content = [
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf }, title: "Base resume", cache_control: { type: "ephemeral" } },
    { type: "text", text: writerContent({ kind, posting: job.jd_text, company: clean(job.company), role: clean(job.role_title), strengths: job.strengths, gaps: job.gaps, today }) },
  ];

  const { data, meta } = await withBudget(session, () =>
    generate({
      task: "writer",
      system: kind === "letter" ? LETTER_SYSTEM : RESUME_SYSTEM,
      cachedContext: profileContext(facts),
      content,
      schema: kind === "letter" ? LETTER_SCHEMA : RESUME_SCHEMA,
    }),
  );

  const draft = undashAll(data);
  // Links come from the owner's profile, never from the model; skills appear once.
  const [prefRow] = await rest(session, "profile_prefs?select=linkedin_url,portfolio_url,website_url");
  draft.links = linksFromPrefs(prefRow);
  if (draft.skills) draft.skills = dedupeSkills(draft.skills);
  const flags = checkDraft(kind, draft, evidenceNumbers(...facts.map((f) => f.text)));
  const label = kind === "letter" ? "Cover letter" : "Resume";
  const name = fileSafe((draft.name || "").split(/\s+/).map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join("_"));
  const [saved] = await restWrite(session, "POST", "documents?select=id,job_id,kind,source,title,file_name,sent,created_at", {
    job_id: jobId, kind, source: "generated",
    title: `${label} · ${job.company}`,
    file_name: `${name}_${fileSafe(job.company)}${kind === "letter" ? "_CoverLetter" : ""}.pdf`,
    content: draft,
  });
  return json(201, { document: saved, flags, cost: Number(meta.cost.toFixed(4)) });
});
