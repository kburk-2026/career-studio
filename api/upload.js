// POST /api/upload   (body: the PDF or Word file; header X-File-Name)
//   -> { document, extracted }
//
// Stores the resume privately, records it as the owner's newest base resume,
// and reads it into a list of roles, results, skills, and education for the
// owner to confirm. Nothing read from the file joins the profile until the
// owner ticks it (see POST /api/profile?batch=1).
import mammoth from "mammoth";
import { handle, json, requireOwner, restWrite, HttpError } from "./_lib/supabase.js";
import { generate } from "./_lib/ai/index.js";
import { withBudget } from "./_lib/limits.js";
import { EXTRACT_SYSTEM, EXTRACT_SCHEMA } from "./_lib/prompts.js";
import { undashAll } from "./generate.js";

const MAX_BYTES = 4 * 1024 * 1024;
const TYPES = {
  pdf: { mime: "application/pdf", magic: "%PDF" },
  docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", magic: "PK" },
};

// The file's own first bytes decide its type, not its name.
export function detectType(bytes) {
  const head = Buffer.from(bytes.subarray(0, 4)).toString("latin1");
  if (head.startsWith(TYPES.pdf.magic)) return "pdf";
  if (head.startsWith(TYPES.docx.magic)) return "docx";
  return null;
}

export const safeName = (name, ext) =>
  `${String(name || "resume").replace(/\.[a-z0-9]+$/i, "").replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 60) || "resume"}.${ext}`;

export const POST = handle(async (request) => {
  const session = await requireOwner(request);
  if (Number(request.headers.get("content-length") || 0) > MAX_BYTES) throw new HttpError(413, "That file is larger than 4 MB.");
  const bytes = Buffer.from(await request.arrayBuffer());
  if (!bytes.length) throw new HttpError(400, "No file received.");
  if (bytes.length > MAX_BYTES) throw new HttpError(413, "That file is larger than 4 MB.");
  const type = detectType(bytes);
  if (!type) throw new HttpError(415, "Upload a PDF or Word (.docx) file.");

  let docxText = null;
  if (type === "docx") {
    try {
      docxText = (await mammoth.extractRawText({ buffer: bytes })).value.trim();
    } catch {
      throw new HttpError(415, "That Word file couldn't be read. Try saving it again, or upload a PDF.");
    }
    if (docxText.length < 200) throw new HttpError(422, "That Word file has almost no text.");
  }

  const fileName = safeName(decodeURIComponent(request.headers.get("x-file-name") || ""), type);
  const objectPath = `${session.user.id}/uploads/${Date.now()}-${fileName}`;
  const put = await fetch(`${session.cfg.url}/storage/v1/object/docs/${objectPath}`, {
    method: "POST",
    headers: { apikey: session.cfg.anonKey, Authorization: `Bearer ${session.token}`, "Content-Type": TYPES[type].mime },
    body: bytes,
  });
  if (!put.ok) throw new HttpError(502, "Could not store the file.");

  const content = type === "pdf"
    ? [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: bytes.toString("base64") }, title: "Resume" },
       { type: "text", text: "List what this resume says." }]
    : `<resume>\n${docxText.slice(0, 60_000)}\n</resume>\n\nList what this resume says.`;
  const { data } = await withBudget(session, () => generate({ task: "analyst", system: EXTRACT_SYSTEM, content, schema: EXTRACT_SCHEMA }));

  const [document] = await restWrite(session, "POST", "documents?select=id,kind,source,title,file_name,created_at", {
    job_id: null, kind: "resume", source: "uploaded", title: "Base resume", file_path: objectPath, file_name: fileName,
  });
  return json(201, { document, extracted: undashAll(data) });
});
