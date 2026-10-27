// Pure helpers with no DOM access, so node:test can cover them.

export const STATUS = {
  APPLIED: "Applied",
  EMAILED: "Applied",
  INTERVIEWING: "Interviewing",
  OFFER: "Offer",
  EMPLOYER_REJECTED: "Employer declined",
};

// The dashboard shows sent applications only.
export const SENT_STATUSES = new Set(Object.keys(STATUS));

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);

export function statusClass(status) {
  if (status === "EMPLOYER_REJECTED") return "s-rejected";
  if (status === "INTERVIEWING") return "s-interviewing";
  if (status === "OFFER") return "s-offer";
  return "s-applied";
}

// Unknown dates stay blank rather than being guessed.
export function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  if (Number.isNaN(+d)) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function filterJobs(jobs, { query = "", status = "all", sort = "date" } = {}) {
  const q = query.trim().toLowerCase();
  const out = jobs.filter(
    (j) =>
      SENT_STATUSES.has(j.status) &&
      (status === "all" || j.status === status) &&
      (!q || `${j.company} ${j.role_title}`.toLowerCase().includes(q)),
  );
  const bySort = {
    fit: (a, b) => (b.fit_score ?? -1) - (a.fit_score ?? -1),
    company: (a, b) => a.company.localeCompare(b.company),
    date: (a, b) => String(b.applied_on || "").localeCompare(String(a.applied_on || "")),
  };
  return out.sort(bySort[sort] || bySort.date);
}

export function computeStats(jobs) {
  const sent = jobs.filter((j) => SENT_STATUSES.has(j.status));
  const scored = sent.filter((j) => j.fit_score != null);
  return {
    submitted: sent.length,
    interviewing: sent.filter((j) => j.status === "INTERVIEWING" || j.status === "OFFER").length,
    offers: sent.filter((j) => j.status === "OFFER").length,
    declined: sent.filter((j) => j.status === "EMPLOYER_REJECTED").length,
    avgFit: scored.length ? Math.round(scored.reduce((a, j) => a + j.fit_score, 0) / scored.length) : null,
  };
}
