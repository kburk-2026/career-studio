// Preference match: the posting's facts against the owner's job preferences.
// Pure code, no AI. Shown separately from fit, so a strong-skill role that pays
// too little is flagged instead of buried.

const money = (n) => `$${Math.round(n / 1000)}k`;
const words = (s) => String(s || "").toLowerCase().split(/[,;/]|\band\b|\bor\b/).map((w) => w.trim()).filter(Boolean);
const overlaps = (list, value) => {
  const v = String(value || "").toLowerCase();
  return v && words(list).some((w) => v.includes(w) || w.includes(v));
};

const LEVELS = { ic: "Individual contributor", manager: "Manager", senior: "Senior / Lead", director: "Director", executive: "Executive" };

export function preferenceMatch(prefs = {}, facts = {}) {
  const out = [];

  const arr = facts.arrangement;
  const want = String(prefs.arrangement || "").toLowerCase();
  if (!arr || arr === "unknown") out.push({ status: "warn", text: "Work arrangement not stated in posting" });
  else if (!want || want === "any") out.push({ status: "ok", text: `${cap(arr)}` });
  else if (want.includes(arr) || (arr === "remote" && want.includes("remote"))) out.push({ status: "ok", text: `${cap(arr)}, matches your preference` });
  else out.push({ status: "no", text: `${cap(arr)}; you prefer ${prefs.arrangement.toLowerCase()}` });

  const { salary_min: lo, salary_max: hi } = facts;
  if (!lo && !hi) out.push({ status: "warn", text: "Salary not listed in posting" });
  else if (!prefs.salary_min) out.push({ status: "ok", text: `Salary ${range(lo, hi)}` });
  else if ((hi || lo) < prefs.salary_min) out.push({ status: "no", text: `Salary ${range(lo, hi)} is below your ${money(prefs.salary_min)} minimum` });
  else if ((lo || hi) < prefs.salary_min) out.push({ status: "warn", text: `Salary ${range(lo, hi)} starts below your ${money(prefs.salary_min)} minimum` });
  else out.push({ status: "ok", text: `Salary ${range(lo, hi)} meets your minimum` });

  if (facts.industry) {
    if (prefs.industries_avoid && overlaps(prefs.industries_avoid, facts.industry)) out.push({ status: "no", text: `${facts.industry}: an industry you avoid` });
    else if (prefs.industries_preferred && overlaps(prefs.industries_preferred, facts.industry)) out.push({ status: "ok", text: `${facts.industry}: a preferred industry` });
    else if (prefs.industries_preferred) out.push({ status: "warn", text: `${facts.industry}: not in your preferred industries` });
    else out.push({ status: "ok", text: facts.industry });
  }

  if (facts.level && facts.level !== "unknown" && prefs.level) {
    const label = LEVELS[facts.level];
    out.push(label === prefs.level ? { status: "ok", text: `${label} level matches your target` } : { status: "warn", text: `${label} level; you target ${prefs.level}` });
  }

  return out;
}

function range(lo, hi) {
  if (lo && hi) return `${money(lo)} to ${money(hi)}`;
  return money(lo || hi);
}
function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
