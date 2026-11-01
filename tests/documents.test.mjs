import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkDraft, evidenceNumbers } from "../public/js/checks.js";
import { docText, wordCount } from "../public/js/doc.js";
import { resumeDocx, letterDocx, toBuffer } from "../api/_lib/docx.js";
import { undashAll, POST as generatePOST } from "../api/generate.js";
import { GET as exportGET } from "../api/export.js";
import { GET as documentsGET } from "../api/documents.js";
import { POST as uploadPOST } from "../api/upload.js";
import { baseBlock } from "../api/generate.js";
import { cleanLink, linkSite } from "../public/js/format.js";
import JSZip from "jszip";
import { RESUME_SCHEMA, LETTER_SCHEMA, writerContent } from "../api/_lib/prompts.js";

const demo = JSON.parse(readFileSync(new URL("../public/demo/documents.json", import.meta.url), "utf8")).documents;
const resume = demo.find((d) => d.kind === "resume" && d.content).content;
const letter = demo.find((d) => d.kind === "letter" && d.content).content;

test("draft checks catch invented numbers, title claims, and thin resumes", () => {
  const ev = evidenceNumbers("12 years", "from 3 to 2 across 40 courses", "120 course pages", "a team of four");
  const ok = checkDraft("letter", letter, ev);
  assert.deepEqual(ok, []);
  const bad = checkDraft("resume", { ...resume, summary: "VP of Learning who grew enrollment 45%." }, ev);
  const kinds = bad.map((i) => i.kind);
  assert.ok(kinds.includes("number") && kinds.includes("title") && kinds.includes("length"));
});

test("contact lines and dates are not treated as claims", () => {
  const phone = ["(555)", "010", "2030"].join(" ");
  const text = docText("resume", { ...resume, contact: phone, roles: [{ org: "A", title: "B", dates: "2019 to 2026", bullets: [] }] });
  assert.ok(!text.includes("555") && !text.includes("2019"));
  assert.ok(wordCount("resume", resume) > 50);
});

test("dashes are removed from every string in a draft", () => {
  assert.deepEqual(undashAll({ a: "x — y", b: ["p–q"], c: 3 }), { a: "x - y", b: ["p - q"], c: 3 });
});

test("Word files build for both document kinds", async () => {
  for (const buf of [await toBuffer(resumeDocx(resume)), await toBuffer(letterDocx(letter))]) {
    assert.equal(buf.subarray(0, 2).toString(), "PK", "docx is a zip");
    assert.ok(buf.length > 3000);
  }
});

test("writer schemas are strict", () => {
  const walk = (s) => {
    if (s.type === "object") { assert.equal(s.additionalProperties, false); assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort()); Object.values(s.properties).forEach(walk); }
    if (s.type === "array") walk(s.items);
  };
  walk(RESUME_SCHEMA);
  walk(LETTER_SCHEMA);
});

test("letters are told never to mention gaps", () => {
  const prompt = writerContent({ kind: "letter", posting: "p", company: "Acme", role: "PM", strengths: ["s"], gaps: ["No SCORM"], today: "Oct 28, 2026" });
  assert.match(prompt, /do not mention them/);
  assert.match(prompt, /<job_posting company="Acme"/);
});

const realFetch = globalThis.fetch;
const ENV = { SUPABASE_URL: "https://ref.supabase.co", SUPABASE_ANON_KEY: "anon", ALLOWED_EMAIL: "owner@example.com" };
beforeEach(() => Object.assign(process.env, ENV));
afterEach(() => { globalThis.fetch = realFetch; for (const k of Object.keys(ENV)) delete process.env[k]; });

