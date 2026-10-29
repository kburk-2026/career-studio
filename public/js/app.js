import { pickSource } from "./data.js";
import { STATUS, STATUS_KEYS, LIVE_STATUSES, esc, formatDate, filterJobs, computeStats, RUBRIC, profileStrength, similarity } from "./format.js";
import { renderDoc, readDoc } from "./doc.js";
import { checkDraft, evidenceNumbers } from "./checks.js";
import { loadConfig, consumeRedirect, hasSession, getAccessToken, sendMagicLink, signOut } from "./auth.js";

const linkError = consumeRedirect();
const source = pickSource({ signedIn: hasSession(), getToken: getAccessToken });
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

let jobs = [];
let profile = { facts: [], prefs: {} };
let docs = [];
let lastFocus = null;
let resFilter = "all";

// Per-browser drafts (coach answers). Storage can be blocked, so never rely on it.
const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); return true; } catch { return false; } },
};

function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add("hidden"), 3000);
}

// Runs an action, reporting failures instead of leaving the UI half-updated.
async function attempt(fn, okText) {
  try {
    const out = await fn();
    if (okText) toast(source.mode === "demo" ? `${okText} (demo, not saved)` : okText);
    return out;
  } catch (e) {
    toast(e.message || "Something went wrong.");
    if (e.status === 401) setTimeout(() => location.reload(), 1500);
    return undefined;
  }
}

/* ---------- Applications ---------- */

const segs = (fit) => `<span class="segs" aria-hidden="true">${Array.from({ length: 10 }, (_, i) => `<i class="${fit != null && i < Math.round(fit / 10) ? "f" : ""}"></i>`).join("")}</span>`;
const statusSelect = (job, id) =>
  `<select class="statusselect" ${id ? `id="${id}"` : ""} data-job="${job.id}" data-s="${job.status}" aria-label="Status for ${esc(job.company)}">${STATUS_KEYS.map((k) => `<option value="${k}" ${k === job.status ? "selected" : ""}>${STATUS[k]}</option>`).join("")}</select>`;

function renderFigures() {
  const s = computeStats(jobs);
  $("#figs").innerHTML = [
    [s.submitted, "Applications"],
    [s.interviewing, "Interviewing", true],
    [s.offers, "Offers"],
    [s.avgFit ?? "--", "Average fit"],
  ].map(([n, label, hot]) => `<div class="fig"><b class="${hot && n ? "hot" : ""}">${n}</b><span>${label}</span></div>`).join("");
}

function renderRows() {
  const rows = filterJobs(jobs, { query: $("#search").value, status: $("#statusFilter").value, sort: $("#sort").value });
  $("#count").textContent = `${rows.length} of ${jobs.length} shown`;
  $("#rows").innerHTML = rows.length
    ? rows.map((j) => `<tr data-id="${j.id}" tabindex="0">
        <td><div class="company">${esc(j.company)}</div><div class="role">${esc(j.role_title)}</div></td>
        <td>${segs(j.fit_score)}<span class="fitnum">${j.fit_score ?? "--"}</span></td>
        <td class="date">${formatDate(j.applied_on)}</td>
        <td>${statusSelect(j)}</td>
        <td class="qcount"><b>${j.answer_count || 0}</b>${j.answer_count === 1 ? "answer" : "answers"}</td></tr>`).join("")
    : `<tr><td colspan="5" class="empty">No applications match. Use Add a job to start one.</td></tr>`;
  $$("#rows tr[data-id]").forEach((tr) => {
    const open = (e) => { if (!e.target.closest("select")) openJob(Number(tr.dataset.id)); };
    tr.addEventListener("click", open);
    tr.addEventListener("keydown", (e) => { if (e.key === "Enter") open(e); });
  });
  $$("#rows .statusselect").forEach((s) => s.addEventListener("change", () => changeStatus(Number(s.dataset.job), s.value)));
}

async function refreshJobs() {
  jobs = await source.listApplications();
  renderFigures();
  renderRows();
}

async function changeStatus(id, status) {
  const ok = await attempt(() => source.updateJob(id, { status }), `Status set to ${STATUS[status]}.`);
  await refreshJobs();
  if (ok && $("#drawerBg").classList.contains("open") && $("#drawerStatus")?.dataset.job === String(id)) openJob(id);
}

/* ---------- Drawer ---------- */

function openDrawer(html, wide = false) {
  const d = $("#drawer");
  d.classList.toggle("wide", wide);
  d.innerHTML = html;
  $$(".close", d).forEach((b) => (b.onclick = closeDrawer));
  $$(".expand", d).forEach((b) => (b.onclick = () => setFull(!d.classList.contains("full"))));
  setFull(store.get("panel_full") === "1");
  if (!$("#drawerBg").classList.contains("open")) lastFocus = document.activeElement;
  $("#drawerBg").classList.add("open");
  d.scrollTop = 0;
  $(".close", d)?.focus();
}

function closeDrawer() {
  $("#drawerBg").classList.remove("open");
  lastFocus?.focus?.();
}

const EXPAND_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M9.5 2H14v4.5M14 2l-5 5M6.5 14H2V9.5M2 14l5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="square"/></svg>`;
const COLLAPSE_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M14 6.5H9.5V2M9.5 6.5L15 1M2 9.5h4.5V14M6.5 9.5L1 15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="square"/></svg>`;
const head = (eyebrow, title, sub, extra = "") =>
  `<div class="drawer-head"><div>${eyebrow ? `<div class="eyebrow">${esc(eyebrow)}</div>` : ""}<h2>${esc(title)}</h2>${sub ? `<p class="role">${esc(sub)}</p>` : ""}${extra}</div><div class="headbtns"><button class="expand" aria-label="Expand panel" title="Expand">${EXPAND_ICON}</button><button class="close" aria-label="Close">&times;</button></div></div>`;

// The panel's full-screen choice is remembered in this browser.
function setFull(on) {
  $("#drawer").classList.toggle("full", on);
  store.set("panel_full", on ? "1" : "");
  $$("#drawer .expand").forEach((b) => { b.innerHTML = on ? COLLAPSE_ICON : EXPAND_ICON; b.setAttribute("aria-label", on ? "Shrink panel" : "Expand panel"); b.title = on ? "Shrink" : "Expand"; });
}

function rubricHtml(b) {
  if (!b) return "";
  const reasons = b.reasons ? `<details class="reasons"><summary>Why each score</summary><ul>${RUBRIC.map(([k, label]) => b.reasons[k] ? `<li><b>${label}:</b> ${esc(b.reasons[k])}</li>` : "").join("")}</ul></details>` : "";
  return `<div class="section"><h3>Why this fit score</h3><div class="rubric">${RUBRIC.map(([k, label, w]) =>
    `<div><span>${label} <span class="note">&times;${w}</span></span><span class="bar"><span style="width:${(b[k] ?? 0) * 25}%"></span></span><b>${b[k] ?? "-"}/4</b></div>`).join("")}</div>${reasons}</div>`;
}

function prefHtml(match) {
  if (!match?.length) return "";
  const mark = { ok: ["ok", "Yes"], warn: ["warn", "!"], no: ["no", "No"] };
  return `<div class="section"><h3>Preference match</h3><div class="prefs">${match.map((m) => {
    const [cls, sym] = mark[m.status] || mark.warn;
    return `<div class="pref"><span class="${cls}" aria-label="${m.status}">${sym}</span><span>${esc(m.text)}</span></div>`;
  }).join("")}</div></div>`;
}

const list = (items) => `<ul>${(items || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;

// The job panel's open tab, kept when the same job's panel re-renders
// (a status change, a new answer, coming back from the coach).
let panelTab = { id: null, tab: "overview" };

function wireTabs(jobId) {
  const tabs = $$("#drawer [role=tab]");
  const show = (t, focus = false) => {
    tabs.forEach((b) => {
      const on = b === t;
      b.setAttribute("aria-selected", on);
      b.tabIndex = on ? 0 : -1;
      $(`#pane-${b.dataset.tab}`).hidden = !on;
    });
    panelTab = { id: jobId, tab: t.dataset.tab };
    if (focus) t.focus();
  };
  tabs.forEach((b, i) => {
    b.onclick = () => show(b);
    b.onkeydown = (e) => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (step) { e.preventDefault(); show(tabs[(i + step + tabs.length) % tabs.length], true); }
    };
  });
  panelTab = { id: jobId, tab: tabs.find((b) => b.getAttribute("aria-selected") === "true")?.dataset.tab || "overview" };
}

