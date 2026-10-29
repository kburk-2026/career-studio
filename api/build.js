// POST /api/build  { name, contact, roles: [{ org, title, dates, results: [] }],
//                    skills: [{ group, items: [] }], education: [{ text, dates }], confirmed: true }
//   -> { document, flags, facts_added }
//
// For someone starting without a resume: what they enter (and confirm as
// accurate) is saved to the profile, then a general resume is built from the
// confirmed profile only.
import { handle, json, requireOwner, rest, restWrite, readJson, v, HttpError } from "./_lib/supabase.js";
import { generate } from "./_lib/ai/index.js";
import { withBudget } from "./_lib/limits.js";
import { profileContext, BUILD_SYSTEM, RESUME_SCHEMA, buildContent } from "./_lib/prompts.js";
import { evidenceNumbers, checkDraft } from "./_lib/guard.js";
import { dedupeSkills, linksFromPrefs } from "../public/js/doc.js";
import { undashAll } from "./generate.js";

const list = (x, field, max) => {
  if (x === undefined) return [];
  if (!Array.isArray(x) || x.length > max) throw new HttpError(400, `${field} must be a list of at most ${max}.`);
  return x;
};

export function factsFromEntry(body) {
  const facts = [];
  for (const r of list(body.roles, "Roles", 20)) {
    const org = v.text(r.org, "Employer", { max: 120, required: true });
    const title = v.text(r.title, "Title", { max: 120, required: true });
    const dates = v.text(r.dates, "Dates", { max: 60 }) || "";
    facts.push({ kind: "role", group_title: org, text: `${title}, ${org}${dates ? ` (${dates})` : ""}` });
    for (const t of list(r.results, "Results", 20)) facts.push({ kind: "result", group_title: org, text: v.text(t, "Result", { max: 1000, required: true }) });
  }
  for (const s of list(body.skills, "Skills", 20)) {
    const group = v.text(s.group, "Skill group", { max: 120 }) || "Skills";
    for (const t of list(s.items, "Skill items", 60)) facts.push({ kind: "skill", group_title: group, text: v.text(t, "Skill", { max: 300, required: true }) });
  }
  for (const e of list(body.education, "Education", 10)) {
    const text = v.text(e.text, "Education", { max: 300, required: true });
    const dates = v.text(e.dates, "Dates", { max: 60 });
    facts.push({ kind: "education", group_title: "Education", text: dates ? `${text} (${dates})` : text });
  }
  return facts;
}

export const POST = handle(async (request) => {
  const session = await requireOwner(request);
  const body = await readJson(request);
  if (body.confirmed !== true) throw new HttpError(400, "Confirm that what you entered is accurate first.");
  const header = {
    name: v.text(body.name, "Name", { max: 120, required: true }),
    contact: v.text(body.contact, "Contact line", { max: 300 }) || "",
  };
  const entered = factsFromEntry(body);
  if (!entered.some((f) => f.kind === "role")) throw new HttpError(400, "Add at least one role.");

  await restWrite(session, "POST", "profile_facts?select=id", entered.map((f, i) => ({ ...f, position: 300 + i, verified: true, source: "app" })));
  const facts = await rest(session, "profile_facts?select=kind,group_title,text,url,verified&verified=is.true&order=kind,group_title,position");

  const { data } = await withBudget(session, () =>
    generate({ task: "writer", system: BUILD_SYSTEM, cachedContext: profileContext(facts), content: buildContent(header), schema: RESUME_SCHEMA }),
  );
  const draft = undashAll(data);
  // Links come from the owner's profile, never from the model; skills appear once.
  const [prefRow] = await rest(session, "profile_prefs?select=linkedin_url,portfolio_url,website_url");
  draft.links = linksFromPrefs(prefRow);
  if (draft.skills) draft.skills = dedupeSkills(draft.skills);
  const flags = checkDraft("resume", draft, evidenceNumbers(...facts.map((f) => f.text)));
  const fileName = `${header.name.replace(/[^A-Za-z0-9]+/g, "_")}_Resume.pdf`;
  const [document] = await restWrite(session, "POST", "documents?select=id,kind,source,title,file_name,created_at", {
    job_id: null, kind: "resume", source: "built", title: "Resume built from your skills", file_name: fileName, content: draft,
  });
  return json(201, { document, flags, facts_added: entered.length });
});
