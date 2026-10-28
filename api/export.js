// GET /api/export?id=5  -> the document as a Word file (.docx), built from its
// structured content. Uploaded originals have no structure; download those
// as stored files instead.
import { handle, requireOwner, rest, idParam, HttpError } from "./_lib/supabase.js";
import { resumeDocx, letterDocx, toBuffer } from "./_lib/docx.js";

export const GET = handle(async (request) => {
  const session = await requireOwner(request);
  const id = idParam(request);
  const [doc] = await rest(session, `documents?id=eq.${id}&select=kind,content,file_name,title`);
  if (!doc) throw new HttpError(404, "Not found.");
  if (!doc.content) throw new HttpError(400, "This is an uploaded file. Download the original instead.");
  const buffer = await toBuffer(doc.kind === "letter" ? letterDocx(doc.content) : resumeDocx(doc.content));
  const name = (doc.file_name || doc.title || "document").replace(/\.pdf$/i, "").replace(/[^A-Za-z0-9_.-]+/g, "_");
  return new Response(buffer, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="${name}.docx"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