async function openJob(id) {
  const job = jobs.find((j) => j.id === id);
  const d = await attempt(() => source.getApplication(id));
  if (!job || !d) return;
  docs = await source.listDocuments().catch(() => docs);
  const jobDocs = docs.filter((x) => x.job_id === id);
  const docBox = (kind) => {
    const label = kind === "resume" ? "Resume" : "Cover letter";
    const doc = jobDocs.filter((x) => x.kind === kind).sort((a, b) => Number(b.sent) - Number(a.sent))[0];
    return `<div class="docbox"><b>${label}${doc ? (doc.sent ? '<span class="badge b-sent">Sent</span>' : '<span class="badge b-draft">Draft</span>') : ""}</b>
      <small>${doc ? esc(doc.file_name || doc.title) : `No ${label.toLowerCase()} yet`}</small>
      <div class="btnrow">${doc ? `<button class="btn sm" data-open="${doc.id}">Open</button>` : ""}
      <button class="btn sm ${doc ? "" : "primary"}" data-gen="${kind}">${doc ? "New version" : "Generate"}</button></div></div>`;
  };

  // Tabs, in workflow order; the coach comes last. Every pane is rendered up
  // front (hidden when inactive) so the wiring below finds its elements.
  const panes = [
    ["overview", "Overview", `${rubricHtml(d.fit_breakdown)}
      ${prefHtml(d.pref_match)}
      ${d.strengths?.length || d.gaps?.length ? `<div class="section"><div class="cardhead"><h3>Match notes</h3><button class="linkbtn" data-quickadd>Have a skill that's missing? Add it</button></div><div class="match-grid"><div><b>Strengths</b>${list(d.strengths)}</div><div><b>Gaps</b>${list(d.gaps)}</div></div></div>` : ""}
      ${!d.fit_breakdown ? `<div class="section"><div class="notice">${d.jd_text || d.source_url ? `No fit review yet. <button class="btn sm primary" id="reviewJob" style="margin-left:8px">Review and score</button>` : "No posting text saved, so this job can't be reviewed. Add the posting to review it."}</div></div>` : ""}
      <div class="section"><h3>Application timeline</h3><ul>${(d.history || []).map((h) => `<li>${esc(STATUS[h.status] || h.status)} &middot; ${formatDate(h.at)}</li>`).join("") || "<li>No changes yet</li>"}</ul></div>`],
    ["docs", "Documents", `<div class="section"><h3>Tailored documents</h3><div class="docbtns">${docBox("resume")}${docBox("letter")}</div><p class="soon">Written from your confirmed profile and base resume. A resume takes about a minute.</p></div>`],
    ["questions", `Questions <span class="badge b-up">${d.answers.length}</span>`, `<div class="section"><h3>Application questions</h3><div id="qlist"></div>
      <form class="qform" id="qForm"><input id="qText" maxlength="2000" placeholder="Paste a question from the application" aria-label="Question"><input id="qLimit" type="number" min="1" placeholder="Char limit" aria-label="Character limit"></form>
      <div class="btnrow" style="margin-top:8px"><button class="btn sm primary" id="qDraft">Add and draft answer</button><button class="btn sm" id="qAdd">Add without drafting</button></div>
      <p class="soon">Drafts use your confirmed facts and this posting, and always fit the character limit.</p></div>`],
    ["posting", "Posting", `<div class="section"><h3>Job posting</h3>${d.source_url ? `<p class="note"><a href="${esc(d.source_url)}" target="_blank" rel="noopener noreferrer">${esc(d.source_url)}</a></p>` : ""}${d.jd_text ? `<div class="jd">${esc(d.jd_text)}</div>` : `<div class="notice">No posting text saved for this job.</div>`}</div>`],
    ...(job.status !== "EMPLOYER_REJECTED" ? [["coach", `${COACH_MINI}Coach`, `<div class="coach-cta">${COACH_ICON}<div><b>Interview Coach</b><p>${LIVE_STATUSES.has(job.status) ? "Prepare for this interview" : "Practice for this role"}: one question at a time, with feedback grounded in your profile.</p></div><button class="btn primary" id="openCoach">Open coach</button></div>`]] : []),
  ];
  const tab = panelTab.id === id && panes.some(([k]) => k === panelTab.tab) ? panelTab.tab : "overview";

  openDrawer(`
    ${head("", job.company, job.role_title, `<div class="detailmeta">${statusSelect(job, "drawerStatus")}<span>Applied ${formatDate(job.applied_on)}</span>${d.location ? `<span>${esc(d.location)}</span>` : ""}</div>`)}
    <div class="detailcards"><div class="dcard"><span>Fit score</span><b>${job.fit_score ?? "--"}</b></div><div class="dcard"><span>Screening odds</span><b>${job.odds_score ?? "--"}</b></div><div class="dcard"><span>Questions</span><b>${d.answers.length}</b></div></div>
    <div class="paneltabs" role="tablist" aria-label="Job sections">${panes.map(([k, label]) =>
      `<button role="tab" id="tab-${k}" aria-controls="pane-${k}" data-tab="${k}" aria-selected="${k === tab}" tabindex="${k === tab ? 0 : -1}">${label}</button>`).join("")}</div>
    ${panes.map(([k, , body]) => `<div class="tabpane" role="tabpanel" id="pane-${k}" aria-labelledby="tab-${k}" ${k === tab ? "" : "hidden"}>${body}</div>`).join("")}
  `);
  wireTabs(id);
  $("#drawerStatus").addEventListener("change", (e) => changeStatus(id, e.target.value));
  $("#openCoach")?.addEventListener("click", () => openCoach(job));
  $$("#drawer [data-quickadd]").forEach((b) => (b.onclick = () => openAdd("skill")));
  $("#reviewJob")?.addEventListener("click", async (e) => {
    e.target.disabled = true;
    e.target.textContent = "Reviewing…";
    const done = await attempt(() => source.reviewJob(id), "Review saved.");
    await refreshJobs();
    if (done) openJob(id); else { e.target.disabled = false; e.target.textContent = "Review and score"; }
  });
  $$("#drawer [data-open]").forEach((b) => (b.onclick = () => openDoc(Number(b.dataset.open), id)));
  $$("#drawer [data-gen]").forEach((b) => (b.onclick = async () => {
    const kind = b.dataset.gen;
    if (!d.jd_text) { toast("Add the posting text to this job first."); return; }
    $$("#drawer [data-gen]").forEach((x) => (x.disabled = true));
    b.textContent = "Writing…";
    toast(`Writing your tailored ${kind === "letter" ? "cover letter" : "resume"}. This takes about a minute.`);
    const out = await attempt(() => source.generateDoc(id, kind));
    if (!out) { $$("#drawer [data-gen]").forEach((x) => (x.disabled = false)); b.textContent = "Generate"; return; }
    await refreshDocs();
    openDoc(out.document.id, id);
  }));
  renderQuestions(id, d.answers);
  const add = async () => {
    const question = $("#qText").value.trim();
    if (!question) { $("#qText").focus(); return; }
    const char_limit = Number($("#qLimit").value) || null;
    const a = await attempt(() => source.addAnswer(id, { question, char_limit }), "Question added.");
    if (a) { d.answers.push(a); $("#qText").value = ""; $("#qLimit").value = ""; renderQuestions(id, d.answers); refreshJobs(); }
  };
  $("#qAdd").onclick = add;
  $("#qDraft").onclick = async () => {
    const question = $("#qText").value.trim();
    if (!question) { $("#qText").focus(); return; }
    const char_limit = Number($("#qLimit").value) || null;
    $("#qDraft").disabled = true;
    $("#qDraft").textContent = "Drafting…";
    const out = await attempt(() => source.draftAnswer(id, { question, char_limit }), "Draft ready. Edit it, then mark it as submitted.");
    $("#qDraft").disabled = false;
    $("#qDraft").textContent = "Add and draft answer";
    if (out) { d.answers.push({ ...out.answer, flags: out.flags }); $("#qText").value = ""; $("#qLimit").value = ""; renderQuestions(id, d.answers); refreshJobs(); }
  };
  $("#qForm").onsubmit = (e) => { e.preventDefault(); $("#qDraft").click(); };
}

function renderQuestions(jobId, answers) {
  const box = $("#qlist");
  if (!answers.length) {
    box.innerHTML = `<div class="noanswers">No questions yet. Paste one below.</div>`;
    return;
  }
  box.innerHTML = answers.map((a, i) => `<div class="qitem" data-i="${i}"><strong>${i + 1}. ${esc(a.question)}</strong>
    <textarea aria-label="Answer to question ${i + 1}" maxlength="20000">${esc(a.answer || "")}</textarea>
    ${a.flags?.length ? `<div class="guard w"><ul>${a.flags.map((f) => `<li>${esc(f.message)}</li>`).join("")}</ul></div>` : ""}
    <div class="qmeta"><span data-count></span><span class="btnrow">
      <button class="btn sm" data-save>Save</button>
      ${a.final ? "" : `<button class="btn sm" data-redraft>Redraft</button>`}
      <button class="btn sm" data-final>${a.final ? "Submitted" : "Mark as submitted"}</button>
      <button class="btn sm" data-del aria-label="Delete question ${i + 1}">Delete</button></span></div></div>`).join("");
  $$(".qitem", box).forEach((item) => {
    const a = answers[Number(item.dataset.i)];
    const ta = $("textarea", item);
    const count = () => {
      const n = ta.value.length;
      $("[data-count]", item).innerHTML = a.char_limit
        ? `<span class="${n > a.char_limit ? "error" : ""}">${n.toLocaleString()} / ${a.char_limit.toLocaleString()} characters</span>`
        : `${n.toLocaleString()} characters`;
    };
    count();
    ta.addEventListener("input", count);
    $("[data-save]", item).onclick = async () => {
      const saved = await attempt(() => source.updateAnswer(a.id, { answer: ta.value }), "Answer saved.");
      if (saved) { Object.assign(a, saved); renderQuestions(jobId, answers); }
    };
    $("[data-final]", item).onclick = async () => {
      if (a.char_limit && ta.value.length > a.char_limit) { toast("Over the character limit."); return; }
      const saved = await attempt(() => source.updateAnswer(a.id, { answer: ta.value, final: true }), "Saved as the final submitted answer.");
      if (saved) { Object.assign(a, saved); renderQuestions(jobId, answers); }
    };
    $("[data-redraft]", item)?.addEventListener("click", async (e) => {
      if (ta.value.trim() && !confirm("Replace this answer with a new draft?")) return;
      e.target.disabled = true;
      e.target.textContent = "Drafting…";
      const out = await attempt(() => source.redraftAnswer(a.id), "New draft ready.");
      if (out) Object.assign(a, out.answer, { flags: out.flags });
      renderQuestions(jobId, answers);
    });
    $("[data-del]", item).onclick = async () => {
      if (!confirm("Delete this question and its answer?")) return;
      if (await attempt(() => source.deleteAnswer(a.id), "Question deleted.")) {
        answers.splice(answers.indexOf(a), 1);
        renderQuestions(jobId, answers);
        refreshJobs();
      }
    };
  });
}

/* ---------- Add a job ---------- */

function reviewHtml(rv) {
  const flags = rv.flags?.length ? `<div class="guard w"><b>Check before relying on this:</b> ${rv.flags.map((f) => esc(f.message)).join(" ")}</div>` : "";
  return `<div class="detailcards" style="margin:16px 0 0"><div class="dcard"><span>Fit score</span><b>${rv.fit_score}</b></div><div class="dcard"><span>Screening odds</span><b>${rv.odds_score}</b></div><div class="dcard"><span>Gap</span><b>${rv.fit_score - rv.odds_score}</b></div></div>
    ${rv.fit_score - rv.odds_score >= 10 ? `<p class="soon">A gap of 10 or more means this employer screens hard: worth applying through a referral if you can.</p>` : ""}
    ${flags}
    <div class="section"><h3>Summary</h3><p>${esc(rv.summary)}</p></div>
    ${rubricHtml(rv.fit_breakdown)}
    ${prefHtml(rv.pref_match)}
    <div class="section"><div class="cardhead"><h3>Match notes</h3><button class="linkbtn" data-quickadd>Have a skill that's missing? Add it</button></div><div class="match-grid"><div><b>Strengths</b>${list(rv.strengths)}</div><div><b>Gaps</b>${list(rv.gaps)}</div></div></div>`;
}

function openAddJob() {
  openDrawer(`
    ${head("New job", "Review a posting", "Paste the job description or a link. The review uses only your confirmed profile.")}
    <div class="section">
      <div class="seg" id="addSeg" role="tablist"><button class="on" data-m="paste" role="tab">Paste text</button><button data-m="link" role="tab">Link</button></div>
      <div class="field wide" style="margin-top:14px" id="addPaste"><label for="j_text">Job description</label><textarea id="j_text" rows="10" maxlength="60000" placeholder="Paste the full posting"></textarea></div>
      <div class="field wide hidden" style="margin-top:14px" id="addLink"><label for="j_url">Posting link</label><input id="j_url" type="url" maxlength="2000" placeholder="https://"><div class="help">Works for most job boards. Some sites block automated reading; you'll be asked to paste the text instead.</div></div>
      <div class="savebar"><button class="btn primary" id="analyze">Review and score</button><button class="btn" id="saveRaw">Save without review</button><span class="note" id="analyzeNote"></span></div>
    </div>
    <div id="analysis"></div>`);
  let mode = "paste";
  $$("#addSeg button").forEach((b) => (b.onclick = () => {
    mode = b.dataset.m;
    $$("#addSeg button").forEach((x) => x.classList.toggle("on", x === b));
    $("#addPaste").classList.toggle("hidden", mode !== "paste");
    $("#addLink").classList.toggle("hidden", mode !== "link");
  }));
  const input = () => (mode === "link" ? { url: $("#j_url").value.trim() } : { text: $("#j_text").value.trim() });

  $("#analyze").onclick = async () => {
    const body = input();
    if (!body.url && !body.text) { (mode === "link" ? $("#j_url") : $("#j_text")).focus(); return; }
    $("#analyze").disabled = true;
    $("#analyzeNote").textContent = "Reading the posting and scoring it against your profile. This takes about 20 seconds.";
    const rv = await attempt(() => source.reviewPosting(body));
    $("#analyze").disabled = false;
    $("#analyzeNote").textContent = "";
    if (!rv) return;
    $("#analysis").innerHTML = `<div class="section"><h3>Review</h3>
      <div class="formgrid"><div class="field"><label for="r_company">Company</label><input id="r_company" maxlength="200" value="${esc(rv.company)}"></div>
      <div class="field"><label for="r_role">Role</label><input id="r_role" maxlength="200" value="${esc(rv.role_title)}"></div></div></div>
      ${reviewHtml(rv)}
      <div class="savebar"><button class="btn primary" id="saveNew">Save as In progress</button><button class="btn" id="skipNew">Not a fit, skip</button></div>`;
    $("#analysis").scrollIntoView({ behavior: "smooth", block: "start" });
    $("#saveNew").onclick = async () => {
      const fields = {
        company: $("#r_company").value, role_title: $("#r_role").value, location: rv.location || null,
        source_url: rv.source_url || (mode === "link" ? body.url : null), jd_text: rv.jd_text,
        fit_score: rv.fit_score, odds_score: rv.odds_score, fit_breakdown: rv.fit_breakdown,
        pref_match: rv.pref_match, posting_facts: rv.posting_facts, strengths: rv.strengths, gaps: rv.gaps,
      };
      const created = await attempt(() => source.createJob(fields), "Saved as In progress.");
      if (created) { await refreshJobs(); openJob(created.id); }
    };
    $("#skipNew").onclick = () => { closeDrawer(); toast("Skipped. Nothing was saved."); };
  };

  $("#saveRaw").onclick = () => {
    const body = input();
    $("#analysis").innerHTML = `<form class="section" id="rawForm"><h3>Save without review</h3><div class="formgrid">
      <div class="field"><label for="j_company">Company</label><input id="j_company" required maxlength="200"></div>
      <div class="field"><label for="j_role">Role</label><input id="j_role" required maxlength="200"></div></div>
      <div class="savebar"><button class="btn primary" type="submit">Save as In progress</button></div></form>`;
    $("#j_company").focus();
    $("#rawForm").onsubmit = async (e) => {
      e.preventDefault();
      const fields = { company: $("#j_company").value, role_title: $("#j_role").value, jd_text: body.text || null, source_url: body.url || null };
      const created = await attempt(() => source.createJob(fields), "Saved as In progress.");
      if (created) { await refreshJobs(); openJob(created.id); }
    };
  };
}

/* ---------- Documents ---------- */

function renderResumes() {
  const shown = docs.filter((d) => resFilter === "all" || (resFilter === "letter" ? d.kind === "letter" : d.source === resFilter && d.kind === "resume"));
  const base = docs.filter((d) => d.source === "uploaded" && d.kind === "resume" && !d.job_id).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
  $("#reslist").innerHTML = shown.length ? shown.map((d) => {
    const job = jobs.find((j) => j.id === d.job_id);
    return `<div class="resrow"><div class="ico2">${d.kind === "letter" ? "LTR" : "CV"}</div>
      <div><b>${esc(d.title)}<span class="badge ${d.source === "uploaded" ? "b-up" : "b-gen"}">${d.source === "uploaded" ? "Uploaded" : d.source === "built" ? "Built" : "Generated"}</span>${d === base ? '<span class="badge b-sent">Base resume</span>' : ""}${d.sent ? '<span class="badge b-sent">Sent</span>' : d.source !== "uploaded" ? '<span class="badge b-draft">Draft</span>' : ""}</b>
      <small>${esc(d.file_name || "")}${d.file_name ? " &middot; " : ""}${formatDate((d.sent_at || d.created_at || "").slice(0, 10))}${job ? ` &middot; ${esc(job.company)}` : ""}</small></div>
      <div class="btnrow"><button class="btn sm" data-open="${d.id}">Open</button></div></div>`;
  }).join("") : `<div class="notice">No documents here yet.${resFilter === "all" || resFilter === "uploaded" ? " Use Upload resume to add your base resume." : ""}</div>`;
  $$("#reslist [data-open]").forEach((b) => (b.onclick = () => openDoc(Number(b.dataset.open))));
}

async function refreshDocs() {
  docs = await source.listDocuments().catch(() => []);
  renderResumes();
}

async function openDoc(id, backJobId) {
  const doc = await attempt(() => source.getDocument(id));
  if (!doc) return;
  const job = jobs.find((j) => j.id === (backJobId ?? doc.job_id));
  const back = job ? `<button class="btn sm" id="backJob" style="margin-top:16px">Back to ${esc(job.company)}</button>` : "";

  if (!doc.content) {
    openDrawer(`${head(doc.kind === "letter" ? "Cover letter" : "Resume", doc.title, doc.file_name || "")}${back}
      <div class="section"><div class="notice">This is the original file${doc.sent ? " exactly as it was sent" : ""}. Originals stay as they are; to get an editable version, generate a tailored resume from a job.</div>
      <div class="btnrow" style="margin-top:12px">${doc.has_file ? `<button class="btn primary" id="dlFile">Download file</button>` : ""}</div></div>`);
    $("#dlFile")?.addEventListener("click", async () => {
      const url = await attempt(() => source.documentFileUrl(doc.id));
      if (url) location.href = url;
    });
    $("#backJob")?.addEventListener("click", () => openJob(job.id));
    return;
  }

  openDrawer(`${head(`${doc.kind === "letter" ? "Cover letter" : "Resume"}${job ? ` · ${job.company}` : ""}`, doc.title, doc.file_name || "")}
    ${back}
    ${doc.sent ? `<div class="guard w"><b>This is the version you sent.</b> It is locked. Editing makes a new copy.</div>` : `<div id="checks"></div>`}
    <div class="toolbar2">
      ${doc.sent ? "" : `<button class="btn sm" data-cmd="bold" aria-label="Bold"><b>B</b></button><button class="btn sm" data-cmd="italic" aria-label="Italic"><i>I</i></button><button class="btn sm" data-cmd="insertUnorderedList">List</button>`}
      <span style="flex:1"></span>
      <button class="btn sm" id="saveDoc">${doc.sent ? "Edit as new copy" : "Save"}</button>
      <button class="btn sm" id="dlPdf">Download PDF</button>
      <button class="btn sm" id="dlWord">Download Word</button>
      ${!doc.sent ? `<button class="btn primary sm" id="markSent">Mark as sent</button>` : ""}
    </div>
    <p class="soon" id="pages"></p>
    <div class="editor k-${doc.kind}" id="editor" contenteditable="${doc.sent ? "false" : "true"}" spellcheck="true" aria-label="Document editor">${renderDoc(doc.kind, doc.content)}</div>
    <p class="soon">Download PDF opens your browser's print dialog; choose Save as PDF. Edit any text in place, then Save.</p>`, true);

  // The same checks the server ran, re-run as you edit.
  const evidence = evidenceNumbers(...(profile.facts || []).filter((f) => f.verified).map((f) => f.text));
  const recheck = () => {
    const content = readDoc(doc.kind, $("#editor"), doc.content);
    if (!doc.sent) {
      const issues = checkDraft(doc.kind, content, evidence);
      $("#checks").innerHTML = issues.length
        ? `<div class="guard w"><b>Check before sending:</b><ul>${issues.map((i) => `<li>${esc(i.message)}</li>`).join("")}</ul></div>`
        : `<div class="guard"><b>Checks passed.</b> Every number appears in your confirmed facts, with no dashes, filler phrases, or unheld titles.</div>`;
    }
    const pages = estimatePages(doc.kind, $("#editor"));
    $("#pages").innerHTML = `About ${pages} page${pages === 1 ? "" : "s"}${doc.kind === "resume" && pages > 2 ? ` <span class="error">: over the two-page limit. Tighten wording or drop the least relevant bullet.</span>` : ""}`;
  };
  recheck();
  $("#editor").addEventListener("paste", (e) => pastePlain(e));
  let timer;
  $("#editor").addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(recheck, 600); });
  $("#dlWord").onclick = async () => {
    const file = await attempt(() => source.exportWord(doc.id));
    if (!file) return;
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(file.blob), download: file.name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  $("#backJob")?.addEventListener("click", () => openJob(job.id));
  $$("#drawer [data-cmd]").forEach((b) => (b.onclick = () => { document.execCommand(b.dataset.cmd); $("#editor").focus(); }));
  $("#saveDoc").onclick = async () => {
    if (doc.sent) {
      const copy = await attempt(() => source.copyDocument(doc.id), "Editable copy created.");
      if (copy) { await refreshDocs(); openDoc(copy.id, backJobId); }
      return;
    }
    const content = readDoc(doc.kind, $("#editor"), doc.content);
    if (await attempt(() => source.saveDocument(doc.id, { content }), "Saved.")) { doc.content = content; refreshDocs(); recheck(); }
  };
  $("#dlPdf").onclick = () => {
    $("#printArea").innerHTML = $("#editor").innerHTML;
    window.print();
  };
  $("#markSent")?.addEventListener("click", async () => {
    if (!confirm("Mark this as the version you sent? It will be locked for good.")) return;
    const content = readDoc(doc.kind, $("#editor"), doc.content);
    if (!(await attempt(() => source.saveDocument(doc.id, { content })))) return;
    if (await attempt(() => source.markSent(doc.id), "Marked as sent and locked.")) { await Promise.all([refreshDocs(), refreshJobs()]); openDoc(doc.id, backJobId); }
  });
}

// Pasting into the editor: plain text only, so it stays inside the section
// it was pasted into. Several lines pasted into a bullet list become bullets.
function pastePlain(e) {
  const text = (e.clipboardData || window.clipboardData)?.getData("text/plain");
  if (text == null) return;
  e.preventDefault();
  const lines = text.replace(/\r/g, "").split("\n").map((l) => l.trim().replace(/^[-*\u2022]\s*/, "")).filter(Boolean);
  const sel = window.getSelection();
  const li = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement)?.closest("li");
  if (li && lines.length > 1) {
    document.execCommand("insertText", false, lines[0]);
    let after = li;
    for (const line of lines.slice(1)) {
      const item = document.createElement("li");
      item.textContent = line;
      after.after(item);
      after = item;
    }
  } else {
    document.execCommand("insertText", false, lines.join(" "));
  }
  $("#editor").dispatchEvent(new Event("input"));
}

