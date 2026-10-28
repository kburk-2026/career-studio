// Pure helpers with no DOM access, so node:test can cover them.

// The six statuses the owner can set, in pipeline order.
export const STATUS = {
  IN_PROGRESS: "In progress",
  APPLIED: "Applied",
  INTERVIEWING: "Interviewing",
  INTERVIEW_DONE: "Interview completed",
  OFFER: "Offer",
  EMPLOYER_REJECTED: "Employer declined",
};
export const STATUS_KEYS = Object.keys(STATUS);

// Everything except In progress has gone to an employer.
export const SENT_STATUSES = new Set(STATUS_KEYS.filter((s) => s !== "IN_PROGRESS"));
export const LIVE_STATUSES = new Set(["INTERVIEWING", "INTERVIEW_DONE", "OFFER"]);

// The old tracker's EMAILED means Applied.
export const normStatus = (s) => (s === "EMAILED" ? "APPLIED" : s);

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);

// Unknown dates stay blank rather than being guessed.
export function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  if (Number.isNaN(+d)) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// Today's date in the viewer's time zone, as YYYY-MM-DD.
export function localToday(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function filterJobs(jobs, { query = "", status = "all", sort = "date" } = {}) {
  const q = query.trim().toLowerCase();
  const out = jobs.filter(
    (j) =>
      STATUS[normStatus(j.status)] &&
      (status === "all" || normStatus(j.status) === status) &&
      (!q || `${j.company} ${j.role_title}`.toLowerCase().includes(q)),
  );
  const bySort = {
    fit: (a, b) => (b.fit_score ?? -1) - (a.fit_score ?? -1),
    company: (a, b) => a.company.localeCompare(b.company),
    // In progress (no date yet) first, then most recent.
    date: (a, b) => String(b.applied_on || "9999").localeCompare(String(a.applied_on || "9999")),
  };
  return out.sort(bySort[sort] || bySort.date);
}

export function computeStats(jobs) {
  const known = jobs.filter((j) => STATUS[normStatus(j.status)]);
  const sent = known.filter((j) => SENT_STATUSES.has(normStatus(j.status)));
  const scored = known.filter((j) => j.fit_score != null);
  return {
    submitted: sent.length,
    inProgress: known.length - sent.length,
    interviewing: sent.filter((j) => LIVE_STATUSES.has(normStatus(j.status))).length,
    offers: sent.filter((j) => j.status === "OFFER").length,
    declined: sent.filter((j) => j.status === "EMPLOYER_REJECTED").length,
    avgFit: scored.length ? Math.round(scored.reduce((a, j) => a + j.fit_score, 0) / scored.length) : null,
  };
}

// Six-part fit rubric from JobHuntAgent: each 0-4, weighted, times 25.
export const RUBRIC = [
  ["core", "Core skills", 0.35],
  ["shape", "Role shape", 0.2],
  ["domain", "Domain", 0.15],
  ["scope", "Scope", 0.15],
  ["tools", "Tools", 0.1],
  ["quals", "Qualifications", 0.05],
];

export function fitFromBreakdown(b) {
  if (!b || RUBRIC.some(([k]) => !Number.isInteger(b[k]) || b[k] < 0 || b[k] > 4)) return null;
  return Math.round(RUBRIC.reduce((sum, [k, , w]) => sum + b[k] * w, 0) * 25);
}

// How complete the profile is, and what to add next to sharpen fit ratings.
export function profileStrength(prefs = {}, facts = []) {
  const checks = [
    [prefs.target_titles, "Target titles, so role shape scores reflect what you want"],
    [prefs.salary_min, "Desired salary range, so roles below it get flagged"],
    [prefs.arrangement, "Work arrangement (remote, hybrid, on-site)"],
    [prefs.location, "Location and relocation"],
    [prefs.industries_preferred, "Preferred industries"],
    [prefs.industries_avoid, "Industries to avoid, so they score lower"],
    [prefs.level, "Target level"],
    [facts.some((f) => f.kind === "skill" && f.verified), "At least one confirmed skill"],
    [facts.some((f) => f.kind === "result" && f.verified), "At least one confirmed result with a number"],
    [facts.some((f) => f.kind === "education"), "Education or certifications"],
  ];
  const done = checks.filter(([ok]) => ok !== undefined && ok !== null && ok !== "" && ok !== false).length;
  return { percent: Math.round((done / checks.length) * 100), missing: checks.filter(([ok]) => !ok).map(([, tip]) => tip) };
}
