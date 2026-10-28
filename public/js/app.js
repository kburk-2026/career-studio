import { pickSource } from "./data.js";
import { STATUS, esc, statusClass, formatDate, filterJobs, computeStats } from "./format.js";
import { loadConfig, consumeRedirect, hasSession, getAccessToken, sendMagicLink, signOut } from "./auth.js";

const linkError = consumeRedirect();
const source = pickSource({ signedIn: hasSession(), getToken: getAccessToken });
const $ = (s, root = document) => root.querySelector(s);

let jobs = [];
let profile = { groups: [] };
let editing = false;
let lastFocus = null;

// Browser drafts are a per-visitor convenience only; storage can be blocked.
const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); return true; } catch { return false; } },
};

function showToast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 2600);
}

/* ---------- Applications ---------- */

function renderStats() {
  const s = computeStats(jobs);
  const cards = [
    [s.submitted, "Submitted applications", "Across your tracked search", "▤"],
    [s.interviewing, "In interview process", "Interviewing or offer", "↗"],
    [s.offers, "Offers", "Positive outcomes", "✦"],
    [s.declined, "Employer declines", s.avgFit == null ? "No fit scores yet" : `Average fit ${s.avgFit} / 100`, "↘"],
  ];
  $("#stats").innerHTML = cards
    .map(([n, label, hint, icon]) => `<div class="stat"><span class="bubble">${icon}</span><div class="label">${label}</div><strong>${n}</strong><div class="hint">${esc(hint)}</div></div>`)
    .join("");
}

function fitCell(score) {
  if (score == null) return `<div class="fitwrap"><span class="fitnum">—</span></div>`;
  const pct = Math.max(0, Math.min(100, score));
  return `<div class="fitwrap"><span class="fitnum">${score}</span><span class="track"><span class="fill" style="display:block;width:${pct}%"></span></span></div>`;
}

function renderRows() {
  const rows = filterJobs(jobs, { query: $("#search").value, status: $("#statusFilter").value, sort: $("#sort").value });
  $("#count").textContent = `${rows.length} of ${jobs.length} applications`;
  $("#rows").innerHTML = rows.length
    ? rows
        .map(
          (j) => `<tr data-id="${j.id}" tabindex="0">
            <td><div class="company">${esc(j.company)}</div><div class="role">${esc(j.role_title)}</div></td>
            <td>${fitCell(j.fit_score)}</td>
            <td class="date">${formatDate(j.applied_on)}</td>
            <td><span class="status ${statusClass(j.status)}">${esc(STATUS[j.status] || j.status)}</span></td>
            <td class="qcount"><b>${j.answer_count || 0}</b>${j.answer_count === 1 ? "answer" : "answers"}</td>
          </tr>`,
        )
        .join("")
    : `<tr><td colspan="5" class="empty">No applications match those filters.</td></tr>`;
  $("#rows").querySelectorAll("tr[data-id]").forEach((row) => {
    const open = () => openDetail(Number(row.dataset.id));
    row.addEventListener("click", open);
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
  });
}

/* ---------- Drawer ---------- */

function openDrawer(html) {
  const drawer = $("#drawer");
  drawer.innerHTML = html;
  $(".close", drawer).onclick = closeDrawer;
  if (!$("#drawerBg").classList.contains("open")) lastFocus = document.activeElement;
  $("#drawerBg").classList.add("open");
  $(".close", drawer).focus();
}

function closeDrawer() {
  $("#drawerBg").classList.remove("open");
  if (lastFocus) lastFocus.focus();
}

