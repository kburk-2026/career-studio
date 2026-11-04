// Builds a Word file from structured resume/letter content, mirroring the
// owner's base resume: Calibri 10 pt, navy section headings with a rule,
// right-aligned dates via a tab stop (no tables, so ATS parsers read it
// cleanly), real bullet lists. Every link shows its own address as its text.
import {
  AlignmentType, BorderStyle, Document, ExternalHyperlink, LevelFormat, Packer, Paragraph, TabStopType, TextRun,
} from "docx";
import { shortUrl, splitContact, splitEdu } from "../../public/js/doc.js";

const NAVY = "1F4E79";
const pt = (n) => Math.round(n * 2); // docx sizes are half-points
const tw = (n) => Math.round(n * 20); // docx spacing is in twentieths of a point
const inch = (n) => Math.round(n * 1440);
const FONT = "Calibri";
const LETTER = { width: inch(8.5), height: inch(11) }; // docx defaults to A4
const BODY = pt(10);

const run = (text, opts = {}) => new TextRun({ text: String(text ?? ""), font: FONT, ...opts });

const SAFE_URL = /^https:\/\/[^\s"<>]+$/i;
const link = (label, url, opts = {}) =>
  new ExternalHyperlink({ link: url, children: [new TextRun({ text: label, font: FONT, color: NAVY, underline: {}, ...opts })] });

// Text with any https:// addresses turned into working links.
export function linkedRuns(text, opts = {}) {
  const parts = String(text ?? "").split(/(https:\/\/[^\s"<>)]+)/g);
  return parts.filter((x) => x !== "").map((x) => (SAFE_URL.test(x) ? link(x, x, opts) : run(x, opts)));
}

const profileLinks = (c) => (c.links || []).filter((l) => SAFE_URL.test(l.url || ""));
const joined = (pieces, size) => pieces.flatMap((x, i) => (i ? [run(" | ", { size }), x] : [x]));

// One contact line plus the owner's profile links, each shown as its address (cover letters).
function contactRuns(c, size) {
  return [...linkedRuns(c.contact, { size }), ...profileLinks(c).flatMap((l) => [run(" | ", { size }), link(shortUrl(l.url), l.url, { size })])];
}

function heading(text) {
  return new Paragraph({
    spacing: { before: tw(7), after: tw(3) },
    keepNext: true,
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: NAVY, space: 1 } },
    children: [run(text.toUpperCase(), { bold: true, size: pt(11), color: NAVY })],
  });
}

// Left runs and right-aligned dates on one line, using a right tab stop.
function row(left, right, { width, before = tw(5), after = tw(1.5) }) {
  return new Paragraph({
    spacing: { before, after },
    tabStops: [{ type: TabStopType.RIGHT, position: width }],
    keepNext: true,
    children: [...left, ...(right ? [run(`\t${right}`, { size: BODY })] : [])],
  });
}

// Every bullet but the last stays with the next, so a role moves to a new page whole.
const bullet = (text, i, list) => new Paragraph({ numbering: { reference: "bullets", level: 0 }, spacing: { after: tw(1.5) }, keepLines: true, keepNext: i < list.length - 1, children: linkedRuns(text, { size: BODY }) });

const NUMBERING = {
  config: [{
    reference: "bullets",
    levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 300, hanging: 220 } } } }],
  }],
};

export function resumeDocx(c) {
  const margins = { top: inch(0.5), bottom: inch(0.5), left: inch(0.55), right: inch(0.55) };
  const width = inch(8.5 - 0.55 * 2);
  const center = (after, children) => new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: tw(after) }, children });
  const { main, email } = splitContact(c.contact);
  const second = [...(email ? [run(email, { size: BODY })] : []), ...profileLinks(c).map((l) => link(shortUrl(l.url), l.url, { size: BODY }))];
  const early = c.early_career || [];
  const body = [
    center(1, [run(c.name, { bold: true, size: pt(20) })]),
    ...(c.headline ? [center(1, [run(c.headline, { bold: true, size: pt(11), color: NAVY })])] : []),
    ...(main ? [center(second.length ? 1 : 3, [run(main, { size: BODY })])] : []),
    ...(second.length ? [center(3, joined(second, BODY))] : []),
    heading("Summary"),
    new Paragraph({ spacing: { after: tw(2) }, children: linkedRuns(c.summary, { size: BODY }) }),
    heading("Core Competencies"),
    ...(c.skills || []).map((s) => new Paragraph({ spacing: { after: tw(2) }, children: [run(`${s.label}: `, { bold: true, size: BODY }), ...linkedRuns(s.items, { size: BODY })] })),
    heading("Professional Experience"),
    ...(c.roles || []).flatMap((r) => [
      row([run(r.title, { bold: true, size: BODY }), run(` | ${r.org}`, { size: BODY })], r.dates, { width }),
      ...(r.bullets || []).map(bullet),
    ]),
    ...(early.length ? [heading("Early Career and Consulting Experience"), ...early.map(bullet)] : []),
    heading("Education"),
    ...(c.education || []).map((e) => {
      const { text, dates } = typeof e === "string" ? { text: e, dates: "" } : e;
      const { lead, rest } = splitEdu(text);
      return row([run(lead, { bold: true, size: BODY }), ...(rest ? [run(rest, { size: BODY })] : [])], dates, { width, before: 0, after: tw(2) });
    }),
    ...((c.publications || []).length ? [
      heading("Presentations and Publications"),
      ...c.publications.map((p) => new Paragraph({
        spacing: { after: tw(2) },
        children: [...linkedRuns(p.text, { size: BODY }), ...(SAFE_URL.test(p.url || "") ? [run(": ", { size: BODY }), link(shortUrl(p.url), p.url, { size: BODY })] : [])],
      })),
    ] : []),
  ];
  return new Document({ numbering: NUMBERING, styles: { default: { document: { run: { font: FONT, size: BODY } } } }, sections: [{ properties: { page: { size: LETTER, margin: margins } }, children: body }] });
}

