// Resume and cover-letter templates.
//
// Documents are stored as structured content, rendered into a locked,
// single-column, ATS-friendly layout for in-place editing, and read back
// from the edited DOM. Each editable piece carries a data-f attribute.
//
// resume: { name, contact, summary, roles: [{ title, org, dates, bullets: [] }],
//           skills: [{ label, items }], education: [] }
// letter: { greeting, paragraphs: [], closing, signature }

import { esc } from "./format.js";

const li = (items) => (items || []).map((x) => `<li>${esc(x)}</li>`).join("") || "<li></li>";

export function renderResume(c = {}) {
  return `<h1 data-f="name">${esc(c.name)}</h1>
<p data-f="contact">${esc(c.contact)}</p>
<h2>Summary</h2>
<p data-f="summary">${esc(c.summary)}</p>
<h2>Experience</h2>
${(c.roles || []).map((r) => `<div class="role" data-role>
<p><b data-f="title">${esc(r.title)}</b> &middot; <span data-f="org">${esc(r.org)}</span> <span class="dates" data-f="dates">${esc(r.dates)}</span></p>
<ul data-f="bullets">${li(r.bullets)}</ul>
</div>`).join("\n")}
<h2>Skills</h2>
${(c.skills || []).map((s) => `<p data-skill><b data-f="label">${esc(s.label)}</b>: <span data-f="items">${esc(s.items)}</span></p>`).join("\n")}
<h2>Education</h2>
<ul data-f="education">${li(c.education)}</ul>`;
}

export function renderLetter(c = {}) {
  return `<div class="letter">
<p data-f="greeting">${esc(c.greeting)}</p>
<div data-f="paragraphs">${(c.paragraphs || []).map((p) => `<p>${esc(p)}</p>`).join("")}</div>
<p data-f="closing">${esc(c.closing)}</p>
<p data-f="signature">${esc(c.signature)}</p>
</div>`;
}

export const renderDoc = (kind, content) => (kind === "letter" ? renderLetter(content) : renderResume(content));

const text = (el) => (el ? el.innerText.replace(/\s+/g, " ").trim() : "");
const lines = (root) => [...(root?.querySelectorAll("li, p") || [])].map(text).filter(Boolean);

export function readDoc(kind, root) {
  const f = (name, scope = root) => text(scope.querySelector(`[data-f="${name}"]`));
  if (kind === "letter") {
    return {
      greeting: f("greeting"),
      paragraphs: lines(root.querySelector('[data-f="paragraphs"]')),
      closing: f("closing"),
      signature: f("signature"),
    };
  }
  return {
    name: f("name"),
    contact: f("contact"),
    summary: f("summary"),
    roles: [...root.querySelectorAll("[data-role]")].map((r) => ({
      title: f("title", r), org: f("org", r), dates: f("dates", r),
      bullets: lines(r.querySelector('[data-f="bullets"]')),
    })),
    skills: [...root.querySelectorAll("[data-skill]")].map((s) => ({ label: f("label", s), items: f("items", s) })),
    education: lines(root.querySelector('[data-f="education"]')),
  };
}

// Plain text of a document, for checks (numbers, dashes) and word counts.
export function docText(kind, c = {}) {
  if (kind === "letter") return [c.greeting, ...(c.paragraphs || []), c.closing, c.signature].filter(Boolean).join("\n");
  return [c.name, c.contact, c.summary,
    ...(c.roles || []).flatMap((r) => [r.title, r.org, r.dates, ...(r.bullets || [])]),
    ...(c.skills || []).map((s) => `${s.label}: ${s.items}`),
    ...(c.education || [])].filter(Boolean).join("\n");
}