const list = (items) => `<ul>${(items || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;

async function openDetail(id) {
  const job = jobs.find((j) => j.id === id);
  if (!job) return;
  const d = await source.getApplication(id);
  const answers = d?.answers || [];
  const matchNotes =
    d?.strengths?.length || d?.gaps?.length
      ? `<div class="section"><h3>Match notes</h3><div class="match-grid"><div><b>Strengths</b>${list(d.strengths)}</div><div><b>Gaps</b>${list(d.gaps)}</div></div></div>`
      : "";
  const coachCta =
    job.status === "INTERVIEWING" && d?.coach
      ? `<div class="coach-cta"><div><b>Interview Coach</b><p>Role analysis, evidence bank, and one-question-at-a-time practice.</p></div><button class="btn primary" id="launchCoach">Open coach</button></div>`
      : "";
  const docs = [job.has_resume && "Resume attached", job.has_cover_letter && "Cover letter attached"].filter(Boolean);

  openDrawer(`
    <div class="drawer-head"><div><h2>${esc(job.company)}</h2><p class="role">${esc(job.role_title)}</p>
      <div class="detailmeta"><span class="status ${statusClass(job.status)}">${esc(STATUS[job.status] || job.status)}</span><span>Applied ${formatDate(job.applied_on)}</span>${job.location ? `<span>${esc(job.location)}</span>` : ""}</div></div>
      <button class="close" aria-label="Close">×</button></div>
    <div class="detailcards"><div class="dcard"><span>Fit score</span><b>${job.fit_score ?? "—"}</b></div><div class="dcard"><span>Screening odds</span><b>${job.odds_score ?? "—"}</b></div><div class="dcard"><span>Questions</span><b>${answers.length}</b></div></div>
    ${matchNotes}
    ${coachCta}
    <div class="section"><h3>Application questions and answers</h3>${
      answers.length
        ? answers.map((a, i) => `<div class="qa"><strong>${i + 1}. ${esc(a.question)}</strong><p>${esc(a.answer)}</p></div>`).join("")
        : `<div class="noanswers">No application questions or final answers are saved for this entry.</div>`
    }</div>
    <div class="section"><h3>Documents used</h3><div class="files">${
      docs.length ? docs.map((x) => `<span class="file">${x}</span>`).join("") : `<span class="noanswers">No documents attached</span>`
    }</div></div>
    ${d?.history?.length ? `<div class="section"><h3>Application timeline</h3><ul>${d.history.map((h) => `<li>${esc(STATUS[h.status] || h.status)} · ${formatDate(h.at)}</li>`).join("")}</ul></div>` : ""}
  `);
  if (coachCta) $("#launchCoach").onclick = () => openCoach(job, d);
}

/* ---------- Interview coach (Phase 1: prep + first question, no AI yet) ---------- */

function openCoach(job, d) {
  const c = d.coach;
  const draftKey = `${source.mode}_coach_${job.id}_q1`;
  const stories = c.stories
    .map((s, i) => `<article class="story"><b>${i + 1}. ${esc(s.title)}</b><p><b>S/T:</b> ${esc(s.situation)} <b>A:</b> ${esc(s.action)} <b>R:</b> ${esc(s.result)}</p></article>`)
    .join("");

  openDrawer(`
    <div class="drawer-head"><div><div class="eyebrow">Interview Coach / ${esc(job.company)}</div><h2>Prepare with evidence</h2><p class="role">${esc(job.role_title)}</p></div><button class="close" aria-label="Close">×</button></div>
    <button class="btn" id="backToApplication">← Application details</button>
    <div class="section"><h3>What the hiring team needs most</h3>
      <div class="coach-panel"><ul>${c.priorities.map((p) => `<li><b>${esc(p.title)}:</b> ${esc(p.detail)}</li>`).join("")}</ul></div>
      <div class="coach-panel"><h4>Potential interviewer concern to prepare for</h4><p class="concern">${esc(c.concern)}</p></div>
    </div>
    <div class="section"><h3>Your evidence bank · ${c.stories.length} adaptable stories</h3>
      <p class="sub" style="font-size:12px;margin:0 0 10px">Truthful STAR anchors built only from verified experience.</p>
      <div class="story-grid">${stories}</div>
    </div>
    <div class="section"><h3>Mock interview · question 1</h3>
      <p class="coach-question">${esc(c.first_question)}</p>
      <textarea class="coach-answer" id="coachAnswer" aria-label="Your answer" placeholder="Answer as you would in the interview. Aim for about 60–90 seconds.">${esc(store.get(draftKey) || "")}</textarea>
      <button class="btn primary coach-save" id="saveCoachAnswer">Save practice draft</button>
      <p class="coach-disclaimer">Live critique and follow-up questions arrive in Phase 4. For now your draft is saved in this browser only.</p>
    </div>
  `);
  $("#backToApplication").onclick = () => openDetail(job.id);
  $("#saveCoachAnswer").onclick = () => {
    const ok = store.set(draftKey, $("#coachAnswer").value);
    showToast(ok ? "Practice answer saved in this browser." : "This browser blocked saving the draft.");
  };
}

/* ---------- Skills profile ---------- */

const PROFILE_DRAFT_KEY = `${source.mode}_skill_profile_draft`;

function currentGroups() {
  const draft = store.get(PROFILE_DRAFT_KEY);
  if (draft) {
    try { return JSON.parse(draft); } catch { /* fall through to the saved profile */ }
  }
  return profile.groups;
}

function renderProfile() {
  const groups = currentGroups();
  $("#editProfile").classList.toggle("hidden", editing || !groups.length);
  if (!groups.length) {
    $("#skillgrid").innerHTML = `<div class="notice">No profile facts are stored yet. Importing and editing your profile arrives in Phase 5.</div>`;
    return;
  }
  $("#skillgrid").innerHTML = groups
    .map(
      (g, i) => `<article class="skillcard"><h3>${esc(g.title)}</h3>${
        editing
          ? `<textarea class="editbox" data-group="${i}" aria-label="Edit ${esc(g.title)}">${esc(g.items.map((x) => x.text).join("\n"))}</textarea>`
          : `<ul>${g.items.map((x) => `<li>${esc(x.text)}${x.verified ? "" : ` <span class="unverified">unverified</span>`}</li>`).join("")}</ul>`
      }</article>`,
    )
    .join("");
}

function setEditing(on) {
  editing = on;
  $("#editProfile").classList.toggle("hidden", on);
  $("#saveProfile").classList.toggle("hidden", !on);
  $("#cancelEdit").classList.toggle("hidden", !on);
  renderProfile();
}

function saveProfileDraft() {
  const before = currentGroups();
  const groups = before.map((g, i) => {
    const box = $(`.editbox[data-group="${i}"]`);
    const known = new Map(g.items.map((x) => [x.text, x.verified]));
    const lines = box.value.split("\n").map((x) => x.trim().replace(/^-\s*/, "")).filter(Boolean);
    // An edited or new line is a new claim, so it starts unverified.
    return { title: g.title, items: lines.map((text) => ({ text, verified: known.get(text) === true })) };
  });
  const ok = store.set(PROFILE_DRAFT_KEY, JSON.stringify(groups));
  setEditing(false);
  showToast(ok ? "Draft saved in this browser. New or edited lines are marked unverified." : "This browser blocked saving the draft.");
}

/* ---------- Sign-in ---------- */

function openSignIn() {
  openDrawer(`
    <div class="drawer-head"><div><div class="eyebrow">Career Studio</div><h2>Owner sign in</h2><p class="role">This workspace is private to its owner.</p></div><button class="close" aria-label="Close">×</button></div>
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

