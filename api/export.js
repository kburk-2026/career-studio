// GET /api/export?id=5     -> the document as a Word file (.docx), built from its
//                             structured content. Uploaded originals have no
//                             structure; download those as stored files instead.
// GET /api/export?coach=7  -> the latest practice interview for job 7 as a Word file.
import { handle, requireOwner, rest, idParam, HttpError } from "./_lib/supabase.js";
import { resumeDocx, letterDocx, transcriptDocx, toBuffer } from "./_lib/docx.js";
import { MAX_MAIN } from "./_lib/coach/machine.js";
import { withProfileLinks } from "./_lib/links.js";

const fileName = (name) => name.replace(/\.pdf$/i, "").replace(/[^A-Za-z0-9_.-]+/g, "_");

const wordFile = (buffer, name) => new Response(buffer, {
  status: 200,
  headers: {
    "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "Content-Disposition": `attachment; filename="${fileName(name)}.docx"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  },
});

async function transcript(session, jobId) {
  const [job] = await rest(session, `jobs?id=eq.${jobId}&select=company,role_title`);
  if (!job) throw new HttpError(404, "Not found.");
  const [s] = await rest(session, `coach_sessions?job_id=eq.${jobId}&select=id,prep,created_at&order=created_at.desc&limit=1`);
  if (!s) throw new HttpError(404, "No practice interview for this job yet.");
  const turns = await rest(session, `coach_turns?session_id=eq.${s.id}&select=position,kind,question,answer,critique,improved_answer,answered_at&order=position`);
  const date = new Date(s.created_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const buffer = await toBuffer(transcriptDocx({ company: job.company, role: job.role_title, date, prep: s.prep || {}, turns, maxMain: MAX_MAIN }));
  return wordFile(buffer, `Interview_practice_${job.company}`);
}

export const GET = handle(async (request) => {
  const session = await requireOwner(request);
  if (new URL(request.url).searchParams.has("coach")) return transcript(session, idParam(request, "coach"));
  const id = idParam(request);
  const [doc] = await rest(session, `documents?id=eq.${id}&select=kind,content,file_name,title,sent`);
  if (!doc) throw new HttpError(404, "Not found.");
  if (!doc.content) throw new HttpError(400, "This is an uploaded file. Download the original instead.");
  const { content } = await withProfileLinks(session, doc);
  const buffer = await toBuffer(doc.kind === "letter" ? letterDocx(content) : resumeDocx(content));
  return wordFile(buffer, doc.file_name || doc.title || "document");
});
