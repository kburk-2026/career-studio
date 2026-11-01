// GET    /api/profile            -> { source_label, groups, facts, prefs }
// PATCH  /api/profile            -> save job preferences
// POST   /api/profile            -> add a fact (always starts unverified)
// PATCH  /api/profile?fact=12    -> confirm, or edit (an edit returns it to unverified)
// DELETE /api/profile?fact=12    -> remove a fact
import { handle, json, requireOwner, rest, restWrite, readJson, idParam, v, HttpError } from "./_lib/supabase.js";

export const KINDS = ["skill", "result", "education", "role", "summary", "publication"];

export const PREF_FIELDS = {
  target_titles: "text", level: "text", salary_min: "int", salary_target: "int", employment_type: "text",
  arrangement: "text", location: "text", industries_preferred: "text", industries_avoid: "text",
  company_size: "text", travel: "text", needs_sponsorship: "bool", earliest_start: "text", must_haves: "text",
  linkedin_url: "url", portfolio_url: "url", website_url: "url", writer_notes: "long",
};

// An optional https link, or a 400.
export function cleanUrl(value, label) {
  const u = v.text(value, label, { max: 500 });
  if (u && !/^https:\/\/[^\s]+$/i.test(u)) throw new HttpError(400, `${label} must start with https://.`);
  return u;
}

// Skills grouped for the skills card (kept for the demo-compatible shape).
export function toGroups(rows) {
  const groups = new Map();
  for (const r of rows) {
    if ((r.kind || "skill") !== "skill") continue;
    if (!groups.has(r.group_title)) groups.set(r.group_title, []);
    groups.get(r.group_title).push({ id: r.id, text: r.text, verified: r.verified });
  }
  return [...groups].map(([title, items]) => ({ title, items }));
}

export function cleanPrefs(body) {
  const out = {};
  for (const [field, type] of Object.entries(PREF_FIELDS)) {
    if (!(field in body)) continue;
    const label = field.replace(/_/g, " ");
    out[field] = type === "int" ? v.int(body[field], label, { max: 10_000_000 })
      : type === "bool" ? v.bool(body[field], label)
      : type === "url" ? cleanUrl(body[field], label)
      : type === "long" ? v.text(body[field], label, { max: 4000 })
      : v.text(body[field], label, { max: 1000 });
  }
  return out;
}

export const GET = handle(async (request) => {
  const session = await requireOwner(request);
  const [facts, prefs] = await Promise.all([
    rest(session, "profile_facts?select=id,kind,group_title,position,text,url,verified,source&order=kind,group_title,position,id"),
    rest(session, `profile_prefs?select=${Object.keys(PREF_FIELDS).join(",")}`),
  ]);
  return json(200, {
    source_label: "your profile",
    groups: toGroups(facts),
    facts: facts.map(({ id, kind, group_title, text, url, verified, source }) => ({ id, kind, group: group_title, text, url, verified, source })),
    prefs: prefs[0] || {},
  });
});

export const POST = handle(async (request) => {
  const session = await requireOwner(request);

  // ?batch=1: items the owner ticked after reading an uploaded resume or
  // entering their own. Ticking is the confirmation, so they save as verified.
  if (new URL(request.url).searchParams.get("batch") === "1") {
    const body = await readJson(request, 256 * 1024);
    if (body.confirmed !== true) throw new HttpError(400, "Confirm the items first.");
    if (!Array.isArray(body.facts) || !body.facts.length || body.facts.length > 300) throw new HttpError(400, "Send between 1 and 300 items.");
    const source = body.source === "upload" ? "upload" : "app";
    const rows = body.facts.map((f, i) => ({
      kind: v.oneOf(f.kind, "Kind", KINDS),
      group_title: v.text(f.group, "Group", { max: 120 }) || "Other",
      text: v.text(f.text, "Text", { max: 1000, required: true }),
      url: cleanUrl(f.url, "Link"),
      position: 200 + i,
      verified: true,
      source,
    }));
    const saved = await restWrite(session, "POST", "profile_facts?select=id,kind,group_title,text,url,verified,source", rows);
    return json(201, { facts: saved.map((f) => ({ ...f, group: f.group_title })) });
  }

  const body = await readJson(request);
  const row = {
    kind: v.oneOf(body.kind ?? "skill", "Kind", KINDS),
    group_title: v.text(body.group, "Group", { max: 120 }) || "Other",
    text: v.text(body.text, "Text", { max: 1000, required: true }),
    url: cleanUrl(body.url, "Link"),
    verified: false, // anything new is a claim until the owner confirms it
    source: "app",
  };
  const [saved] = await restWrite(session, "POST", "profile_facts?select=id,kind,group_title,text,url,verified,source", row);
  return json(201, { ...saved, group: saved.group_title });
});

export const PATCH = handle(async (request) => {
  const session = await requireOwner(request);
  const body = await readJson(request);

  if (!new URL(request.url).searchParams.has("fact")) {
    const prefs = cleanPrefs(body);
    if (!Object.keys(prefs).length) throw new HttpError(400, "Nothing to change.");
    const saved = await restWrite(session, "POST", "profile_prefs?on_conflict=user_id",
      { user_id: session.user.id, ...prefs }, { upsert: true });
    return json(200, saved[0] || {});
  }

  const id = idParam(request, "fact");
  const [current] = await rest(session, `profile_facts?id=eq.${id}&select=id,text,verified,history,group_title`);
  if (!current) throw new HttpError(404, "Not found.");
  const row = {};
  if ("text" in body) {
    const text = v.text(body.text, "Text", { max: 1000, required: true });
    if (text !== current.text) {
      row.text = text;
      row.verified = false;
      row.history = [...(current.history || []), { text: current.text, verified: current.verified, at: new Date().toISOString() }];
    }
  }
  if ("group" in body) row.group_title = v.text(body.group, "Group", { max: 120, required: true });
  if ("url" in body) row.url = cleanUrl(body.url, "Link");
  if ("verified" in body && !("text" in row)) row.verified = v.bool(body.verified, "Verified");
  if (!Object.keys(row).length) return json(200, { id, unchanged: true });
  const saved = await restWrite(session, "PATCH", `profile_facts?id=eq.${id}&select=id,kind,group_title,text,url,verified,source`, row);
  return json(200, { ...saved[0], group: saved[0].group_title });
});

export const DELETE = handle(async (request) => {
  const session = await requireOwner(request);
  const id = idParam(request, "fact");
  const gone = await restWrite(session, "DELETE", `profile_facts?id=eq.${id}&select=id`);
  if (!gone.length) throw new HttpError(404, "Not found.");
  return json(200, { deleted: id });
});