export function letterDocx(c) {
  const margins = { top: inch(0.7), bottom: inch(0.7), left: inch(0.85), right: inch(0.85) };
  const p = (text, opts = {}) => new Paragraph({ spacing: { after: 200 }, children: linkedRuns(text, { size: pt(10.5), ...opts }) });
  const tight = (text) => new Paragraph({ children: [run(text, { size: pt(10.5) })] });
  const body = [
    new Paragraph({ spacing: { after: 40 }, children: [run(c.name, { bold: true, size: pt(20), color: NAVY, characterSpacing: 12 })] }),
    new Paragraph({ spacing: { after: 80 }, border: { bottom: { style: BorderStyle.SINGLE, size: 9, color: NAVY, space: 4 } }, children: contactRuns(c, pt(9.5)) }),
    new Paragraph({ spacing: { before: 200 }, children: [run(c.date, { size: pt(10.5) })] }),
    p(c.recipient),
    p(c.subject, { bold: true }),
    p(c.greeting),
    ...(c.paragraphs || []).map((x) => p(x)),
    tight(c.closing), tight(c.signature),
  ];
  return new Document({ styles: { default: { document: { run: { font: FONT } } } }, sections: [{ properties: { page: { size: LETTER, margin: margins } }, children: body }] });
}

// A practice interview: prep, then each question with the answer and feedback.
export function transcriptDocx({ company, role, date, prep = {}, turns = [], maxMain }) {
  const size = pt(11);
  const p = (text, opts = {}) => new Paragraph({ spacing: { after: 120 }, children: linkedRuns(text, { size, ...opts }) });
  const label = (text) => new Paragraph({ spacing: { before: 120, after: 40 }, keepNext: true, children: [run(text, { bold: true, size, color: NAVY })] });
  const item = (text) => new Paragraph({ numbering: { reference: "bullets", level: 0 }, spacing: { after: 40 }, children: linkedRuns(text, { size }) });
  const items = (title, list) => (list?.length ? [label(title), ...list.map(item)] : []);
  let n = 0;
  const body = [
    new Paragraph({ spacing: { after: 40 }, children: [run("Practice interview", { bold: true, size: pt(20), color: NAVY })] }),
    new Paragraph({ spacing: { after: 200 }, border: { bottom: { style: BorderStyle.SINGLE, size: 9, color: NAVY, space: 4 } },
      children: [run([company, role, date].filter(Boolean).join("  |  "), { size: pt(10.5) })] }),
  ];
  if (prep.priorities?.length || prep.concern || prep.stories?.length) {
    body.push(heading("Prep"));
    if (prep.priorities?.length) body.push(label("What the hiring team needs most"), ...prep.priorities.map((x) => item(`${x.title}: ${x.detail}`)));
    if (prep.concern) body.push(label("Likely concern"), p(prep.concern));
    (prep.stories || []).forEach((x, i) => body.push(label(`Story ${i + 1}: ${x.title}`),
      p(`Situation and task: ${x.situation}`), p(`Action: ${x.action}`), p(`Result: ${x.result}`)));
  }
  body.push(heading("Interview"));
  for (const t of turns) {
    const title = t.kind === "followup" ? "Follow-up" : `Question ${++n}${maxMain ? ` of ${maxMain}` : ""}`;
    const c = t.critique || {};
    body.push(label(title), p(t.question, { bold: true }));
    if (!t.answered_at) { body.push(p("Not answered.", { italics: true })); continue; }
    body.push(label("My answer"), p(t.answer));
    if (c.score != null) body.push(label(`Score: ${c.score}/5`));
    body.push(...items("What worked", c.worked), ...items("Improve", c.improve));
    if (t.improved_answer) body.push(label("A stronger version"), p(t.improved_answer));
  }
  const margins = { top: inch(0.9), bottom: inch(0.9), left: inch(1), right: inch(1) };
  return new Document({ numbering: NUMBERING, styles: { default: { document: { run: { font: FONT } } } }, sections: [{ properties: { page: { size: LETTER, margin: margins } }, children: body }] });
}

export const toBuffer = (doc) => Packer.toBuffer(doc);
