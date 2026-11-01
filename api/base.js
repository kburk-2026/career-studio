// POST /api/base  -> the owner's editable base resume, creating it on first use
//                    by copying the newest uploaded file word for word.
//
// The uploaded original stays as it is. The newest job-less resume is what the
// writer reads, so edits here shape every later resume and cover letter.
import { handle, json, requireOwner, restWrite } from "./_lib/supabase.js";
import { generate } from "./_lib/ai/index.js";
import { withBudget } from "./_lib/limits.js";
import { BASE_COPY_SYSTEM, RESUME_SCHEMA } from "./_lib/prompts.js";
import { loadBase, baseBlock, undashAll } from "./generate.js";
import { dedupeSkills } from "../public/js/doc.js";

const LIST = "id,job_id,parent_id,kind,source,title,file_name,sent,sent_at,created_at,updated_at";

export const POST = handle(async (request) => {
  const session = await requireOwner(request);
  const base = await loadBase(session);
  if (base.content) return json(200, { id: base.id });
  const content = [await baseBlock(session, base), { type: "text", text: "Copy this resume." }];
  const { data } = await withBudget(session, () => generate({ task: "analyst", system: BASE_COPY_SYSTEM, content, schema: RESUME_SCHEMA }));
  const draft = undashAll(data);
  if (draft.skills) draft.skills = dedupeSkills(draft.skills);
  const [saved] = await restWrite(session, "POST", `documents?select=${LIST}`, {
    job_id: null, parent_id: base.id, kind: "resume", source: "built", title: "Base resume (editable)", file_name: base.file_name?.replace(/\.[a-z]+$/i, ".pdf") || "Base_resume.pdf", content: draft,
  });
  return json(201, saved);
});
