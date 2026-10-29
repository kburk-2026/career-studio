// Resume and cover-letter templates.
//
// Documents are stored as structured content and rendered into a locked,
// single-column, ATS-friendly layout (ported from JobHuntAgent's
// resume_base.html: same section order, sizes, and no tables). Each editable
// piece carries a data-f attribute so edits read back into structure.
//
// resume: { name, contact, links: [{ label, url }], summary, skills: [{ label, items }],
//           roles: [{ org, title, dates, bullets: [] }],
//           education: [{ text, dates }], publications: [{ text, url }] }
// letter: { name, contact, links, date, recipient, subject, greeting,
//           paragraphs: [], closing, signature }
//
// Links come from the owner's profile, not the model, and are not edited in
// the document; they carry through to print and Word unchanged.

import { esc } from "./format.js";

const li = (items) => (items || []).map((x) => `<li>${esc(x)}</li>`).join("") || "<li></li>";
const eduItem = (e) => (typeof e === "string" ? { text: e, dates: "" } : e || {});
const safeUrl = (u) => (/^https:\/\/[^\s"<>]+$/i.test(u || "") ? u : "");

function contactLine(c) {
  const links = (c.links || []).filter((l) => safeUrl(l.url));
  return `<p class="contact"><span data-f="contact">${esc(c.contact)}</span>${links.map((l) =>
    ` <span class="sep" contenteditable="false">|</span> <a href="${esc(l.url)}" contenteditable="false" target="_blank" rel="noopener noreferrer">${esc(l.label)}</a>`).join("")}</p>`;
}

export function renderResume(c = {}) {
  const pubs = c.publications || [];
  return `<div class="doc resume">
<p class="name" data-f="name">${esc(c.name)}</p>
${contactLine(c)}
<h2>Summary</h2>
<p class="summary" data-f="summary">${esc(c.summary)}</p>
<h2>Skills</h2>
${(c.skills || []).map((s) => `<p class="skill" data-skill><b data-f="label">${esc(s.label)}</b>: <span data-f="items">${esc(s.items)}</span></p>`).join("\n")}
<h2>Work Experience</h2>
${(c.roles || []).map((r) => `<div class="job" data-role>
<div class="row"><span class="left"><span data-f="org">${esc(r.org)}</span> - <span data-f="title">${esc(r.title)}</span></span><span class="right" data-f="dates">${esc(r.dates)}</span></div>
<ul data-f="bullets">${li(r.bullets)}</ul>
</div>`).join("\n")}
<h2>Education</h2>
${(c.education || []).map(eduItem).map((e) => `<div class="row" data-edu><span class="left" data-f="text">${esc(e.text)}</span><span class="right" data-f="dates">${esc(e.dates)}</span></div>`).join("\n")}
${pubs.length ? `<h2>Presentations and Publications</h2>
<ul data-f="publications">${pubs.map((p) => `<li><span data-f="pubtext">${esc(p.text)}</span>${safeUrl(p.url) ? ` <a href="${esc(p.url)}" contenteditable="false" target="_blank" rel="noopener noreferrer">Link</a>` : ""}</li>`).join("")}</ul>` : ""}
</div>`;
}

export function renderLetter(c = {}) {
  return `<div class="doc letter">
<p class="name" data-f="name">${esc(c.name)}</p>
${contactLine(c)}
<div class="rule"></div>
<div class="meta"><p data-f="date">${esc(c.date)}</p><p data-f="recipient">${esc(c.recipient)}</p></div>
<p class="subject" data-f="subject">${esc(c.subject)}</p>
<p data-f="greeting">${esc(c.greeting)}</p>
<div data-f="paragraphs">${(c.paragraphs || []).map((p) => `<p>${esc(p)}</p>`).join("")}</div>
<div class="signoff"><p data-f="closing">${esc(c.closing)}</p><p data-f="signature">${esc(c.signature)}</p></div>
</div>`;
}

export const renderDoc = (kind, content) => (kind === "letter" ? renderLetter(content) : renderResume(content));

const text = (el) => (el ? el.innerText.replace(/\s+/g, " ").trim() : "");
const lines = (root) => [...(root?.querySelectorAll("li, p") || [])].map(text).filter(Boolean);

// Reads the edited document back into structure. Links and publication URLs
// aren't editable in place, so they come from the previous content.
export function readDoc(kind, root, prev = {}) {
  const f = (name, scope = root) => text(scope.querySelector(`[data-f="${name}"]`));
  if (kind === "letter") {
    return {
      name: f("name"), contact: f("contact"), links: prev.links || [], date: f("date"), recipient: f("recipient"), subject: f("subject"),
      greeting: f("greeting"),
      paragraphs: lines(root.querySelector('[data-f="paragraphs"]')),
      closing: f("closing"), signature: f("signature"),
    };
  }
  const pubItems = [...root.querySelectorAll('[data-f="publications"] li')];
  return {
    name: f("name"),
    contact: f("contact"),
    links: prev.links || [],
    summary: f("summary"),
    skills: [...root.querySelectorAll("[data-skill]")].map((s) => ({ label: f("label", s), items: f("items", s) })),
    roles: [...root.querySelectorAll("[data-role]")].map((r) => ({
      org: f("org", r), title: f("title", r), dates: f("dates", r),
      bullets: lines(r.querySelector('[data-f="bullets"]')),
    })),
    education: [...root.querySelectorAll("[data-edu]")].map((e) => ({ text: f("text", e), dates: f("dates", e) })),
    publications: pubItems.map((el, i) => ({ text: text(el.querySelector('[data-f="pubtext"]') || el), url: prev.publications?.[i]?.url || "" })).filter((p) => p.text),
  };
}

// Each skill once across all skill lines (case-insensitive); empty lines dropped.
export function dedupeSkills(skills = []) {
  const seen = new Set();
  return skills.map((s) => {
    const items = String(s.items || "").split(/,\s*/).map((x) => x.trim()).filter(Boolean)
      .filter((x) => { const k = x.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
    return { ...s, items: items.join(", ") };
  }).filter((s) => s.items);
}

// The owner's web links, from profile preferences, in display order.
export function linksFromPrefs(prefs = {}) {
  return [["LinkedIn", prefs.linkedin_url], ["Portfolio", prefs.portfolio_url], ["Website", prefs.website_url]]
    .filter(([, url]) => safeUrl(url)).map(([label, url]) => ({ label, url }));
}

// Plain text of a document, for checks (numbers, dashes) and word counts.
export function docText(kind, c = {}) {
  if (kind === "letter") {
    return [c.subject, c.greeting, ...(c.paragraphs || []), c.closing].filter(Boolean).join("\n");
  }
  return [c.summary,
    ...(c.skills || []).map((s) => `${s.label}: ${s.items}`),
    ...(c.roles || []).flatMap((r) => [r.org, r.title, ...(r.bullets || [])]),
    ...(c.education || []).map((e) => eduItem(e).text),
    ...(c.publications || []).map((p) => p.text)].filter(Boolean).join("\n");
}

export const wordCount = (kind, c) => (docText(kind, c).match(/\S+/g) || []).length;
