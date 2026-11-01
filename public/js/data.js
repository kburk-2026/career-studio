// Data source for the app.
//
// The UI only talks to a "source" object, so the signed-in owner's live data
// and the public fictional demo are interchangeable:
//
//   meta(), listApplications(), getApplication(id)
//   createJob(fields), updateJob(id, fields)
//   addAnswer(jobId, fields), updateAnswer(id, fields), deleteAnswer(id)
//   getProfile(), savePrefs(prefs), addFact(fact), updateFact(id, fields), deleteFact(id)
//   listDocuments(), getDocument(id), saveDocument(id, fields), copyDocument(id),
//   markSent(id), documentFileUrl(id)
//   reviewPosting({ text } | { url }), reviewJob(id)   (AI; the demo replays a recorded review)
//   generateDoc(jobId, kind), exportWord(id), exportTranscript(jobId)  (AI / server; the demo copies a sample)
//   draftAnswer(jobId, { question, char_limit }), redraftAnswer(id)  (AI; the demo uses a sample)
//   uploadResume(file), confirmFacts(facts, source), buildResume(entry)  (AI; the demo uses samples)
//   getCoach(jobId), coachStart(jobId), coachAnswer(sid, answer), coachNext(sid), coachEnd(sid), coachDelete(sid)
//
// Demo writes change in-memory state only; nothing is sent anywhere.

import { localToday, normStatus } from "./format.js";
import { updateAccountName } from "./auth.js";

const DEMO_ROOT = "demo/";