// Lays the document out at Letter size with its print margins and counts pages.
const PAGE = { resume: { width: 8.5 - 1.04, height: 11 - 0.76 }, letter: { width: 8.5 - 1.7, height: 11 - 1.4 } };
function estimatePages(kind, editor) {
  const probe = document.createElement("div");
  probe.style.cssText = `position:absolute;left:-10000px;top:0;width:${PAGE[kind].width}in;visibility:hidden`;
  probe.innerHTML = editor.innerHTML;
  document.body.appendChild(probe);
  const height = probe.getBoundingClientRect().height;
  probe.remove();
  return Math.max(1, Math.ceil(height / (PAGE[kind].height * 96) - 0.02));
}

/* ---------- Profile ---------- */

const PREF_INTS = ["salary_min", "salary_target"];

function fillPrefs(prefs) {
  for (const el of $("#prefsForm").elements) {
    if (!el.name) continue;
    const value = prefs[el.name];
    el.value = value === null || value === undefined ? "" : String(value);
  }
}

function readPrefs() {
  const out = {};
  for (const el of $("#prefsForm").elements) {
    if (!el.name) continue;
    const raw = el.value.trim();
    if (PREF_INTS.includes(el.name)) out[el.name] = raw ? Number(raw.replace(/[^0-9]/g, "")) || null : null;
    else if (el.name === "needs_sponsorship") out[el.name] = raw === "" ? null : raw === "true";
    else out[el.name] = raw || null;
  }
  return out;
}

