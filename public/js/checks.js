// Checks on AI-written text, enforced in code rather than trusted to the prompt.
// Shared: the API runs them on every generated draft, and the editor re-runs
// them in the browser as the owner edits.
//
//   numbers   every number must appear in the evidence (confirmed facts, and
//             for job reviews, the posting itself)
//   dashes    no em or en dashes
//   titles    no job title the owner never held at the start of a summary
//   phrases   no filler phrases from the writing rules
import rules from "./rules.js";

// "4,000" -> "4000", "$2 million" keeps "2", "35,598" -> "35598", "3.5" kept.
export function numbersIn(text) {
  return (String(text).match(/\d[\d,]*(?:\.\d+)?/g) || []).map((n) => n.replace(/,/g, "").replace(/\.0+$/, ""));
}

const WORD_NUMBERS = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", twelve: "12", twenty: "20" };

export function evidenceNumbers(...sources) {
  const set = new Set();
  for (const s of sources) {
    for (const n of numbersIn(s)) set.add(n);
    for (const [word, digit] of Object.entries(WORD_NUMBERS)) if (new RegExp(`\\b${word}\\b`, "i").test(s)) set.add(digit);
  }
  return set;
}

export function checkText(text, evidence) {
  const issues = [];
  for (const n of numbersIn(text)) {
    if (/^(19|20)\d\d$/.test(n)) continue; // years in dates are checked by the editor, not here
    if (!evidence.has(n)) issues.push({ kind: "number", value: n, message: `"${n}" is not in your confirmed facts.` });
  }
  if (/[–—]/.test(text)) issues.push({ kind: "dash", message: "Contains an em or en dash." });
  for (const phrase of rules.banned_phrases) {
    if (new RegExp(`\\b${phrase}\\b`, "i").test(text)) issues.push({ kind: "phrase", value: phrase, message: `Uses the filler phrase "${phrase}".` });
  }
  return issues;
}

export function checkSummary(summary) {
  return rules.banned_title_claims.some((re) => new RegExp(re, "i").test(summary || ""))
    ? [{ kind: "title", message: "Summary opens with a title you have not held." }]
    : [];
}

// Replaces dashes in model output with a spaced hyphen before any check.
export const undash = (s) => String(s ?? "").replace(/\s*[–—]\s*/g, " - ");

export { rules };

// All checks for a resume or letter draft. `evidence` is the set of numbers
// from confirmed facts (see evidenceNumbers).
import { docText, wordCount } from "./doc.js";

export function checkDraft(kind, content, evidence) {
  const issues = checkText(docText(kind, content), evidence);
  if (kind === "resume") {
    issues.push(...checkSummary(content.summary));
    const words = wordCount(kind, content);
    const bullets = (content.roles || []).reduce((n, r) => n + (r.bullets || []).length, 0);
    if (words < 750) issues.push({ kind: "length", message: `About ${words} words; two pages usually needs 750 or more.` });
    if (words > 1350) issues.push({ kind: "length", message: `About ${words} words; this may run past two pages.` });
    if (bullets < 18) issues.push({ kind: "length", message: `${bullets} bullets; aim for at least 18.` });
  }
  // One message per distinct problem.
  const seen = new Set();
  return issues.filter((i) => !seen.has(i.message) && seen.add(i.message));
}
