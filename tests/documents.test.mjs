import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkDraft, evidenceNumbers } from "../public/js/checks.js";
import { docText, wordCount } from "../public/js/doc.js";
import { resumeDocx, letterDocx, toBuffer } from "../api/_lib/docx.js";
import { undashAll, POST as generatePOST } from "../api/generate.js";
import { GET as exportGET } from "../api/export.js";
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
    [{ label: "LinkedIn", url: "https://www.linkedin.com/in/x" }]);
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