// One fact as a quiet row: no badge when confirmed, an amber dot and a
// Confirm button when not. Edit swaps the text for an input in place.
function factRow(f, { showGroup = false } = {}) {
  return `<div class="item ${f.verified ? "" : "pending"}" data-fact="${f.id}">
    <span class="ftext">${f.verified ? "" : '<span class="dot" aria-label="Unverified"></span>'}${esc(f.text)}${/^https:\/\//.test(f.url || "") ? ` <a class="factlink" href="${esc(f.url)}" target="_blank" rel="noopener noreferrer">Link</a>` : ""}${showGroup && f.group && !["Other", "Education", "Summary"].includes(f.group) ? ` <span class="note">${esc(f.group)}</span>` : ""}</span>
    <span class="acts">${f.verified ? "" : `<button class="confirm" data-confirm="${f.id}">Confirm</button>`}<button data-edit="${f.id}">Edit</button><button data-del="${f.id}">Remove</button></span></div>`;
}

const groupsOf = (list) => [...new Set(list.map((f) => f.group))].map((g) => [g, list.filter((f) => f.group === g)]);

function renderProfile() {
  const facts = profile.facts || [];
  const strength = profileStrength(profile.prefs || {}, facts);
  $("#strengthBar").style.width = `${strength.percent}%`;
  $("#strengthText").textContent = strength.missing.length ? `${strength.percent}% complete. Add these to sharpen your fit ratings:` : "Complete.";
  $("#strengthTips").innerHTML = strength.missing.slice(0, 4).map((t) => `<li>${esc(t)}</li>`).join("");

  // Everything not yet confirmed waits in one place.
  const queue = facts.filter((f) => !f.verified && f.kind !== "role" && f.kind !== "summary");
  $("#reviewQueue").innerHTML = queue.length
    ? `<div class="queue"><h3>Needs your review · ${queue.length}</h3><p class="sub">Only confirmed facts are used in resumes, letters, answers, and the coach.</p>
       ${queue.map((f) => factRow(f, { showGroup: true })).join("")}
       ${queue.length > 1 ? `<div class="btnrow" style="margin-top:12px"><button class="btn sm primary" id="confirmAll">Confirm all ${queue.length}</button></div>` : ""}</div>`
    : "";

  const results = facts.filter((f) => f.kind === "result" && f.verified);
  $("#resultsGrid").innerHTML = results.length
    ? groupsOf(results).map(([g, l]) => `<div class="label">${esc(g)}<small>${l.length} result${l.length === 1 ? "" : "s"}</small></div><div class="list">${l.map((f) => factRow(f)).join("")}</div>`).join("")
    : `<p class="sub">No confirmed results yet.</p>`;

  const skills = facts.filter((f) => f.kind === "skill" && f.verified);
  $("#skillCols").innerHTML = skills.length
    ? groupsOf(skills).map(([g, l]) => `<div class="skillgroup"><b>${esc(g)}</b>${l.map((f) => `<button class="skill" data-pick="${f.id}" aria-expanded="false">${esc(f.text)}</button><span class="skillacts" data-acts="${f.id}" hidden><button data-edit="${f.id}">Edit</button><button data-del="${f.id}">Remove</button></span>`).join("")}</div>`).join("")
    : `<p class="sub">No confirmed skills yet.</p>`;

  $("#education").innerHTML = facts.filter((f) => f.kind === "education" && f.verified).map((f) => factRow(f)).join("") || `<p class="sub">None yet.</p>`;
  $("#publications").innerHTML = facts.filter((f) => f.kind === "publication" && f.verified).map((f) => factRow(f)).join("") || `<p class="sub">None yet. Add a talk, article, or project you can link to.</p>`;

  wireFacts($("#profile"));
}

