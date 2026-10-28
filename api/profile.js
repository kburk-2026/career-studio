// GET /api/profile -> { source_label, groups: [{ title, items: [{ text, verified }] }] }
import { handle, json, requireOwner, rest } from "./_lib/supabase.js";

export function toGroups(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.group_title)) groups.set(r.group_title, []);
    groups.get(r.group_title).push({ text: r.text, verified: r.verified });
  }
  return [...groups].map(([title, items]) => ({ title, items }));
}

export const GET = handle(async (request) => {
  const session = await requireOwner(request);
  const rows = await rest(session, "profile_facts?select=group_title,text,verified&order=group_title,position");
  return json(200, { source_label: "your profile", groups: toGroups(rows) });
});
