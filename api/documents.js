// GET   /api/documents              -> list (no content)
// GET   /api/documents?id=5         -> one document with content
// GET   /api/documents?id=5&file=1  -> short-lived download link for the stored file
// PATCH /api/documents?id=5         -> save title/content (refused once sent)
// POST  /api/documents?copy=5       -> editable copy of any document
// POST  /api/documents?sent=5       -> mark as sent (locks it for good)
import { handle, json, requireOwner, rest, restWrite, readJson, idParam, v, HttpError } from "./_lib/supabase.js";

const LIST = "id,job_id,parent_id,kind,source,title,file_name,sent,sent_at,created_at,updated_at";
const MAX_CONTENT = 200 * 1024;

export const GET = handle(async (request) => {
  const session = await requireOwner(request);
  const params = new URL(request.url).searchParams;
  if (!params.has("id")) {
    return json(200, { documents: await rest(session, `documents?select=${LIST}&order=created_at.desc`) });
  }
  const id = idParam(request);
  const [doc] = await rest(session, `documents?id=eq.${id}&select=${LIST},content,file_path`);
  if (!doc) throw new HttpError(404, "Not found.");
  if (params.get("file") === "1") {
    if (!doc.file_path) throw new HttpError(404, "No stored file for this document.");
    // Signed with the user's own token, so Storage RLS applies.
    const res = await fetch(`${session.cfg.url}/storage/v1/object/sign/docs/${doc.file_path.split("/").map(encodeURIComponent).join("/")}`, {
      method: "POST",
      headers: { apikey: session.cfg.anonKey, Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn: 60 }),
    });
    if (!res.ok) throw new HttpError(502, "Could not create a download link.");
    const { signedURL } = await res.json();
    return json(200, { url: `${session.cfg.url}/storage/v1${signedURL}&download=${encodeURIComponent(doc.file_name || "document.pdf")}` });
  }
  const { file_path, ...out } = doc;
  return json(200, { ...out, has_file: Boolean(file_path) });
});

export const PATCH = handle(async (request) => {
  const session = await requireOwner(request);
  const id = idParam(request);
  const body = await readJson(request, MAX_CONTENT);
  const row = {};
  if ("title" in body) row.title = v.text(body.title, "Title", { max: 200, required: true });
  if ("content" in body) {
    if (!body.content || typeof body.content !== "object") throw new HttpError(400, "Content must be an object.");
    row.content = body.content;
  }
  if (!Object.keys(row).length) throw new HttpError(400, "Nothing to change.");
  const saved = await restWrite(session, "PATCH", `documents?id=eq.${id}&select=${LIST}`, row);
  if (!saved.length) throw new HttpError(404, "Not found.");
  return json(200, saved[0]);
});

export const POST = handle(async (request) => {
  const session = await requireOwner(request);
  const params = new URL(request.url).searchParams;

  if (params.has("copy")) {
    const id = idParam(request, "copy");
    const [src] = await rest(session, `documents?id=eq.${id}&select=job_id,kind,source,title,content,file_path,file_name`);
    if (!src) throw new HttpError(404, "Not found.");
    const [copy] = await restWrite(session, "POST", `documents?select=${LIST}`, {
      job_id: src.job_id, parent_id: id, kind: src.kind, source: src.source === "uploaded" ? "uploaded" : "generated",
      title: `${src.title} (copy)`, content: src.content, file_path: src.content ? null : src.file_path, file_name: src.file_name,
    });
    return json(201, copy);
  }

  if (params.has("sent")) {
    const id = idParam(request, "sent");
    const saved = await restWrite(session, "PATCH", `documents?id=eq.${id}&select=${LIST}`, { sent: true });
    if (!saved.length) throw new HttpError(404, "Not found.");
    const doc = saved[0];
    if (doc.job_id) {
      // The job remembers which file went out.
      const field = doc.kind === "letter" ? "cover_letter_file" : "resume_file";
      await restWrite(session, "PATCH", `jobs?id=eq.${doc.job_id}&select=id`, { [field]: doc.file_name || doc.title });
    }
    return json(200, doc);
  }

  throw new HttpError(400, "Use ?copy= or ?sent=. New documents are created by the generator.");
});
