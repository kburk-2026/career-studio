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
  if (!$("#drawerBg").classList.contains("open")) lastFocus = document.activeElement;
  $("#drawerBg").classList.add("open");
  d.scrollTop = 0;
  $(".close", d)?.focus();
}

function closeDrawer() {
  $("#drawerBg").classList.remove("open");
  lastFocus?.focus?.();
}

const head = (eyebrow, title, sub, extra = "") =>
  `<div class="drawer-head"><div>${eyebrow ? `<div class="eyebrow">${esc(eyebrow)}</div>` : ""}<h2>${esc(title)}</h2>${sub ? `<p class="role">${esc(sub)}</p>` : ""}${extra}</div><button class="close" aria-label="Close">&times;</button></div>`;

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

  openDrawer(`
    ${head("", job.company, job.role_title, `<div class="detailmeta">${statusSelect(job, "drawerStatus")}<span>Applied ${formatDate(job.applied_on)}</span>${d.location ? `<span>${esc(d.location)}</span>` : ""}</div>`)}
    <div class="detailcards"><div class="dcard"><span>Fit score</span><b>${job.fit_score ?? "--"}</b></div><div class="dcard"><span>Screening odds</span><b>${job.odds_score ?? "--"}</b></div><div class="dcard"><span>Questions</span><b>${d.answers.length}</b></div></div>
    ${rubricHtml(d.fit_breakdown)}
    ${prefHtml(d.pref_match)}
    ${d.strengths?.length || d.gaps?.length ? `<div class="section"><h3>Match notes</h3><div class="match-grid"><div><b>Strengths</b>${list(d.strengths)}</div><div><b>Gaps</b>${list(d.gaps)}</div></div></div>` : ""}
    ${!d.fit_breakdown ? `<div class="section"><div class="notice">${d.jd_text || d.source_url ? `No fit review yet. <button class="btn sm primary" id="reviewJob" style="margin-left:8px">Review and score</button>` : "No posting text saved, so this job can't be reviewed. Add the posting to review it."}</div></div>` : ""}
    ${LIVE_STATUSES.has(job.status) ? `<div class="coach-cta"><div><b>Interview Coach</b><p>Practice one question at a time with feedback grounded in your profile.</p></div><button class="btn primary" disabled>Coming soon</button></div>` : ""}
    <div class="section"><h3>Tailored documents</h3><div class="docbtns">${docBox("resume")}${docBox("letter")}</div><p class="soon">Written from your confirmed profile and base resume. A resume takes about a minute.</p></div>
    <div class="section"><h3>Application questions</h3><div id="qlist"></div>
      <form class="qform" id="qForm"><input id="qText" maxlength="2000" placeholder="Paste a question from the application" aria-label="Question"><input id="qLimit" type="number" min="1" placeholder="Char limit" aria-label="Character limit"></form>
      <div class="btnrow" style="margin-top:8px"><button class="btn sm primary" id="qDraft">Add and draft answer</button><button class="btn sm" id="qAdd">Add without drafting</button></div>
      <p class="soon">Drafts use your confirmed facts and this posting, and always fit the character limit.</p></div>
    ${d.jd_text ? `<div class="section"><h3>Job posting</h3>${d.source_url ? `<p class="note"><a href="${esc(d.source_url)}" target="_blank" rel="noopener noreferrer">${esc(d.source_url)}</a></p>` : ""}<div class="jd">${esc(d.jd_text)}</div></div>` : ""}
    <div class="section"><h3>Application timeline</h3><ul>${(d.history || []).map((h) => `<li>${esc(STATUS[h.status] || h.status)} &middot; ${formatDate(h.at)}</li>`).join("") || "<li>No changes yet</li>"}</ul></div>
  `);
  $("#drawerStatus").addEventListener("change", (e) => changeStatus(id, e.target.value));
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
    <div class="section"><h3>Match notes</h3><div class="match-grid"><div><b>Strengths</b>${list(rv.strengths)}</div><div><b>Gaps</b>${list(rv.gaps)}</div></div></div>`;
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
  $("#reslist").innerHTML = shown.length ? shown.map((d) => {
    const job = jobs.find((j) => j.id === d.job_id);
    return `<div class="resrow"><div class="ico2">${d.kind === "letter" ? "LTR" : "CV"}</div>
      <div><b>${esc(d.title)}<span class="badge ${d.source === "uploaded" ? "b-up" : "b-gen"}">${d.source === "uploaded" ? "Uploaded" : d.source === "built" ? "Built" : "Generated"}</span>${d.sent ? '<span class="badge b-sent">Sent</span>' : d.source !== "uploaded" ? '<span class="badge b-draft">Draft</span>' : ""}</b>
      <small>${esc(d.file_name || "")}${d.file_name ? " &middot; " : ""}${formatDate((d.sent_at || d.created_at || "").slice(0, 10))}${job ? ` &middot; ${esc(job.company)}` : ""}</small></div>
      <div class="btnrow"><button class="btn sm" data-open="${d.id}">Open</button></div></div>`;
  }).join("") : `<div class="notice">No documents here yet.</div>`;
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
    const content = readDoc(doc.kind, $("#editor"));
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
    const content = readDoc(doc.kind, $("#editor"));
    if (await attempt(() => source.saveDocument(doc.id, { content }), "Saved.")) { doc.content = content; refreshDocs(); recheck(); }
  };
  $("#dlPdf").onclick = () => {
    $("#printArea").innerHTML = $("#editor").innerHTML;
    window.print();
  };
  $("#markSent")?.addEventListener("click", async () => {
    if (!confirm("Mark this as the version you sent? It will be locked for good.")) return;
    const content = readDoc(doc.kind, $("#editor"));
    if (!(await attempt(() => source.saveDocument(doc.id, { content })))) return;
    if (await attempt(() => source.markSent(doc.id), "Marked as sent and locked.")) { await Promise.all([refreshDocs(), refreshJobs()]); openDoc(doc.id, backJobId); }
  });
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

function factChip(f) {
  return `<span class="chip ${f.verified ? "" : "unv"}">${esc(f.text)}${f.verified ? "" : ` <button class="x" data-confirm="${f.id}" aria-label="Confirm ${esc(f.text)}">confirm</button>`}<button class="x" data-del="${f.id}" aria-label="Remove ${esc(f.text)}">&times;</button></span>`;
}

function renderProfile() {
  const facts = profile.facts || [];
  const strength = profileStrength(profile.prefs || {}, facts);
  $("#strengthBar").style.width = `${strength.percent}%`;
  $("#strengthText").textContent = strength.missing.length ? `${strength.percent}% complete. Add these to sharpen your fit ratings:` : "Complete.";
  $("#strengthTips").innerHTML = strength.missing.slice(0, 4).map((t) => `<li>${esc(t)}</li>`).join("");

  const skills = facts.filter((f) => f.kind === "skill");
  const groups = [...new Set(skills.map((f) => f.group))];
  $("#skillGroups").innerHTML = groups.length
    ? groups.map((g) => `<div style="margin-bottom:14px"><span class="groupname">${esc(g)}</span><div class="chips" style="margin-top:6px">${skills.filter((f) => f.group === g).map(factChip).join("")}</div></div>`).join("")
    : `<p class="sub">No skills yet.</p>`;
  $("#skillGroupList").innerHTML = groups.map((g) => `<option value="${esc(g)}">`).join("");

  const bullet = (f) => `<li>${esc(f.text)}${f.group && !["Other", "Education"].includes(f.group) ? ` <span class="note">(${esc(f.group)})</span>` : ""} ${f.verified ? '<span class="badge b-sent">Confirmed</span>' : `<span class="unverified">unverified</span> <button class="linkbtn" data-confirm="${f.id}">confirm</button>`} <button class="linkbtn" data-del="${f.id}">remove</button></li>`;
  const results = facts.filter((f) => f.kind === "result");
  $("#results").innerHTML = results.map(bullet).join("") || `<li class="note">No results yet.</li>`;
  $("#education").innerHTML = facts.filter((f) => f.kind === "education").map(bullet).join("") || `<li class="note">None yet.</li>`;

  $$("#profile [data-confirm]").forEach((b) => (b.onclick = async () => {
    const id = Number(b.dataset.confirm);
    const saved = await attempt(() => source.updateFact(id, { verified: true }), "Confirmed. It can now be used in documents.");
    if (saved) { Object.assign(facts.find((f) => f.id === id), { verified: true }); renderProfile(); }
  }));
  $$("#profile [data-del]").forEach((b) => (b.onclick = async () => {
    const id = Number(b.dataset.del);
    const f = facts.find((x) => x.id === id);
    if (f.verified && !confirm(`Remove "${f.text}" from your profile?`)) return;
    if (await attempt(() => source.deleteFact(id), "Removed.")) { profile.facts = facts.filter((x) => x.id !== id); renderProfile(); }
  }));
}

async function addFact(kind, textEl, groupEl) {
  const text = textEl.value.trim();
  if (!text) { textEl.focus(); return; }
  const group = groupEl?.value.trim() || (kind === "education" ? "Education" : "Other");
  const f = await attempt(() => source.addFact({ kind, group, text }), "Added as unverified. Confirm it to use it in documents.");
  if (f) { profile.facts.push(f); textEl.value = ""; renderProfile(); }
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
    const saved = await attempt(() => source.savePrefs(prefs), "Preferences saved.");
    if (saved) { profile.prefs = { ...profile.prefs, ...prefs }; renderProfile(); $("#prefsStatus").textContent = "Saved."; }
  };
  $("#skillForm").onsubmit = (e) => { e.preventDefault(); addFact("skill", $("#newSkill"), $("#newSkillGroup")); };
  $("#resultForm").onsubmit = (e) => { e.preventDefault(); addFact("result", $("#newResult"), $("#newResultGroup")); };
  $("#eduForm").onsubmit = (e) => { e.preventDefault(); addFact("education", $("#newEdu")); };
  $("#pickUpload").onclick = openUpload;
  $("#pickSkills").onclick = openBuild;
  $("#signInBtn").onclick = openSignIn;
  $("#signOutBtn").onclick = doSignOut;
  $("#signOutBtn2").onclick = doSignOut;
}

async function init() {
  wire();
  if (linkError) toast(`Sign-in link problem: ${linkError}`);
  if (source.mode === "demo") {
    $("#demoBanner").classList.remove("hidden");
    loadConfig().then((cfg) => { if (cfg) $("#signInBtn").classList.remove("hidden"); });
  } else {
    $("#signOutBtn").classList.remove("hidden");
    $("#signOutBtn2").hidden = false;
  }
  try {
    const [meta, prof] = await Promise.all([source.meta(), source.getProfile()]);
    profile = { facts: [], prefs: {}, ...prof };
    $("#avatar").textContent = (meta.candidate?.name || "C").charAt(0);
    $("#avatar").title = meta.email || meta.candidate?.name || "";
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
