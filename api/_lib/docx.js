// Builds a Word file from structured resume/letter content, mirroring the
// locked layout: Calibri, navy headings with a rule, right-aligned dates via a
// tab stop (no tables, so ATS parsers read it cleanly), real bullet lists.
import {
  AlignmentType, BorderStyle, Document, ExternalHyperlink, LevelFormat, Packer, Paragraph, TabStopType, TextRun,
} from "docx";

const NAVY = "1F4E79";
const pt = (n) => Math.round(n * 2); // docx sizes are half-points
const inch = (n) => Math.round(n * 1440);
const FONT = "Calibri";
const LETTER = { width: inch(8.5), height: inch(11) }; // docx defaults to A4

const run = (text, opts = {}) => new TextRun({ text: String(text ?? ""), font: FONT, ...opts });

const SAFE_URL = /^https:\/\/[^\s"<>]+$/i;
const link = (label, url, opts = {}) =>
  new ExternalHyperlink({ link: url, children: [new TextRun({ text: label, font: FONT, color: NAVY, underline: {}, ...opts })] });

// Text with any https:// addresses turned into working links.
export function linkedRuns(text, opts = {}) {
  const parts = String(text ?? "").split(/(https:\/\/[^\s"<>)]+)/g);
  return parts.filter((x) => x !== "").map((x) => (SAFE_URL.test(x) ? link(x, x, opts) : run(x, opts)));
}

// Contact line plus the owner's profile links (LinkedIn, Portfolio, ...).
function contactRuns(c, size) {
  const links = (c.links || []).filter((l) => SAFE_URL.test(l.url || ""));
  return [...linkedRuns(c.contact, { size }), ...links.flatMap((l) => [run(" | ", { size }), link(l.label, l.url, { size })])];
}

function heading(text) {
  return new Paragraph({
    spacing: { before: 120, after: 60 },
    keepNext: true,
    border: { bottom: { style: BorderStyle.SINGLE, size: 7, color: NAVY, space: 1 } },
    children: [run(text.toUpperCase(), { bold: true, size: pt(10.5), color: NAVY, characterSpacing: 8 })],
  });
}

// Left text and right-aligned dates on one line, using a right tab stop.
function row(left, right, { bold = true, width }) {
  return new Paragraph({
    spacing: { before: 80, after: 20 },
    tabStops: [{ type: TabStopType.RIGHT, position: width }],
    keepNext: true,
    children: [run(left, { bold, size: pt(9.8) }), ...(right ? [run(`\t${right}`, { bold, size: pt(9.8) })] : [])],
  });
}

// Every bullet but the last stays with the next, so a role moves to a new page whole.
const bullet = (text, i, list) => new Paragraph({ numbering: { reference: "bullets", level: 0 }, spacing: { after: 20 }, keepLines: true, keepNext: i < list.length - 1, children: linkedRuns(text, { size: pt(9.8) }) });

const NUMBERING = {
  config: [{
    reference: "bullets",
    levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: inch(0.18), hanging: inch(0.13) } } } }],
  }],
};

export function resumeDocx(c) {
  const margins = { top: inch(0.38), bottom: inch(0.38), left: inch(0.52), right: inch(0.52) };
  const width = inch(8.5 - 0.52 * 2);
  const body = [
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 40 }, children: [run(c.name, { bold: true, size: pt(20), color: NAVY, characterSpacing: 12 })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 160 }, children: contactRuns(c, pt(9.5)) }),
    heading("Summary"),
    new Paragraph({ spacing: { after: 40 }, children: linkedRuns(c.summary, { size: pt(9.8) }) }),
    heading("Skills"),
    ...(c.skills || []).map((s) => new Paragraph({ spacing: { after: 40 }, children: [run(`${s.label}: `, { bold: true, size: pt(9.8) }), ...linkedRuns(s.items, { size: pt(9.8) })] })),
    heading("Work Experience"),
    ...(c.roles || []).flatMap((r) => [row(`${r.org} - ${r.title}`, r.dates, { width }), ...(r.bullets || []).map(bullet)]),
    heading("Education"),
    ...(c.education || []).map((e) => (typeof e === "string" ? row(e, "", { width, bold: false }) : row(e.text, e.dates, { width, bold: false }))),
    ...((c.publications || []).length ? [
      heading("Presentations and Publications"),
      ...c.publications.map((p) => new Paragraph({
        numbering: { reference: "bullets", level: 0 }, spacing: { after: 20 },
        children: [...linkedRuns(p.text, { size: pt(9.8) }), ...(SAFE_URL.test(p.url || "") ? [run("  "), link("Link", p.url, { size: pt(9.8) })] : [])],
      })),
    ] : []),
  ];
  return new Document({ numbering: NUMBERING, styles: { default: { document: { run: { font: FONT } } } }, sections: [{ properties: { page: { size: LETTER, margin: margins } }, children: body }] });
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
