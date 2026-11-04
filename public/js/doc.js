// Resume and cover-letter templates.
//
// Documents are stored as structured content and rendered into a locked,
// single-column, ATS-friendly layout that mirrors the owner's base resume
// (Calibri, navy headings with a rule, right-aligned dates, no tables). Each
// editable piece carries a data-f attribute so edits read back into structure.
//
// resume: { name, headline, contact, links: [{ label, url }], summary, skills: [{ label, items }],
//           roles: [{ org, title, dates, bullets: [] }], early_career: [],
//           education: [{ text, dates }], publications: [{ text, url }] }
// letter: { name, contact, links, date, recipient, subject, greeting,
//           paragraphs: [], closing, signature }
//
// Links come from the owner's profile, not the model, and are not edited in
// the document. Every link shows its own address as the visible text, so the
// address survives on paper and in resume screeners that drop hyperlinks.

import { esc } from "./format.js";

const li = (items) => (items || []).map((x) => `<li>${esc(x)}</li>`).join("") || "<li></li>";
const eduItem = (e) => (typeof e === "string" ? { text: e, dates: "" } : e || {});
const safeUrl = (u) => (/^https:\/\/[^\s"<>]+$/i.test(u || "") ? u : "");

// An address as it should read on the page: no scheme, no www, no trailing slash.
export const shortUrl = (url) => String(url || "").replace(/^https:\/\/(www\.)?/i, "").replace(/\/$/, "");

// The base resume's two contact lines: location and phone, then email and web links.
export function splitContact(contact) {
  const parts = String(contact || "").split(/\s*[|·•]\s*/).map((x) => x.trim()).filter(Boolean);
  return { main: parts.filter((p) => !p.includes("@")).join(" | "), email: parts.filter((p) => p.includes("@")).join(" | ") };
}

// "Degree | School" shows the degree in bold, like the base resume.
export function splitEdu(text) {
  const at = String(text || "").indexOf(" | ");
  return at < 0 ? { lead: String(text || ""), rest: "" } : { lead: text.slice(0, at), rest: text.slice(at) };
}

const anchor = (url, label) => `<a href="${esc(url)}" contenteditable="false" target="_blank" rel="noopener noreferrer">${esc(label || shortUrl(url))}</a>`;
const SEP = ` <span class="sep" contenteditable="false">|</span> `;

function contactLine(c) {
  const links = (c.links || []).filter((l) => safeUrl(l.url));
  return `<p class="contact"><span data-f="contact">${esc(c.contact)}</span>${links.map((l) => `${SEP}${anchor(l.url, shortUrl(l.url))}`).join("")}</p>`;
}

function resumeContact(c) {
  const { main, email } = splitContact(c.contact);
  const links = (c.links || []).filter((l) => safeUrl(l.url)).map((l) => anchor(l.url, shortUrl(l.url)));
  const second = [email ? `<span data-f="contact2">${esc(email)}</span>` : "", ...links].filter(Boolean);
  return `<p class="contact"><span data-f="contact">${esc(main)}</span></p>
${second.length ? `<p class="contact">${second.join(SEP)}</p>` : ""}`;
}

export function renderResume(c = {}) {
  const pubs = c.publications || [];
  const early = c.early_career || [];
  return `<div class="doc resume">
<p class="name" data-f="name">${esc(c.name)}</p>
${c.headline ? `<p class="headline" data-f="headline">${esc(c.headline)}</p>` : ""}
${resumeContact(c)}
<h2>Summary</h2>
<p class="summary" data-f="summary">${esc(c.summary)}</p>
<h2>Core Competencies</h2>
${(c.skills || []).map((s) => `<p class="skill" data-skill><b data-f="label">${esc(s.label)}</b>: <span data-f="items">${esc(s.items)}</span></p>`).join("\n")}
<h2>Professional Experience</h2>
${(c.roles || []).map((r) => `<div class="job" data-role>
<div class="row"><span class="left"><b data-f="title">${esc(r.title)}</b> | <span data-f="org">${esc(r.org)}</span></span><span class="right" data-f="dates">${esc(r.dates)}</span></div>
<ul data-f="bullets">${li(r.bullets)}</ul>
</div>`).join("\n")}
${early.length ? `<h2>Early Career and Consulting Experience</h2>
<ul data-f="early">${li(early)}</ul>` : ""}
<h2>Education</h2>
${(c.education || []).map(eduItem).map((e) => { const { lead, rest } = splitEdu(e.text); return `<div class="row" data-edu><span class="left" data-f="text"><b>${esc(lead)}</b>${esc(rest)}</span><span class="right" data-f="dates">${esc(e.dates)}</span></div>`; }).join("\n")}
${pubs.length ? `<h2>Presentations and Publications</h2>
<div data-f="publications">${pubs.map((p) => `<p class="pub" data-pub><span data-f="pubtext">${esc(p.text)}</span>${safeUrl(p.url) ? `: ${anchor(p.url)}` : ""}</p>`).join("")}</div>` : ""}
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
  const pubItems = [...root.querySelectorAll('[data-f="publications"] [data-pub], [data-f="publications"] li')];
  return {
    name: f("name"),
    headline: f("headline"),
    contact: [f("contact"), f("contact2")].filter(Boolean).join(" | "),
    links: prev.links || [],
    summary: f("summary"),
    skills: [...root.querySelectorAll("[data-skill]")].map((s) => ({ label: f("label", s), items: f("items", s) })),
    roles: [...root.querySelectorAll("[data-role]")].map((r) => ({
      org: f("org", r), title: f("title", r), dates: f("dates", r),
      bullets: lines(r.querySelector('[data-f="bullets"]')),
    })),
    early_career: lines(root.querySelector('[data-f="early"]')),
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

// The owner's web links, from profile preferences, in display order. Each one is
// labeled with its own short address (never "Portfolio"), so the address reads
// correctly on paper and to resume screeners that ignore hyperlinks.
export function linksFromPrefs(prefs = {}) {
  return [prefs.linkedin_url, prefs.portfolio_url, prefs.website_url]
    .filter((url) => safeUrl(url)).map((url) => ({ label: shortUrl(url), url }));
}

// Plain text of a document, for checks (numbers, dashes) and word counts.
export function docText(kind, c = {}) {
  if (kind === "letter") {
    return [c.subject, c.greeting, ...(c.paragraphs || []), c.closing].filter(Boolean).join("\n");
  }
  return [c.summary,
    ...(c.skills || []).map((s) => `${s.label}: ${s.items}`),
    ...(c.roles || []).flatMap((r) => [r.org, r.title, ...(r.bullets || [])]),
    ...(c.early_career || []),
    ...(c.education || []).map((e) => eduItem(e).text),
    ...(c.publications || []).map((p) => p.text)].filter(Boolean).join("\n");
}

export const wordCount = (kind, c) => (docText(kind, c).match(/\S+/g) || []).length;
