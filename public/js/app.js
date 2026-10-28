import { pickSource } from "./data.js";
import { STATUS, STATUS_KEYS, LIVE_STATUSES, esc, formatDate, filterJobs, computeStats, RUBRIC, profileStrength } from "./format.js";
import { renderDoc, readDoc } from "./doc.js";
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
const SOON = "Arrives with the AI update.";

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
  return `<div class="section"><h3>Why this fit score</h3><div class="rubric">${RUBRIC.map(([k, label, w]) =>
    `<div><span>${label} <span class="note">&times;${w}</span></span><span class="bar"><span style="width:${(b[k] ?? 0) * 25}%"></span></span><b>${b[k] ?? "-"}/4</b></div>`).join("")}</div></div>`;
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
      <button class="btn sm ${doc ? "" : "primary"}" disabled title="${SOON}">${doc ? "New version" : `Generate`}</button></div></div>`;
  };

  openDrawer(`
    ${head("", job.company, job.role_title, `<div class="detailmeta">${statusSelect(job, "drawerStatus")}<span>Applied ${formatDate(job.applied_on)}</span>${d.location ? `<span>${esc(d.location)}</span>` : ""}</div>`)}
    <div class="detailcards"><div class="dcard"><span>Fit score</span><b>${job.fit_score ?? "--"}</b></div><div class="dcard"><span>Screening odds</span><b>${job.odds_score ?? "--"}</b></div><div class="dcard"><span>Questions</span><b>${d.answers.length}</b></div></div>
    ${rubricHtml(d.fit_breakdown)}
    ${prefHtml(d.pref_match)}
    ${d.strengths?.length || d.gaps?.length ? `<div class="section"><h3>Match notes</h3><div class="match-grid"><div><b>Strengths</b>${list(d.strengths)}</div><div><b>Gaps</b>${list(d.gaps)}</div></div></div>` : ""}
    ${!d.fit_breakdown && !d.strengths?.length ? `<div class="section"><div class="notice">Fit review, strengths, and gaps for new postings: ${SOON}</div></div>` : ""}
    ${LIVE_STATUSES.has(job.status) ? `<div class="coach-cta"><div><b>Interview Coach</b><p>Practice one question at a time with feedback grounded in your profile.</p></div><button class="btn primary" disabled>Coming soon</button></div>` : ""}
    <div class="section"><h3>Tailored documents</h3><div class="docbtns">${docBox("resume")}${docBox("letter")}</div><p class="soon">Generating tailored resumes and letters: ${SOON}</p></div>
    <div class="section"><h3>Application questions</h3><div id="qlist"></div>
      <form class="qform" id="qForm"><input id="qText" maxlength="2000" placeholder="Paste a question from the application" aria-label="Question"><input id="qLimit" type="number" min="1" placeholder="Char limit" aria-label="Character limit"></form>
      <div class="btnrow" style="margin-top:8px"><button class="btn sm primary" id="qAdd">Add question</button><button class="btn sm" disabled title="${SOON}">Add and draft answer</button></div></div>
    ${d.jd_text ? `<div class="section"><h3>Job posting</h3>${d.source_url ? `<p class="note"><a href="${esc(d.source_url)}" target="_blank" rel="noopener noreferrer">${esc(d.source_url)}</a></p>` : ""}<div class="jd">${esc(d.jd_text)}</div></div>` : ""}
    <div class="section"><h3>Application timeline</h3><ul>${(d.history || []).map((h) => `<li>${esc(STATUS[h.status] || h.status)} &middot; ${formatDate(h.at)}</li>`).join("") || "<li>No changes yet</li>"}</ul></div>
  `);
  $("#drawerStatus").addEventListener("change", (e) => changeStatus(id, e.target.value));
  $$("#drawer [data-open]").forEach((b) => (b.onclick = () => openDoc(Number(b.dataset.open), id)));
  renderQuestions(id, d.answers);
  const add = async () => {
    const question = $("#qText").value.trim();
    if (!question) { $("#qText").focus(); return; }
    const char_limit = Number($("#qLimit").value) || null;
    const a = await attempt(() => source.addAnswer(id, { question, char_limit }), "Question added.");
    if (a) { d.answers.push(a); $("#qText").value = ""; $("#qLimit").value = ""; renderQuestions(id, d.answers); refreshJobs(); }
  };
  $("#qAdd").onclick = add;
  $("#qForm").onsubmit = (e) => { e.preventDefault(); add(); };
}

function renderQuestions(jobId, answers) {
  const box = $("#qlist");
  if (!answers.length) {
    box.innerHTML = `<div class="noanswers">No questions yet. Paste one below.</div>`;
    return;
  }
  box.innerHTML = answers.map((a, i) => `<div class="qitem" data-i="${i}"><strong>${i + 1}. ${esc(a.question)}</strong>
    <textarea aria-label="Answer to question ${i + 1}" maxlength="20000">${esc(a.answer || "")}</textarea>
    <div class="qmeta"><span data-count></span><span class="btnrow">
      <button class="btn sm" data-save>Save</button>
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