function wire() {
  document.querySelectorAll(".nav button").forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll(".nav button").forEach((x) => x.classList.toggle("active", x === b));
      document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === b.dataset.view));
    };
  });
  ["#search", "#statusFilter", "#sort"].forEach((s) => $(s).addEventListener(s === "#search" ? "input" : "change", renderRows));
  $("#drawerBg").addEventListener("click", (e) => { if (e.target === $("#drawerBg")) closeDrawer(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("#drawerBg").classList.contains("open")) closeDrawer(); });
  $("#editProfile").onclick = () => setEditing(true);
  $("#cancelEdit").onclick = () => setEditing(false);
  $("#saveProfile").onclick = saveProfileDraft;
  $("#signInBtn").onclick = openSignIn;
  $("#signOutBtn").onclick = doSignOut;
}

async function init() {
  wire();
  if (linkError) showToast(`Sign-in link problem: ${linkError}`);
  if (source.mode === "demo") {
    // Offer sign-in only where the server has it configured.
    loadConfig().then((cfg) => { if (cfg) $("#signInBtn").classList.remove("hidden"); });
  } else {
    $("#signOutBtn").classList.remove("hidden");
  }
  try {
    const [meta, list, prof] = await Promise.all([source.meta(), source.listApplications(), source.getProfile()]);
    jobs = list;
    profile = prof;
    if (meta.mode === "demo") $("#demoBanner").classList.remove("hidden");
    const name = meta.candidate?.name || "Candidate";
    $("#candidateName").textContent = name;
    $("#avatar").textContent = name.charAt(0);
    $("#updated").textContent = `Updated ${formatDate(meta.generated_at)}`;
    if (meta.email) $("#accountLine").textContent = meta.email;
    $("#profileSource").textContent = `Source: ${prof.source_label || "profile"}`;
    $("#syncnote").innerHTML = `<b>Profile sync preview:</b> Edits save as a draft in this browser only. Real saving, with confirmation and undo, arrives in Phase 5.`;
    renderStats();
    renderRows();
    renderProfile();
  } catch (e) {
    $("#updated").textContent = "Data unavailable";
    if (e.status === 401 || e.status === 403) {
      // Expired or not-allowed session: drop it and fall back to the demo.
      await signOut();
      $("#rows").innerHTML = `<tr><td colspan="5" class="empty">${esc(e.message)} <button class="linkbtn" id="reloadDemo">Back to the demo</button></td></tr>`;
      $("#reloadDemo").onclick = () => location.reload();
      return;
    }
    const hint = source.mode === "demo" ? " Run <code>npm run dev</code> and open the local preview." : "";
    $("#rows").innerHTML = `<tr><td colspan="5" class="empty">${esc(e.message)}${hint}</td></tr>`;
  }
}

init();