test("generation and export need the owner and validate input", async () => {
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith("/auth/v1/user")) return init.headers.Authorization === "Bearer good" ? Response.json({ email: "owner@example.com" }) : new Response("{}", { status: 401 });
    return Response.json([]);
  };
  const req = (path, token, method = "POST") => new Request(`http://x/api/${path}`, { method, headers: { Authorization: `Bearer ${token}` } });
  assert.equal((await generatePOST(req("generate?job=1&kind=resume", "bad"))).status, 401);
  assert.equal((await generatePOST(req("generate?job=1&kind=poem", "good"))).status, 400);
  assert.equal((await generatePOST(req("generate?job=1&kind=resume", "good"))).status, 404);
  assert.equal((await exportGET(req("export?id=1", "bad", "GET"))).status, 401);
  assert.equal((await exportGET(req("export?id=1", "good", "GET"))).status, 404);
});

import { dedupeSkills, linksFromPrefs } from "../public/js/doc.js";
import { cleanUrl, cleanPrefs } from "../api/profile.js";
import { linkedRuns } from "../api/_lib/docx.js";

test("each skill appears once across all skill lines", () => {
  const out = dedupeSkills([
    { label: "Tools", items: "Canvas, Moodle, Power BI" },
    { label: "Data", items: "power bi, Tableau, Canvas" },
    { label: "Empty", items: "Moodle" },
  ]);
  assert.deepEqual(out, [{ label: "Tools", items: "Canvas, Moodle, Power BI" }, { label: "Data", items: "Tableau" }]);
});

test("document links come only from the profile and must be https", () => {
  assert.deepEqual(linksFromPrefs({ linkedin_url: "https://www.linkedin.com/in/x", portfolio_url: "http://insecure.example", website_url: "" }),
    [{ label: "linkedin.com/in/x", url: "https://www.linkedin.com/in/x" }]);
  assert.throws(() => cleanUrl("javascript:alert(1)", "Link"), /https/);
  assert.equal(cleanUrl("https://example.com/talk", "Link"), "https://example.com/talk");
  assert.throws(() => cleanPrefs({ portfolio_url: "ftp://example.com" }));
});

test("web addresses in text become working links in Word", async () => {
  const runs = linkedRuns("See https://example.com/case and more.");
  assert.equal(runs.length, 3);
  const buf = await toBuffer(resumeDocx({ ...resume, links: [{ label: "LinkedIn", url: "https://www.linkedin.com/in/example" }], publications: [{ text: "Talk", url: "https://example.com/talk" }] }));
  assert.ok(buf.length > 3000);
});