async function getJson(path) {
  const res = await fetch(path, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Could not load ${path} (${res.status}).`);
  return res.json();
}

const clone = (x) => JSON.parse(JSON.stringify(x));

// The demo's stand-in for an AI-drafted answer, cut to the limit like the real one.
const DEMO_ANSWER = "I turn repetitive course work into reviewed, repeatable workflows. At Northfield Community College I introduced a shared review checklist that cut average review rounds from 3 to 2 across 40 courses, and I would bring the same habit here: learn how the team works, test a change with the people who use it, and document what works so it sticks.";
function demoAnswer(limit) {
  if (!limit || DEMO_ANSWER.length <= limit) return DEMO_ANSWER;
  const cut = DEMO_ANSWER.slice(0, limit);
  return cut.slice(0, Math.max(cut.lastIndexOf(". ") + 1, cut.lastIndexOf(" "))).trim();
}

// Demo coach: the same turn order as the server, with recorded feedback.
const DEMO_FEEDBACK = {
  score: 3,
  worked: ["You led with a concrete example and a real result.", "You named who you worked with."],
  improve: ["Open with the one-sentence answer before the story.", "Say what you would repeat at this college, not only what you did."],
  improved_answer: "I turn repetitive design work into reviewed, repeatable workflows. At Northfield Community College, review rounds were slowing every course, so I introduced a shared review checklist and walked each designer through it. Average review rounds dropped from 3 to 2 across 40 courses. Here, I'd start the same way: learn how your team works now, test one change with the people who use it, and document it so it sticks.",
  new_facts: [],
};
const DEMO_FOLLOW_UP = "What would you do differently if the checklist met resistance from senior designers?";
const DEMO_NEXT = [
  "Tell me about a time you had to train staff on a tool they didn't want to use.",
  "How do you check that AI-generated course content is accurate before it reaches students?",
  "Describe a time you balanced accessibility requirements against a tight deadline.",
  "How would you decide which design workflow to automate first here?",
  "Tell me about a project that didn't go as planned. What did you learn?",
];

export function demoSource() {
  let list = null;
  const details = new Map();
  let profile = null;
  let docs = null;
  let nextId = 1000;

  const loadList = async () => (list ||= await getJson(`${DEMO_ROOT}applications.json`));
  const loadProfile = async () => {
    if (!profile) {
      profile = await getJson(`${DEMO_ROOT}profile.json`);
      profile.facts ||= [];
      profile.prefs ||= {};
    }
    return profile;
  };
  const loadDocs = async () => (docs ||= (await getJson(`${DEMO_ROOT}documents.json`)).documents);
  async function detail(id) {
    if (!details.has(id)) {
      try {
        details.set(id, await getJson(`${DEMO_ROOT}jobs/${id}.json`));
      } catch {
        return null;
      }
    }
    return details.get(id);
  }
  const listRow = async (id) => (await loadList()).jobs.find((j) => j.id === id);
  const coach = new Map(); // jobId -> { session, turns }
  const coachFor = (sid) => [...coach.values()].find((c) => c.session.id === sid);
  const MAX = 6;

  return {
    mode: "demo",
    async meta() {
      const l = await loadList();
      return { mode: "demo", candidate: l.candidate, generated_at: l.generated_at };
    },
    async listApplications() {
      return clone((await loadList()).jobs);
    },
    async getApplication(id) {
      // Only integer ids reach the path, so a crafted id can't walk the folder.
      if (!Number.isInteger(id)) return null;
      const d = await detail(id);
      return d ? clone(d) : null;
    },
    async createJob(fields) {
      const id = nextId++;
      const status = fields.status || "IN_PROGRESS";
      const row = { id, company: fields.company, role_title: fields.role_title, location: fields.location || "", status, applied_on: null, fit_score: fields.fit_score ?? null, odds_score: fields.odds_score ?? null, answer_count: 0, has_resume: false, has_cover_letter: false, source_url: fields.source_url || null };
      (await loadList()).jobs.unshift(row);
      details.set(id, {
        ...row, fictional: true, jd_text: fields.jd_text || "", source_url: fields.source_url || null,
        fit_breakdown: fields.fit_breakdown || null, pref_match: fields.pref_match || null,
        strengths: fields.strengths || [], gaps: fields.gaps || [], answers: [], history: [{ status, at: localToday() }],
      });
      return { id };
    },
    async updateJob(id, fields) {
      const row = await listRow(id);
      const d = await detail(id);
      if (!row || !d) throw new Error("Not found.");
      if (fields.status && fields.status !== row.status) {
        d.history.push({ status: fields.status, at: localToday() });
        if (fields.status === "APPLIED" && !row.applied_on) row.applied_on = d.applied_on = localToday();
      }
      Object.assign(row, fields);
      Object.assign(d, fields);
      return { id, status: row.status, applied_on: row.applied_on };
    },
    async addAnswer(jobId, fields) {
      const d = await detail(jobId);
      const a = { id: nextId++, question: fields.question, answer: fields.answer || "", char_limit: fields.char_limit || null, final: false };
      d.answers.push(a);
      (await listRow(jobId)).answer_count = d.answers.length;
      return clone(a);
    },
    async updateAnswer(id, fields) {
      for (const d of details.values()) {
        const a = d.answers.find((x) => x.id === id);
        if (!a) continue;
        Object.assign(a, fields);
        if (("answer" in fields || "question" in fields) && !("final" in fields)) a.final = false;
        return clone(a);
      }
      throw new Error("Not found.");
    },
    async deleteAnswer(id) {
      for (const [jobId, d] of details) {
        const i = d.answers.findIndex((x) => x.id === id);
        if (i < 0) continue;
        d.answers.splice(i, 1);
        (await listRow(jobId)).answer_count = d.answers.length;
        return { deleted: id };
      }
      throw new Error("Not found.");
    },
    async getProfile() {
      return clone(await loadProfile());
    },
    async saveName(name) {
      (await loadList()).candidate = { name };
      return { name };
    },
    async savePrefs(prefs) {
      Object.assign((await loadProfile()).prefs, prefs);
      return clone(profile.prefs);
    },
    async addFact(fact) {
      const f = { id: nextId++, kind: fact.kind || "skill", group: fact.group || "Other", text: fact.text, verified: false, source: "app" };
      (await loadProfile()).facts.push(f);
      return clone(f);
    },
    async updateFact(id, fields) {
      const f = (await loadProfile()).facts.find((x) => x.id === id);
      if (!f) throw new Error("Not found.");
      if ("text" in fields && fields.text !== f.text) Object.assign(f, { text: fields.text, verified: false });
      else if ("verified" in fields) f.verified = fields.verified;
      if ("group" in fields) f.group = fields.group;
      return clone(f);
    },
    async deleteFact(id) {
      const p = await loadProfile();
      p.facts = p.facts.filter((x) => x.id !== id);
      return { deleted: id };
    },
    async listDocuments() {
      return clone((await loadDocs()).map(({ content, ...d }) => d));
    },
    async getDocument(id) {
      const d = (await loadDocs()).find((x) => x.id === id);
      return d ? clone({ ...d, has_file: false }) : null;
    },
    async saveDocument(id, fields) {
      const d = (await loadDocs()).find((x) => x.id === id);
      if (!d) throw new Error("Not found.");
      if (d.sent) throw new Error("Sent documents are locked. Make a copy to edit.");
      Object.assign(d, fields, { updated_at: new Date().toISOString() });
      return clone(d);
    },
    async copyDocument(id) {
      const all = await loadDocs();
      const src = all.find((x) => x.id === id);
      const copy = { ...clone(src), id: nextId++, parent_id: id, sent: false, sent_at: null, title: `${src.title} (copy)`, created_at: new Date().toISOString() };
      all.unshift(copy);
      return clone(copy);
    },
    async editableBase() {
      const all = await loadDocs();
      const made = all.find((x) => x.source === "built" && !x.job_id && x.content);
      if (made) return clone(made);
      const copy = { ...clone(all.find((x) => x.kind === "resume" && x.content)), id: nextId++, job_id: null, source: "built", sent: false, sent_at: null, title: "Base resume (editable)", created_at: new Date().toISOString() };
      all.unshift(copy);
      return clone(copy);
    },
    async markSent(id) {
      const d = (await loadDocs()).find((x) => x.id === id);
      Object.assign(d, { sent: true, sent_at: new Date().toISOString() });
      return clone(d);
    },
    async documentFileUrl() {
      throw new Error("The demo has no stored files.");
    },
    // The public demo never calls the AI: it replays one recorded review.
    async reviewPosting({ text, url }) {
      await new Promise((r) => setTimeout(r, 1800));
      const sample = await getJson(`${DEMO_ROOT}review.json`);
      return { ...sample, jd_text: text || sample.jd_text, source_url: url || null };
    },
    async generateDoc(jobId, kind) {
      await new Promise((r) => setTimeout(r, 2200));
      const all = await loadDocs();
      const sample = all.find((d) => d.kind === kind && d.content);
      const job = await listRow(jobId);
      const doc = { ...clone(sample), id: nextId++, job_id: jobId, parent_id: null, sent: false, sent_at: null, created_at: new Date().toISOString(),
        title: `${kind === "letter" ? "Cover letter" : "Resume"} · ${job.company}`, file_name: `Jordan_Avery_${job.company.replace(/\W+/g, "")}.pdf` };
      all.unshift(doc);
      return { document: doc, flags: [], cost: 0 };
    },
    async exportWord() {
      throw new Error("Word download works when signed in. The demo can download PDF.");
    },
    async exportTranscript() {
      throw new Error("Word download works when signed in. In the demo, use Copy transcript.");
    },
    async uploadResume(file) {
      await new Promise((r) => setTimeout(r, 2000));
      const p = await loadProfile();
      const pick = (kind) => p.facts.filter((f) => f.kind === kind);
      return {
        document: { id: nextId++, title: "Base resume", file_name: file.name },
        extracted: {
          name: "Jordan Avery", contact: "Remote, United States · jordan.avery@example.com", summary: "",
          roles: [{ org: "Northfield Community College", title: "Lead Instructional Designer", dates: "2019 to present" }],
          results: pick("result").map((f) => ({ employer: f.group, text: f.text })),
          skills: [...new Set(pick("skill").map((f) => f.group))].map((g) => ({ group: g, items: pick("skill").filter((f) => f.group === g).map((f) => f.text) })),
          education: pick("education").map((f) => ({ text: f.text, dates: "" })),
        },
      };
    },
    async confirmFacts(facts) {
      const p = await loadProfile();
      const added = facts.map((f) => ({ id: nextId++, kind: f.kind, group: f.group, text: f.text, verified: true, source: "upload" }));
      p.facts.push(...added);
      return { facts: clone(added) };
    },
    async buildResume(entry) {
      await new Promise((r) => setTimeout(r, 2200));
      const all = await loadDocs();
      const sample = all.find((d) => d.kind === "resume" && d.content);
      const doc = { ...clone(sample), id: nextId++, job_id: null, source: "built", sent: false, title: "Resume built from your skills", file_name: "Resume.pdf", created_at: new Date().toISOString() };
      doc.content.name = entry.name || doc.content.name;
      all.unshift(doc);
      return { document: doc, flags: [], facts_added: 0 };
    },
    async getCoach(jobId) {
      const c = coach.get(jobId);
      return c ? clone({ ...c, max_main: MAX }) : { session: null, turns: [], max_main: MAX };
    },
    async coachStart(jobId) {
      await new Promise((r) => setTimeout(r, 1800));
      const d = (await detail(jobId))?.coach ? await detail(jobId) : await detail(101);
      const c = d.coach;
      const session = { id: `demo-${nextId++}`, job_id: jobId, state: "AWAIT_ANSWER", main_count: 1, created_at: new Date().toISOString(),
        prep: { priorities: c.priorities, concern: c.concern, stories: c.stories.map((x) => ({ ...x, priority: "" })) } };
      coach.set(jobId, { session, turns: [{ id: nextId++, position: 1, kind: "main", question: c.first_question.slice(0, c.first_question.indexOf("?") + 1) || c.first_question, answered_at: null }] });
      return this.getCoach(jobId);
    },
    async coachAnswer(sid, answer) {
      await new Promise((r) => setTimeout(r, 1500));
      const c = coachFor(sid);
      const open = c.turns.find((t) => !t.answered_at);
      if (!open) throw Object.assign(new Error("There's no open question. Ask for the next question first."), { status: 409 });
      Object.assign(open, { answer, answered_at: new Date().toISOString(), critique: { score: DEMO_FEEDBACK.score, worked: DEMO_FEEDBACK.worked, improve: DEMO_FEEDBACK.improve, new_facts: DEMO_FEEDBACK.new_facts }, improved_answer: DEMO_FEEDBACK.improved_answer, guard_flags: [] });
      if (open.kind === "main") {
        c.session.state = "AWAIT_FOLLOWUP";
        c.turns.push({ id: nextId++, position: c.turns.length + 1, kind: "followup", question: DEMO_FOLLOW_UP, answered_at: null });
      } else c.session.state = c.session.main_count >= MAX ? "DONE" : "ASK_MAIN";
      return this.getCoach(c.session.job_id);
    },
    async coachNext(sid) {
      const c = coachFor(sid);
      if (c.session.state !== "ASK_MAIN") throw Object.assign(new Error("Answer the follow-up question first."), { status: 409 });
      await new Promise((r) => setTimeout(r, 1200));
      c.turns.push({ id: nextId++, position: c.turns.length + 1, kind: "main", question: DEMO_NEXT[(c.session.main_count - 1) % DEMO_NEXT.length], answered_at: null });
      Object.assign(c.session, { state: "AWAIT_ANSWER", main_count: c.session.main_count + 1 });
      return this.getCoach(c.session.job_id);
    },
    async coachEnd(sid) {
      const c = coachFor(sid);
      c.session.state = "DONE";
      return this.getCoach(c.session.job_id);
    },
    async coachDelete(sid) {
      const c = coachFor(sid);
      coach.delete(c.session.job_id);
      return { deleted: sid };
    },
    async draftAnswer(jobId, { question, char_limit }) {
      await new Promise((r) => setTimeout(r, 1500));
      const a = await this.addAnswer(jobId, { question, char_limit });
      return { answer: await this.updateAnswer(a.id, { answer: demoAnswer(char_limit) }), flags: [] };
    },
    async redraftAnswer(id) {
      await new Promise((r) => setTimeout(r, 1500));
      for (const d of details.values()) {
        const a = d.answers.find((x) => x.id === id);
        if (a) return { answer: await this.updateAnswer(id, { answer: demoAnswer(a.char_limit) }), flags: [] };
      }
      throw new Error("Not found.");
    },
    async reviewJob(id) {
      const sample = await this.reviewPosting({});
      const d = await detail(id);
      const row = await listRow(id);
      for (const k of ["fit_score", "odds_score", "fit_breakdown", "pref_match", "strengths", "gaps"]) d[k] = sample[k];
      Object.assign(row, { fit_score: sample.fit_score, odds_score: sample.odds_score });
      return sample;
    },
  };
}

// The signed-in owner's real records, read and written through the API as
// that user (row-level security applies to every request).
export function apiSource(getToken) {
  async function wordFile(query) {
    const token = await getToken();
    if (!token) throw Object.assign(new Error("Your session has expired. Sign in again."), { status: 401 });
    const res = await fetch(`api/export?${query}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Word export failed (${res.status}).`);
    const name = (res.headers.get("content-disposition") || "").match(/filename="([^"]+)"/)?.[1] || "document.docx";
    return { blob: await res.blob(), name };
  }
  async function api(path, { method = "GET", body } = {}, retried = false) {
    const token = await getToken({ force: retried });
    if (!token) throw Object.assign(new Error("Your session has expired. Sign in again."), { status: 401 });
    const headers = { Accept: "application/json", Authorization: `Bearer ${token}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(`api/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    // A rejected token gets one renewal and one retry before giving up.
    if (res.status === 401 && !retried) return api(path, { method, body }, true);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status}).`), { status: res.status });
    return data;
  }
  let listing = null;
  const list = () => (listing ||= api("jobs"));
  const fresh = () => { listing = null; };

  return {
    mode: "live",
    async meta() {
      return (await list()).meta;
    },
    async listApplications() {
      return (await list()).jobs.map((j) => ({ ...j, status: normStatus(j.status) }));
    },
    async getApplication(id) {
      if (!Number.isInteger(id)) return null;
      try {
        return await api(`jobs?id=${id}`);
      } catch (e) {
        if (e.status === 404) return null;
        throw e;
      }
    },
    async createJob(fields) { fresh(); return api("jobs", { method: "POST", body: fields }); },
    async updateJob(id, fields) { fresh(); return api(`jobs?id=${id}`, { method: "PATCH", body: fields }); },
    async addAnswer(jobId, fields) { fresh(); return api("answers", { method: "POST", body: { job_id: jobId, ...fields } }); },
    async updateAnswer(id, fields) { return api(`answers?id=${id}`, { method: "PATCH", body: fields }); },
    async deleteAnswer(id) { fresh(); return api(`answers?id=${id}`, { method: "DELETE" }); },
    async getProfile() { return api("profile"); },
    async savePrefs(prefs) { return api("profile", { method: "PATCH", body: prefs }); },
    // The name lives on the owner's own sign-in account (Supabase user metadata).
    async saveName(name) { fresh(); return updateAccountName(name); },
    async addFact(fact) { return api("profile", { method: "POST", body: fact }); },
    async updateFact(id, fields) { return api(`profile?fact=${id}`, { method: "PATCH", body: fields }); },
    async deleteFact(id) { return api(`profile?fact=${id}`, { method: "DELETE" }); },
    async listDocuments() { return (await api("documents")).documents; },
    async getDocument(id) { return api(`documents?id=${id}`); },
    async saveDocument(id, fields) { return api(`documents?id=${id}`, { method: "PATCH", body: fields }); },
    async copyDocument(id) { return api(`documents?copy=${id}`, { method: "POST" }); },
    async editableBase() { return api("upload?base=1", { method: "POST", body: {} }); },
    async markSent(id) { fresh(); return api(`documents?sent=${id}`, { method: "POST" }); },
    async documentFileUrl(id) { return (await api(`documents?id=${id}&file=1`)).url; },
    async reviewPosting(input) { return api("review", { method: "POST", body: input }); },
    async reviewJob(id) { fresh(); return api(`review?job=${id}`, { method: "POST", body: {} }); },
    async generateDoc(jobId, kind) { return api(`generate?job=${jobId}&kind=${kind}`, { method: "POST", body: {} }); },
    async draftAnswer(jobId, fields) { fresh(); return api(`answer?job=${jobId}`, { method: "POST", body: fields }); },
    async getCoach(jobId) { return api(`coach?job=${jobId}`); },
    async coachStart(jobId) { return api(`coach?job=${jobId}&action=start`, { method: "POST", body: {} }); },
    async coachAnswer(sid, answer) { return api(`coach?session=${sid}&action=answer`, { method: "POST", body: { answer } }); },
    async coachNext(sid) { return api(`coach?session=${sid}&action=next`, { method: "POST", body: {} }); },
    async coachEnd(sid) { return api(`coach?session=${sid}&action=end`, { method: "POST", body: {} }); },
    async coachDelete(sid) { return api(`coach?session=${sid}`, { method: "DELETE" }); },
    async uploadResume(file) {
      if (file.size > 4 * 1024 * 1024) throw new Error("That file is larger than 4 MB.");
      const send = async (force) => {
        const token = await getToken({ force });
        if (!token) throw Object.assign(new Error("Your session has expired. Sign in again."), { status: 401 });
        return fetch("api/upload", { method: "POST", headers: { Authorization: `Bearer ${token}`, "X-File-Name": encodeURIComponent(file.name) }, body: file });
      };
      let res = await send(false);
      if (res.status === 401) res = await send(true);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(data.error || `Upload failed (${res.status}).`), { status: res.status });
      return data;
    },
    async confirmFacts(facts, source) { return api("profile?batch=1", { method: "POST", body: { facts, source, confirmed: true } }); },
    async buildResume(entry) { return api("build", { method: "POST", body: { ...entry, confirmed: true } }); },
    async redraftAnswer(id) { return api(`answer?id=${id}`, { method: "POST", body: {} }); },
    exportWord(id) { return wordFile(`id=${id}`); },
    exportTranscript(jobId) { return wordFile(`coach=${jobId}`); },
  };
}

// Signed-in owner gets live data; every other visitor sees the demo.
export function pickSource({ signedIn, getToken }) {
  return signedIn ? apiSource(getToken) : demoSource();
}
