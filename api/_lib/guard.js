// Checks on AI-written text, enforced in code rather than trusted to the prompt.
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