test("a practice interview downloads as a Word file, owner only", async () => {
  const demoJob = JSON.parse(readFileSync(new URL("../public/demo/jobs/101.json", import.meta.url), "utf8"));
  const turns = [
    { position: 1, kind: "main", question: "Tell me about a review process.", answer: "I set up a checklist.", critique: { score: 4, worked: ["Clear"], improve: ["Add a result"] }, improved_answer: "A stronger one.", answered_at: "2026-10-29T10:00:00Z" },
    { position: 2, kind: "followup", question: "What changed?", answered_at: null },
  ];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith("/auth/v1/user")) return init.headers.Authorization === "Bearer good" ? Response.json({ email: "owner@example.com" }) : new Response("{}", { status: 401 });
    if (u.includes("/jobs?id=eq.7")) return Response.json([{ company: "Maplecrest", role_title: "Designer" }]);
    if (u.includes("/coach_sessions?job_id=eq.7")) return Response.json([{ id: 3, prep: demoJob.coach, created_at: "2026-10-29T09:00:00Z" }]);
    if (u.includes("/coach_turns?session_id=eq.3")) return Response.json(turns);
    return Response.json([]);
  };
  const req = (path, token) => new Request(`http://x/api/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal((await exportGET(req("export?coach=7", "bad"))).status, 401);
  assert.equal((await exportGET(req("export?coach=8", "good"))).status, 404);
  const res = await exportGET(req("export?coach=7", "good"));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition"), /Interview_practice_Maplecrest\.docx/);
  assert.ok((await res.arrayBuffer()).byteLength > 3000);
});

const paragraphs = async (doc) => {
  const zip = await JSZip.loadAsync(await toBuffer(doc));
  return (await zip.file("word/document.xml").async("string")).match(/<w:p[ >].*?<\/w:p>/gs);
};

test("Word files have no empty paragraphs, and roles stay together across pages", async () => {
  for (const doc of [resumeDocx(resume), letterDocx(letter)]) {
    for (const p of await paragraphs(doc)) assert.match(p, /<w:t[ >]/, "paragraph has text");
  }
  const bullets = (await paragraphs(resumeDocx({ ...resume, roles: [{ org: "A", title: "B", dates: "2020", bullets: ["one", "two"] }] }))).filter((p) => p.includes("<w:numPr>"));
  assert.ok(bullets[0].includes("<w:keepNext/>") && bullets[0].includes("<w:keepLines/>"));
  assert.ok(!bullets[1].includes("<w:keepNext/>"));
});

test("drafts missing links pick them up from the profile; sent documents never change", async () => {
  const prefs = { linkedin_url: "https://www.linkedin.com/in/x", portfolio_url: "https://example.com/p", website_url: null };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith("/auth/v1/user")) return Response.json({ email: "owner@example.com" });
    if (u.includes("/profile_prefs")) return Response.json([prefs]);
    if (u.includes("/documents?id=eq.1")) return Response.json([{ kind: "resume", title: "d", content: { ...resume, links: [] }, sent: false }]);
    if (u.includes("/documents?id=eq.2")) return Response.json([{ kind: "resume", title: "s", content: { ...resume, links: [] }, sent: true }]);
    return Response.json([]);
  };
  const get = async (id) => (await documentsGET(new Request(`http://x/api/documents?id=${id}`, { headers: { Authorization: "Bearer good" } }))).json();
  assert.deepEqual((await get(1)).content.links.map((l) => l.label), ["linkedin.com/in/x", "Portfolio"]);
  assert.deepEqual((await get(2)).content.links, []);
  const word = await exportGET(new Request("http://x/api/export?id=1", { headers: { Authorization: "Bearer good" } }));
  const zip = await JSZip.loadAsync(Buffer.from(await word.arrayBuffer()));
  const xml = await zip.file("word/document.xml").async("string");
  assert.ok(xml.includes("linkedin.com/in/x") && xml.includes(">Portfolio<"));
});

test("application links are cleaned to https or refused", () => {
  assert.equal(cleanLink("  http://jobs.example.com/1 "), "https://jobs.example.com/1");
  assert.equal(cleanLink("jobs.example.com/1"), "https://jobs.example.com/1");
  assert.equal(cleanLink(""), "");
  assert.equal(cleanLink("javascript:alert(1)"), null);
  assert.equal(cleanLink("not a link"), null);
  assert.equal(linkSite("https://www.jobs.example.com/a?b=1"), "jobs.example.com");
});

test("the writer gets standing feedback, marked as unable to add facts", () => {
  const prompt = writerContent({ kind: "resume", posting: "p", company: "Acme", role: "PM", today: "Nov 1, 2026", notes: "Keep the summary short." });
  assert.match(prompt, /<candidate_feedback>[\s\S]*never adds facts[\s\S]*Keep the summary short\.[\s\S]*<\/candidate_feedback>/);
  assert.doesNotMatch(writerContent({ kind: "resume", posting: "p", company: "A", role: "B", today: "x" }), /candidate_feedback/);
  assert.equal(cleanPrefs({ writer_notes: "note" }).writer_notes, "note");
  assert.throws(() => cleanPrefs({ writer_notes: "x".repeat(4001) }));
});

test("the writer reads the edited base resume, and opening it never pays for a second copy", async () => {
  const content = { ...resume, summary: "Edited summary with 42 programs." };
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/auth/v1/user")) return Response.json({ email: "owner@example.com" });
    if (String(url).includes("/documents?")) return Response.json([{ id: 9, content, file_path: null }]);
    throw new Error(`unexpected call: ${url}`);
  };
  const res = await uploadPOST(new Request("http://x/api/upload?base=1", { method: "POST", headers: { Authorization: "Bearer good" }, body: "{}" }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).id, 9);
  const block = await baseBlock({}, { content });
  assert.equal(block.type, "text");
  assert.match(block.text, /<base_resume>[\s\S]*Edited summary with 42 programs/);
});