// Confirm, edit, remove, and pick handlers for any container of fact rows.
function wireFacts(root) {
  const facts = () => profile.facts;
  const find = (id) => facts().find((f) => f.id === Number(id));
  $$("[data-confirm]", root).forEach((b) => (b.onclick = async () => {
    if (await attempt(() => source.updateFact(Number(b.dataset.confirm), { verified: true }), "Confirmed. It can now be used in documents.")) {
      find(b.dataset.confirm).verified = true;
      renderProfile();
    }
  }));
  $("#confirmAll", root)?.addEventListener("click", async () => {
    const queue = facts().filter((f) => !f.verified && f.kind !== "role" && f.kind !== "summary");
    if (!confirm(`Confirm all ${queue.length} items as accurate?`)) return;
    for (const f of queue) if (await attempt(() => source.updateFact(f.id, { verified: true }))) f.verified = true;
    toast("Confirmed.");
    renderProfile();
  });
  $$("[data-del]", root).forEach((b) => (b.onclick = async () => {
    const f = find(b.dataset.del);
    if (f.verified && !confirm(`Remove "${f.text}" from your profile?`)) return;
    if (await attempt(() => source.deleteFact(f.id), "Removed.")) { profile.facts = facts().filter((x) => x.id !== f.id); renderProfile(); }
  }));
  $$("[data-pick]", root).forEach((b) => (b.onclick = () => {
    const acts = $(`[data-acts="${b.dataset.pick}"]`, root);
    acts.hidden = !acts.hidden;
    b.setAttribute("aria-expanded", String(!acts.hidden));
  }));
  $$("[data-edit]", root).forEach((b) => (b.onclick = () => {
    const f = find(b.dataset.edit);
    const host = b.closest(".item") || b.closest(".skillacts");
    const form = document.createElement("form");
    form.className = "editrow";
    form.innerHTML = `<input maxlength="1000" aria-label="Edit text"><button class="btn sm primary">Save</button><button class="btn sm" type="button">Cancel</button>`;
    form.querySelector("input").value = f.text;
    host.replaceWith(form);
    form.querySelector("input").focus();
    form.querySelector("[type=button]").onclick = renderProfile;
    form.onsubmit = async (e) => {
      e.preventDefault();
      const text = form.querySelector("input").value.trim();
      if (!text || text === f.text) { renderProfile(); return; }
      const saved = await attempt(() => source.updateFact(f.id, { text }), "Saved. Edited facts go back to your review queue.");
      if (saved) Object.assign(f, { text, verified: false });
      renderProfile();
    };
  }));
}

/* ---------- Add a skill, result, or education from anywhere ---------- */

const ADD_KINDS = {
  skill: { label: "Skill", group: "Group", placeholder: "e.g. Articulate Rise", groupHint: "e.g. Learning technology" },
  result: { label: "Result or responsibility", group: "Employer", placeholder: "e.g. Cut review rounds from 3 to 2 across 40 courses", groupHint: "e.g. Lakeside College" },
  education: { label: "Degree or certification", group: "", placeholder: "e.g. Certificate in Product Management, Cornell University" },
  publication: { label: "Presentation or publication", group: "", url: true, placeholder: "e.g. Designing review checklists that stick, OLC Accelerate 2025" },
};
let addKind = "skill";

function setAddKind(kind) {
  addKind = kind;
  const k = ADD_KINDS[kind];
  $$("#addKind button").forEach((b) => { b.classList.toggle("on", b.dataset.k === kind); b.setAttribute("aria-checked", String(b.dataset.k === kind)); });
  $("#addTextLabel").textContent = k.label;
  $("#addText").placeholder = k.placeholder;
  $("#addGroupField").hidden = !k.group;
  $("#addGroupLabel").textContent = k.group;
  $("#addGroup").placeholder = k.groupHint || "";
  $("#addGroupHelp").hidden = kind !== "skill";
  $("#addUrlField").classList.toggle("hidden", !k.url);
  $("#addGroupList").innerHTML = [...new Set((profile.facts || []).filter((f) => f.kind === kind).map((f) => f.group))].map((g) => `<option value="${esc(g)}">`).join("");
}

function openAdd(kind = "skill") {
  setAddKind(kind);
  $("#addText").value = "";
  $("#addGroup").value = "";
  $("#addUrl").value = "";
  $("#addConfirm").checked = false;
  $("#addDlg").showModal();
  $("#addText").focus();
}

// Starts a new skill group: the dialog opens with the group name first.
function openNewGroup() {
  openAdd("skill");
  $("#addGroupLabel").textContent = "New group name";
  $("#addGroup").focus();
}