function openAddJob() {
  openDrawer(`
    ${head("New job", "Add a posting", "Paste the job description, or add a link to it.")}
    <form class="section" id="jobForm">
      <div class="formgrid">
        <div class="field"><label for="j_company">Company</label><input id="j_company" required maxlength="200"></div>
        <div class="field"><label for="j_role">Role</label><input id="j_role" required maxlength="200"></div>
        <div class="field"><label for="j_location">Location</label><input id="j_location" maxlength="200" placeholder="e.g. Remote"></div>
        <div class="field"><label for="j_url">Posting link</label><input id="j_url" type="url" maxlength="2000" placeholder="https://"></div>
        <div class="field wide"><label for="j_text">Job description</label><textarea id="j_text" rows="10" maxlength="60000" placeholder="Paste the full posting"></textarea></div>
      </div>
      <div class="savebar"><button class="btn primary" type="submit">Save as In progress</button><span class="note">Fit scoring and review: ${SOON}</span></div>
    </form>`);
  $("#jobForm").onsubmit = async (e) => {
    e.preventDefault();
    const fields = { company: $("#j_company").value, role_title: $("#j_role").value, location: $("#j_location").value || null, source_url: $("#j_url").value || null, jd_text: $("#j_text").value || null };
    const created = await attempt(() => source.createJob(fields), "Saved as In progress.");
    if (created) { await refreshJobs(); openJob(created.id); }
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
      <div class="section"><div class="notice">This is the original file${doc.sent ? " exactly as it was sent" : ""}. Reading uploaded files into the editor: ${SOON}</div>
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
    ${doc.sent ? `<div class="guard w"><b>This is the version you sent.</b> It is locked. Editing makes a new copy.</div>` : ""}
    <div class="toolbar2">
      ${doc.sent ? "" : `<button class="btn sm" data-cmd="bold" aria-label="Bold"><b>B</b></button><button class="btn sm" data-cmd="italic" aria-label="Italic"><i>I</i></button><button class="btn sm" data-cmd="insertUnorderedList">List</button>`}
      <span style="flex:1"></span>
      <button class="btn sm" id="saveDoc">${doc.sent ? "Edit as new copy" : "Save"}</button>
      <button class="btn sm" id="dlPdf">Download PDF</button>
      <button class="btn sm" disabled title="${SOON}">Download Word</button>
      ${!doc.sent ? `<button class="btn primary sm" id="markSent">Mark as sent</button>` : ""}
    </div>
    <div class="editor" id="editor" contenteditable="${doc.sent ? "false" : "true"}" spellcheck="true" aria-label="Document editor">${renderDoc(doc.kind, doc.content)}</div>
    <p class="soon">Download PDF opens your browser's print dialog; choose Save as PDF.</p>`, true);

  $("#backJob")?.addEventListener("click", () => openJob(job.id));
  $$("#drawer [data-cmd]").forEach((b) => (b.onclick = () => { document.execCommand(b.dataset.cmd); $("#editor").focus(); }));
  $("#saveDoc").onclick = async () => {
    if (doc.sent) {
      const copy = await attempt(() => source.copyDocument(doc.id), "Editable copy created.");
      if (copy) { await refreshDocs(); openDoc(copy.id, backJobId); }
      return;
    }
    const content = readDoc(doc.kind, $("#editor"));
    if (await attempt(() => source.saveDocument(doc.id, { content }), "Saved.")) { doc.content = content; refreshDocs(); }
  };
  $("#dlPdf").onclick = () => {
    $("#printArea").innerHTML = `<div class="editor">${$("#editor").innerHTML}</div>`;
    window.print();
  };
  $("#markSent")?.addEventListener("click", async () => {
    if (!confirm("Mark this as the version you sent? It will be locked for good.")) return;
    const content = readDoc(doc.kind, $("#editor"));
    if (!(await attempt(() => source.saveDocument(doc.id, { content })))) return;
    if (await attempt(() => source.markSent(doc.id), "Marked as sent and locked.")) { await Promise.all([refreshDocs(), refreshJobs()]); openDoc(doc.id, backJobId); }
  });
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
  $("#pickUpload").onclick = () => { $("#startNote").textContent = `Reading an uploaded resume: ${SOON} Until then, add skills and results on the Profile page.`; };
  $("#pickSkills").onclick = () => go("profile");
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