async function submitAdd() {
  const text = $("#addText").value.trim();
  if (!text) { $("#addText").focus(); return; }
  const group = $("#addGroup").value.trim() || ({ education: "Education", skill: "Skills", publication: "Publications" }[addKind] || "Other");
  const url = $("#addUrl").value.trim();
  if (url && !/^https:\/\//i.test(url)) { $("#addUrl").focus(); toast("Links must start with https://."); return; }
  const fact = { kind: addKind, group, text, ...(url ? { url } : {}) };
  const confirmed = $("#addConfirm").checked;
  const out = confirmed
    ? await attempt(() => source.confirmFacts([fact], "app"), "Added and confirmed.")
    : await attempt(() => source.addFact(fact), "Added to your review queue on Profile.");
  if (!out) return;
  profile.facts.push(...(out.facts || [out]));
  renderProfile();
  $("#addDlg").close();
}

/* ---------- Interview coach ---------- */

// Two people talking, with a green speech bubble.
const COACH_ICON = `<svg class="coach-icon" viewBox="0 0 64 48" width="56" height="42" aria-hidden="true">
  <circle cx="14" cy="16" r="6" fill="#2C2C2C"/><path d="M3 44c0-9 5-15 11-15s11 6 11 15z" fill="#2C2C2C"/>
  <circle cx="50" cy="16" r="6" fill="#2C2C2C"/><path d="M39 44c0-9 5-15 11-15s11 6 11 15z" fill="#2C2C2C"/>
  <path d="M22 2h20a5 5 0 0 1 5 5v8a5 5 0 0 1-5 5h-8l-6 5v-5h-6a5 5 0 0 1-5-5V7a5 5 0 0 1 5-5z" fill="#8BE02E"/>
  <circle cx="26" cy="11" r="1.8" fill="#2C2C2C"/><circle cx="32" cy="11" r="1.8" fill="#2C2C2C"/><circle cx="38" cy="11" r="1.8" fill="#2C2C2C"/>
</svg>`;
const COACH_MINI = COACH_ICON.replace('class="coach-icon" viewBox="0 0 64 48" width="56" height="42"', 'class="coach-mini" viewBox="0 0 64 48" width="24" height="18"');

// Dictation through the browser's own speech recognition (Chrome, Edge, Safari).
const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;

const DICTATION_FALLBACK = "Dictation works in Chrome and Safari. In any browser you can also use Mac dictation: click in the answer box and press the Globe (fn) key twice.";
const DICTATION_ERRORS = {
  "not-allowed": "Microphone access was blocked. Allow it in your browser's site settings, then try again.",
  "service-not-allowed": "This browser's speech recognition is turned off. In Safari, turn on Dictation in System Settings > Keyboard, then try again.",
  network: `This browser couldn't reach its speech service (common in Brave and some other browsers). ${DICTATION_FALLBACK}`,
  "audio-capture": "No microphone was found. Check that one is connected and selected in System Settings > Sound.",
  "no-speech": "No speech was heard. Check that the right microphone is selected in System Settings > Sound, then try again.",
  "language-not-supported": `Speech recognition doesn't support English (US) in this browser. ${DICTATION_FALLBACK}`,
};

function wireDictation(ta, button, note) {
  if (!Speech) { button.hidden = true; return; }
  let rec = null;
  let base = "";
  const stop = () => { rec?.stop(); };
  button.onclick = () => {
    if (rec) { stop(); return; }
    rec = new Speech();
    rec.lang = "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    base = ta.value ? `${ta.value.replace(/\s+$/, "")} ` : "";
    let heard = false, failed = false;
    // Some browsers turn the microphone on but never return words (their
    // speech service is missing or switched off), so say so after a while.
    const quiet = setTimeout(() => { if (rec && !heard) note.textContent = `Not getting any words back yet. ${DICTATION_FALLBACK}`; }, 8000);
    rec.onresult = (e) => {
      heard = true;
      let finalText = "", interim = "";
      for (let i = 0; i < e.results.length; i++) (e.results[i].isFinal ? (finalText += e.results[i][0].transcript) : (interim += e.results[i][0].transcript));
      ta.value = base + finalText + interim;
      ta.dispatchEvent(new Event("input"));
      note.textContent = "Listening… edit the text before you submit.";
    };
    rec.onerror = (e) => { failed = true; note.textContent = DICTATION_ERRORS[e.error] || `Dictation stopped (${e.error}). ${DICTATION_FALLBACK}`; };
    rec.onend = () => {
      clearTimeout(quiet);
      if (!heard && !failed) note.textContent = `Dictation ended without hearing any words. ${DICTATION_FALLBACK}`;
      rec = null; button.textContent = "Dictate"; button.setAttribute("aria-pressed", "false"); button.classList.remove("listening");
    };
    rec.start();
    button.textContent = "Stop dictating";
    button.setAttribute("aria-pressed", "true");
    button.classList.add("listening");
    note.textContent = "Listening… speak your answer. Edit the text before you submit.";
  };
}

const STATE_NOTE = {
  AWAIT_ANSWER: "Answer the question below.",
  AWAIT_FOLLOWUP: "Answer the follow-up below.",
  ASK_MAIN: "Ready for the next question.",
  DONE: "Session ended.",
};

function transcriptText(job, data) {
  return [`Practice interview: ${job.company}, ${job.role_title}`, ""].concat(data.turns.flatMap((t) => [
    `${t.kind === "followup" ? "Follow-up" : "Question"}: ${t.question}`,
    ...(t.answer ? [`My answer: ${t.answer}`, `Score: ${t.critique?.score ?? "-"}/5`, `Stronger answer: ${t.improved_answer || ""}`] : []),
    "",
  ])).join("\n");
}

async function openCoach(job, data) {
  data ||= await attempt(() => source.getCoach(job.id));
  if (!data) return;
  const s = data.session;
  const back = `<button class="btn sm" id="backJob" style="margin-top:16px">Back to ${esc(job.company)}</button>`;

  if (!s) {
    openDrawer(`${head(`Interview Coach · ${job.company}`, "Practice interview", job.role_title)}${back}
      <div class="section"><div class="coach-hero">${COACH_ICON}<div class="notice">The coach reads this posting and your confirmed profile, then gives you prep (what the hiring team needs, the likely concern, and STAR stories from your facts) and asks one question at a time. After each answer you get feedback, a stronger version, and one follow-up. About 5 cents to start and 2 to 3 cents per answer.</div></div>
      <div class="savebar"><button class="btn primary" id="coachStart">Start practice interview</button></div></div>`, true);
    $("#backJob").onclick = () => openJob(job.id);
    $("#coachStart").onclick = async (e) => {
      e.target.disabled = true;
      e.target.textContent = "Preparing… about 30 seconds";
      const out = await attempt(() => source.coachStart(job.id));
      if (out) openCoach(job, out); else { e.target.disabled = false; e.target.textContent = "Start practice interview"; }
    };
    return;
  }

  const prep = s.prep || {};
  const draftKey = `${source.mode}_coach_${s.id}`;
  const open = data.turns.filter((t) => !t.answered_at).pop();
  const turnHtml = (t) => {
    const label = t.kind === "followup" ? "Follow-up" : `Question ${data.turns.filter((x) => x.kind === "main" && x.position <= t.position).length} of ${data.max_main}`;
    if (!t.answered_at) {
      return `<article class="turn current"><p class="eyebrow">${label}</p><p class="coach-question">${esc(t.question)}</p>
        <textarea class="coach-answer" id="coachAnswer" maxlength="8000" aria-label="Your answer" placeholder="Answer as you would out loud. About 60 to 90 seconds.">${esc(store.get(draftKey) || "")}</textarea>
        <div class="btnrow" style="margin-top:8px"><button class="btn primary" id="coachSubmit">Get feedback</button><button class="btn" id="coachMic" type="button" aria-pressed="false">Dictate</button><span class="note" id="coachNote"></span></div>
        <p class="soon">Dictation uses your browser's speech service (Google in Chrome, Apple in Safari), not Career Studio.</p></article>`;
    }
    const c = t.critique || {};
    return `<article class="turn"><p class="eyebrow">${label}</p><p class="coach-question">${esc(t.question)}</p>
      <details><summary>Your answer</summary><p class="mine">${esc(t.answer)}</p></details>
      <div class="feedback"><p><b class="scorebadge">${c.score ?? "-"}/5</b></p>
        ${c.worked?.length ? `<p class="groupname">What worked</p><ul>${c.worked.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
        ${c.improve?.length ? `<p class="groupname">Improve</p><ul>${c.improve.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
        ${t.improved_answer ? `<p class="groupname">A stronger version</p><p class="improved">${esc(t.improved_answer)}</p>` : ""}
        ${t.guard_flags?.length ? `<div class="guard w"><b>Check:</b> ${t.guard_flags.map((f) => esc(f.message)).join(" ")}</div>` : ""}
        ${c.new_facts?.length ? `<p class="groupname">New facts you mentioned</p><ul>${c.new_facts.map((f, i) => `<li>${esc(f)} <button class="linkbtn" data-newfact="${t.id}:${i}">add to profile as unverified</button></li>`).join("")}</ul>` : ""}
      </div></article>`;
  };

  openDrawer(`${head(`Interview Coach · ${job.company}`, "Practice interview", job.role_title)}${back}
    <details class="section prep" ${data.turns.length <= 1 ? "open" : ""}><summary><h3 style="display:inline">Prep</h3></summary>
      <h3>What the hiring team needs most</h3><ul>${(prep.priorities || []).map((p) => `<li><b>${esc(p.title)}:</b> ${esc(p.detail)}</li>`).join("")}</ul>
      <h3>Likely concern</h3><p>${esc(prep.concern || "")}</p>
      <h3>Your stories</h3>${(prep.stories || []).map((x, i) => `<div class="story"><b>${i + 1}. ${esc(x.title)}</b>${x.priority ? ` <span class="note">(${esc(x.priority)})</span>` : ""}<p><b>S/T:</b> ${esc(x.situation)} <b>A:</b> ${esc(x.action)} <b>R:</b> ${esc(x.result)}</p></div>`).join("")}
    </details>
    <div class="section"><h3>Interview <span class="note">${esc(STATE_NOTE[s.state] || "")}</span></h3>${data.turns.map(turnHtml).join("")}</div>
    <div class="btnrow" style="margin:6px 0 24px">
      ${s.state === "ASK_MAIN" ? `<button class="btn primary" id="coachNext">Next question (${s.main_count + 1} of ${data.max_main})</button>` : ""}
      ${s.state === "DONE" ? `<button class="btn primary" id="coachRestart">Start a new session</button>` : `<button class="btn" id="coachEnd">End session</button>`}
      <button class="btn" id="coachCopy">Copy transcript</button>
      <button class="btn" id="coachDelete">Delete session</button>
    </div>`, true);

  $("#backJob").onclick = () => openJob(job.id);
  const ta = $("#coachAnswer");
  if (ta) {
    wireDictation(ta, $("#coachMic"), $("#coachNote"));
    ta.addEventListener("input", () => store.set(draftKey, ta.value));
    $("#coachSubmit").onclick = async () => {
      const answer = ta.value.trim();
      if (answer.length < 20) { ta.focus(); $("#coachNote").textContent = "Write a fuller answer first."; return; }
      $("#coachSubmit").disabled = true;
      $("#coachNote").textContent = "Reviewing your answer… about 20 seconds";
      const out = await attempt(() => source.coachAnswer(s.id, answer));
      if (!out) { $("#coachSubmit").disabled = false; $("#coachNote").textContent = ""; return; }
      store.set(draftKey, "");
      openCoach(job, out);
    };
    ta.focus();
  }
  $("#coachNext")?.addEventListener("click", async (e) => {
    e.target.disabled = true;
    e.target.textContent = "Thinking of the next question…";
    const out = await attempt(() => source.coachNext(s.id));
    openCoach(job, out || undefined);
  });
  $("#coachEnd")?.addEventListener("click", async () => { const out = await attempt(() => source.coachEnd(s.id), "Session ended."); if (out) openCoach(job, out); });
  $("#coachRestart")?.addEventListener("click", async (e) => {
    e.target.disabled = true;
    e.target.textContent = "Preparing… about 30 seconds";
    const out = await attempt(() => source.coachStart(job.id));
    openCoach(job, out || undefined);
  });
  $("#coachCopy").onclick = async () => {
    try { await navigator.clipboard.writeText(transcriptText(job, data)); toast("Transcript copied."); } catch { toast("Your browser blocked copying."); }
  };
  $("#coachDelete").onclick = async () => {
    if (!confirm("Delete this practice session and all its answers?")) return;
    if (await attempt(() => source.coachDelete(s.id), "Session deleted.")) openCoach(job, { session: null, turns: [], max_main: data.max_main });
  };
  $$("#drawer [data-newfact]").forEach((b) => (b.onclick = async () => {
    const [tid, i] = b.dataset.newfact.split(":");
    const text = data.turns.find((t) => String(t.id) === tid).critique.new_facts[Number(i)];
    const f = await attempt(() => source.addFact({ kind: "result", group: "From practice interviews", text }), "Added as unverified. Confirm it on your Profile.");
    if (f) { profile.facts.push(f); b.replaceWith(Object.assign(document.createElement("span"), { className: "note", textContent: "added, unverified" })); }
  }));
  if (open) $("#drawer").scrollTop = $("#drawer").scrollHeight;
}

/* ---------- Start: upload a resume or build one ---------- */

const norm = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function openUpload() {
  $("#startArea").innerHTML = `<div class="card" style="margin-top:16px">
    <h3>Upload your resume</h3><p class="sub">PDF or Word (.docx), up to 4 MB. It also becomes your base resume: tailored resumes copy its format, dates, and header.</p>
    <label class="drop" for="fileIn"><input type="file" id="fileIn" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden><b>Choose a file</b><br>Claude reads it and lists what it found. You choose what goes into your profile.</label>
    <div id="upStatus"></div><div id="upResult"></div></div>`;
  $("#fileIn").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    $("#upStatus").innerHTML = `<div class="thinking"><span class="spin"></span>Reading ${esc(file.name)}. This takes about 30 seconds.</div>`;
    const out = await attempt(() => source.uploadResume(file));
    $("#upStatus").innerHTML = "";
    if (out) { showExtracted(out.extracted); refreshDocs(); }
  };
}

function showExtracted(x) {
  const existing = (profile.facts || []).map((f) => f.text);
  const known = new Set(existing.map(norm));
  // Exact matches, or close rewordings (most of the meaningful words shared).
  const isKnown = (t) => known.has(norm(t)) || existing.some((e) => similarity(t, e) >= 0.75);
  const items = [
    ...(x.summary ? [{ kind: "summary", group: "Summary", text: x.summary }] : []),
    ...x.roles.map((r) => ({ kind: "role", group: r.org, text: `${r.title}, ${r.org}${r.dates ? ` (${r.dates})` : ""}` })),
    ...x.results.map((r) => ({ kind: "result", group: r.employer, text: r.text })),
    ...x.skills.flatMap((g) => g.items.map((t) => ({ kind: "skill", group: g.group, text: t }))),
    ...x.education.map((e) => ({ kind: "education", group: "Education", text: e.dates ? `${e.text} (${e.dates})` : e.text })),
  ].map((it, i) => ({ ...it, i, dup: isKnown(it.text) }));
  const SECTIONS = [["summary", "Summary"], ["role", "Roles"], ["result", "Results and responsibilities"], ["skill", "Skills"], ["education", "Education"]];
  const fresh = items.filter((it) => !it.dup).length;
  $("#upResult").innerHTML = `<div class="section"><h3>Found ${items.length} items${fresh < items.length ? `, ${items.length - fresh} similar to what's already in your profile` : ""}</h3>
    <p class="sub">Untick anything that isn't right. Only ticked items join your profile, as confirmed.</p>
    <div class="btnrow" style="margin:10px 0"><button class="btn sm" id="tickAll">Tick all new</button><button class="btn sm" id="tickNone">Untick all</button></div>
    ${SECTIONS.map(([kind, title]) => {
      const group = items.filter((it) => it.kind === kind);
      return group.length ? `<p class="groupname" style="margin:14px 0 6px">${title}</p><ul class="picklist">${group.map((it) => `<li><label><input type="checkbox" data-i="${it.i}" ${it.dup ? "" : "checked"}> ${esc(it.text)}${it.group && !["Summary", "Education"].includes(it.group) && kind !== "role" ? ` <span class="note">(${esc(it.group)})</span>` : ""}${it.dup ? ' <span class="note">similar to an item in your profile</span>' : ""}</label></li>`).join("")}</ul>` : "";
    }).join("")}
    <div class="savebar"><button class="btn primary" id="confirmUp"></button></div></div>`;
  const boxes = () => $$("#upResult input[type=checkbox]");
  const count = () => { const n = boxes().filter((b) => b.checked).length; $("#confirmUp").textContent = `Add ${n} item${n === 1 ? "" : "s"} to my profile`; $("#confirmUp").disabled = !n; };
  boxes().forEach((b) => b.addEventListener("change", count));
  $("#tickAll").onclick = () => { boxes().forEach((b) => (b.checked = !items[Number(b.dataset.i)].dup)); count(); };
  $("#tickNone").onclick = () => { boxes().forEach((b) => (b.checked = false)); count(); };
  count();
  $("#confirmUp").onclick = async () => {
    const chosen = boxes().filter((b) => b.checked).map((b) => items[Number(b.dataset.i)]).map(({ kind, group, text }) => ({ kind, group, text }));
    const out = await attempt(() => source.confirmFacts(chosen, "upload"), `Added ${chosen.length} confirmed items to your profile.`);
    if (!out) return;
    profile.facts.push(...out.facts);
    renderProfile();
    $("#startArea").innerHTML = "";
    go("profile");
  };
}

function openBuild() {
  const roleRow = () => `<div class="card buildrole" style="background:var(--deep)"><div class="formgrid">
    <div class="field"><label>Employer</label><input data-b="org" maxlength="120"></div>
    <div class="field"><label>Title</label><input data-b="title" maxlength="120"></div>
    <div class="field"><label>Dates</label><input data-b="dates" maxlength="60" placeholder="e.g. March 2024 - Present"></div>
    <div class="field wide"><label>Results and responsibilities (one per line, with numbers where you have them)</label><textarea data-b="results" rows="4" maxlength="6000"></textarea></div></div></div>`;
  $("#startArea").innerHTML = `<form class="card" id="buildForm" style="margin-top:16px">
    <h3>Tell us what you've done</h3><p class="sub">Everything you enter is saved to your profile as confirmed, so enter only what is true. The resume uses nothing else.</p>
    <div class="formgrid"><div class="field"><label for="b_name">Full name</label><input id="b_name" required maxlength="120"></div>
    <div class="field"><label for="b_contact">Contact line</label><input id="b_contact" maxlength="300" placeholder="City, State | email | LinkedIn"></div></div>
    <p class="groupname" style="margin:18px 0 8px">Roles, most recent first</p><div id="roles">${roleRow()}</div>
    <button class="btn sm" type="button" id="addRole">Add another role</button>
    <div class="formgrid" style="margin-top:18px"><div class="field wide"><label for="b_skills">Skills (comma separated)</label><textarea id="b_skills" rows="2" maxlength="3000" placeholder="e.g. Canvas, curriculum design, Power BI"></textarea></div>
    <div class="field wide"><label for="b_edu">Education and certifications (one per line, dates in parentheses)</label><textarea id="b_edu" rows="3" maxlength="2000"></textarea></div></div>
    <label style="display:flex;gap:8px;align-items:center;margin-top:16px"><input type="checkbox" id="b_ok"> Everything I entered is accurate.</label>
    <div class="savebar"><button class="btn primary" type="submit">Build my resume</button><span class="note" id="buildNote"></span></div></form>`;
  $("#addRole").onclick = () => $("#roles").insertAdjacentHTML("beforeend", roleRow());
  $("#buildForm").onsubmit = async (e) => {
    e.preventDefault();
    if (!$("#b_ok").checked) { $("#buildNote").textContent = "Tick the accuracy box first."; return; }
    const roles = $$(".buildrole").map((row) => ({
      org: $('[data-b="org"]', row).value.trim(), title: $('[data-b="title"]', row).value.trim(), dates: $('[data-b="dates"]', row).value.trim(),
      results: $('[data-b="results"]', row).value.split("\n").map((t) => t.trim().replace(/^[-*]\s*/, "")).filter(Boolean),
    })).filter((r) => r.org && r.title);
    if (!roles.length) { $("#buildNote").textContent = "Add at least one role with an employer and title."; return; }
    const entry = {
      name: $("#b_name").value.trim(), contact: $("#b_contact").value.trim(), roles,
      skills: [{ group: "Skills", items: $("#b_skills").value.split(",").map((t) => t.trim()).filter(Boolean) }],
      education: $("#b_edu").value.split("\n").map((t) => t.trim()).filter(Boolean).map((t) => { const m = t.match(/^(.*?)\s*\(([^)]*)\)\s*$/); return m ? { text: m[1], dates: m[2] } : { text: t, dates: "" }; }),
    };
    $("#buildNote").textContent = "Building your resume. This takes about a minute.";
    const out = await attempt(() => source.buildResume(entry), "Resume built. Edit it, then download it.");
    $("#buildNote").textContent = "";
    if (!out) return;
    if (source.mode === "live") profile = { ...profile, ...(await source.getProfile()) };
    renderProfile();
    await refreshDocs();
    go("resumes");
    openDoc(out.document.id);
  };
}

/* ---------- Sign-in ---------- */

function openSignIn() {
  openDrawer(`${head("Career Studio", "Owner sign in", "This workspace is private to its owner.")}
    <form class="signin-form" id="signInForm">
      <label for="signInEmail"><b>Email</b></label>
      <input id="signInEmail" type="email" autocomplete="email" required>
      <button class="btn primary" type="submit">Email me a sign-in link</button>
      <p class="signin-note" id="signInNote">You'll get a one-time link. Open it in this browser.</p>
    </form>`);
  $("#signInForm").onsubmit = async (e) => {
    e.preventDefault();
    const button = $("#signInForm button");
    button.disabled = true;
    try {
      await sendMagicLink($("#signInEmail").value.trim());
      $("#signInNote").textContent = "If that email is allowed, a sign-in link is on its way. Check your inbox.";
    } catch (err) {
      $("#signInNote").textContent = err.message;
      button.disabled = false;
    }
  };
}

async function doSignOut() {
  await signOut();
  location.reload();
}

/* ---------- Account initials ---------- */

let accountName = "";

// "Karen Burkhart" -> "KB"; with no name, the email's first letter.
export function initials(name, email) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length) return (parts[0][0] + (parts.length > 1 ? parts.at(-1)[0] : "")).toUpperCase();
  return String(email || "C").charAt(0).toUpperCase();
}

function showInitials(email) {
  $("#avatar").textContent = initials(accountName, email);
  $("#avatar").title = accountName ? `${accountName}: your profile` : "Your profile";
}

/* ---------- Wiring ---------- */

function go(view) {
  $$(".nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === view));
  window.scrollTo(0, 0);
}

function wire() {
  $$(".nav button").forEach((b) => (b.onclick = () => go(b.dataset.view)));
  $("#statusFilter").innerHTML = `<option value="all">All statuses</option>` + STATUS_KEYS.map((k) => `<option value="${k}">${STATUS[k]}</option>`).join("");
  $("#search").addEventListener("input", renderRows);
  $("#statusFilter").addEventListener("change", renderRows);
  $("#sort").addEventListener("change", renderRows);
  $("#addJob").onclick = openAddJob;
  $("#drawerBg").addEventListener("click", (e) => { if (e.target === $("#drawerBg")) closeDrawer(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("#drawerBg").classList.contains("open")) closeDrawer(); });
  $$("#resFilter button").forEach((b) => (b.onclick = () => {
    resFilter = b.dataset.f;
    $$("#resFilter button").forEach((x) => x.classList.toggle("on", x === b));
    renderResumes();
  }));
  $("#prefsForm").onsubmit = async (e) => {
    e.preventDefault();
    const prefs = readPrefs();
    const name = $("#p_display_name").value.trim();
    if (name !== accountName && (await attempt(() => source.saveName(name)))) { accountName = name; showInitials(); }
    const saved = await attempt(() => source.savePrefs(prefs), "Preferences saved.");
    if (saved) { profile.prefs = { ...profile.prefs, ...prefs }; renderProfile(); $("#prefsStatus").textContent = "Saved."; }
  };
  $$("#profile [data-add]").forEach((b) => (b.onclick = () => openAdd(b.dataset.add)));
  $("#profile [data-newgroup]").onclick = openNewGroup;
  $$("#addKind button").forEach((b) => (b.onclick = () => setAddKind(b.dataset.k)));
  $("#addForm").onsubmit = (e) => { e.preventDefault(); submitAdd(); };
  $("#addCancel").onclick = () => $("#addDlg").close();
  $("#pickUpload").onclick = openUpload;
  // From the Resumes tab: the same upload flow, on the Start page.
  $("#uploadResume").onclick = () => { go("start"); openUpload(); $("#startArea").scrollIntoView({ behavior: "smooth" }); };
  $("#pickSkills").onclick = openBuild;
  $("#signInBtn").onclick = openSignIn;
  $("#signOutBtn").onclick = doSignOut;
  $("#avatar").onclick = () => go("profile");
}

async function init() {
  wire();
  if (linkError) toast(`Sign-in link problem: ${linkError}`);
  if (source.mode === "demo") {
    $("#demoBanner").classList.remove("hidden");
    loadConfig().then((cfg) => { if (cfg) $("#signInBtn").classList.remove("hidden"); });
  } else {
    $("#signOutBtn").classList.remove("hidden");
  }
  try {
    const [meta, prof] = await Promise.all([source.meta(), source.getProfile()]);
    profile = { facts: [], prefs: {}, ...prof };
    accountName = meta.candidate?.name && meta.candidate.name !== "My job search" ? meta.candidate.name : "";
    showInitials(meta.email);
    $("#p_display_name").value = accountName;
    await Promise.all([refreshJobs(), refreshDocs()]);
    fillPrefs(profile.prefs);
    renderProfile();
  } catch (e) {
    $("#count").textContent = "Data unavailable";
    if (e.status === 401 || e.status === 403) {
      await signOut();
      $("#rows").innerHTML = `<tr><td colspan="5" class="empty">${esc(e.message)} <button class="linkbtn" id="reloadDemo">Back to the demo</button></td></tr>`;
      $("#reloadDemo").onclick = () => location.reload();
      return;
    }
    $("#rows").innerHTML = `<tr><td colspan="5" class="empty">${esc(e.message)}</td></tr>`;
  }
}

init();
