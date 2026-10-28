// Row-level security check against the live Supabase project.
//
//   node scripts/rls_check.mjs
//
// 1. Makes sure the owner account (ALLOWED_EMAIL) exists.
// 2. Plants a canary row for the owner in each user table.
// 3. Confirms an anonymous visitor and a throwaway second user see zero rows
//    and cannot insert, change, or delete anything.
// 4. Removes the canaries and the throwaway user.
//
// Uses the service-role key from .env for setup only. Prints no keys.
import { randomBytes } from "node:crypto";
import { loadEnv } from "./_env.mjs";

const env = loadEnv();
const URL_ = env.SUPABASE_URL;
const TABLES = ["jobs", "application_answers", "status_history", "profile_facts",
  "coach_sessions", "coach_turns", "ai_usage", "profile_prefs", "documents"];
// profile_prefs is keyed by user, not id.
const KEY = { profile_prefs: "user_id" };

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

async function call(path, { key, token, method = "GET", body, prefer } = {}) {
  const headers = { apikey: key, Authorization: `Bearer ${token ?? key}`, "Content-Type": "application/json" };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${URL_}${path}`, { method, headers, body: body && JSON.stringify(body) });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

const svc = (path, opts = {}) => call(path, { ...opts, key: env.SUPABASE_SERVICE_ROLE_KEY });
const asUser = (token) => (path, opts = {}) => call(path, { ...opts, key: env.SUPABASE_ANON_KEY, token });
const anon = (path, opts = {}) => call(path, { ...opts, key: env.SUPABASE_ANON_KEY });

async function findUser(email) {
  for (let page = 1; page < 50; page++) {
    const r = await svc(`/auth/v1/admin/users?page=${page}&per_page=100`);
    if (r.status !== 200) throw new Error(`listing users failed: HTTP ${r.status}`);
    const hit = r.data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (hit || r.data.users.length < 100) return hit;
  }
}

async function main() {
  // Tables exist and the service role can reach them.
  for (const t of TABLES) {
    const r = await svc(`/rest/v1/${t}?select=${KEY[t] || "id"}&limit=1`);
    check(`table ${t} reachable by local scripts`, r.status === 200, `HTTP ${r.status}`);
  }
  if (results.includes(false)) return;

  // Owner account.
  let owner = await findUser(env.ALLOWED_EMAIL);
  if (!owner) {
    const r = await svc("/auth/v1/admin/users", { method: "POST", body: { email: env.ALLOWED_EMAIL, email_confirm: true } });
    if (r.status >= 300) throw new Error(`creating owner account failed: HTTP ${r.status}`);
    owner = r.data;
    console.log("info  created the owner account for ALLOWED_EMAIL");
  } else {
    console.log("info  owner account already exists");
  }

  // Canary rows owned by the owner.
  const ins = (t, row) => svc(`/rest/v1/${t}`, { method: "POST", body: { user_id: owner.id, ...row }, prefer: "return=representation" });
  const job = (await ins("jobs", { company: "RLS canary", role_title: "RLS canary" })).data[0];
  const sess = (await ins("coach_sessions", { job_id: job.id })).data[0];
  await ins("application_answers", { job_id: job.id, question: "canary", answer: "canary" });
  await ins("status_history", { job_id: job.id, status: "APPLIED" });
  await ins("profile_facts", { group_title: "canary", text: "RLS canary" });
  await ins("coach_turns", { session_id: sess.id, position: 0, kind: "main", question: "canary" });
  await ins("ai_usage", { model: "canary", input_tokens: 0, output_tokens: 0, cost_usd: 0 });
  const doc = (await ins("documents", { job_id: job.id, kind: "resume", source: "generated", title: "RLS canary", content: { summary: "canary" } })).data[0];
  // Keep any real preferences row; only add one if none exists.
  const hadPrefs = (await svc(`/rest/v1/profile_prefs?user_id=eq.${owner.id}&select=user_id`)).data.length > 0;
  if (!hadPrefs) await ins("profile_prefs", { location: "RLS canary" });
  const objectPath = `${owner.id}/rls-canary-${randomBytes(4).toString("hex")}.pdf`;
  const up = await fetch(`${URL_}/storage/v1/object/docs/${objectPath}`, {
    method: "POST", headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/pdf" },
    body: "%PDF-1.4 canary",
  });
  check("canary file stored in the private bucket", up.ok, `HTTP ${up.status}`);

  // Throwaway second user, signed in with a random password.
  const email = `rls-check-${randomBytes(4).toString("hex")}@example.com`;
  const password = randomBytes(24).toString("base64url");
  const created = await svc("/auth/v1/admin/users", { method: "POST", body: { email, password, email_confirm: true } });
  if (created.status >= 300) throw new Error(`creating test user failed: HTTP ${created.status}`);
  const stranger = created.data;

  try {
    const login = await call("/auth/v1/token?grant_type=password",
      { key: env.SUPABASE_ANON_KEY, method: "POST", body: { email, password } });
    if (login.status !== 200) throw new Error(`test user sign-in failed: HTTP ${login.status}`);
    const other = asUser(login.data.access_token);

    // Sanity: the canaries really are there, so "zero rows" below means something.
    for (const t of TABLES) {
      const r = await svc(`/rest/v1/${t}?select=${KEY[t] || "id"}&user_id=eq.${owner.id}`);
      check(`canary present in ${t}`, Array.isArray(r.data) && r.data.length > 0);
    }

    for (const [who, client] of [["anonymous visitor", anon], ["second signed-in user", other]]) {
      for (const t of TABLES) {
        const r = await client(`/rest/v1/${t}?select=*`);
        const rows = Array.isArray(r.data) ? r.data.length : 0;
        check(`${who} reads 0 rows from ${t}`, rows === 0, `HTTP ${r.status}, ${rows} rows`);
      }
      const w = await client("/rest/v1/jobs", { method: "POST", body: { user_id: owner.id, company: "x", role_title: "x" } });
      check(`${who} cannot insert a job as the owner`, w.status >= 400, `HTTP ${w.status}`);
      const u = await client(`/rest/v1/jobs?id=eq.${job.id}`, { method: "PATCH", body: { company: "tampered" }, prefer: "return=representation" });
      check(`${who} cannot change the owner's job`, u.status >= 400 || (Array.isArray(u.data) && u.data.length === 0), `HTTP ${u.status}`);
      const d = await client(`/rest/v1/jobs?id=eq.${job.id}`, { method: "DELETE", prefer: "return=representation" });
      check(`${who} cannot delete the owner's job`, d.status >= 400 || (Array.isArray(d.data) && d.data.length === 0), `HTTP ${d.status}`);
    }

    // Private files: neither visitor can read, sign, list, or add to the owner's folder.
    for (const [who, token] of [["anonymous visitor", env.SUPABASE_ANON_KEY], ["second signed-in user", login.data.access_token]]) {
      const h = { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` };
      const get = await fetch(`${URL_}/storage/v1/object/docs/${objectPath}`, { headers: h });
      check(`${who} cannot download the owner's file`, get.status >= 400, `HTTP ${get.status}`);
      const sign = await fetch(`${URL_}/storage/v1/object/sign/docs/${objectPath}`, { method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify({ expiresIn: 60 }) });
      check(`${who} cannot create a download link for it`, sign.status >= 400, `HTTP ${sign.status}`);
      const listing = await fetch(`${URL_}/storage/v1/object/list/docs`, { method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify({ prefix: `${owner.id}/` }) });
      const items = listing.ok ? await listing.json() : [];
      check(`${who} sees no files in the owner's folder`, !Array.isArray(items) || items.length === 0, `HTTP ${listing.status}`);
      const put = await fetch(`${URL_}/storage/v1/object/docs/${owner.id}/intruder.pdf`, { method: "POST", headers: { ...h, "Content-Type": "application/pdf" }, body: "%PDF-1.4 x" });
      check(`${who} cannot upload into the owner's folder`, put.status >= 400, `HTTP ${put.status}`);
    }

    // Sent documents stay frozen, even for the owner's own scripts.
    await svc(`/rest/v1/documents?id=eq.${doc.id}`, { method: "PATCH", body: { sent: true } });
    const edit = await svc(`/rest/v1/documents?id=eq.${doc.id}`, { method: "PATCH", body: { content: { summary: "changed" } } });
    check("a sent document cannot be edited", edit.status >= 400, `HTTP ${edit.status}`);

    const anonUsage = await anon("/rest/v1/rpc/record_ai_usage", { method: "POST", body: { p_model: "x", p_input: 0, p_output: 0, p_cost: 0 } });
    check("anonymous visitor cannot record AI usage", anonUsage.status >= 400, `HTTP ${anonUsage.status}`);

    const a = await other("/rest/v1/ai_usage", { method: "POST", body: { user_id: stranger.id, model: "x", input_tokens: 0, output_tokens: 0, cost_usd: 0 } });
    check("signed-in user cannot write AI usage rows", a.status >= 400, `HTTP ${a.status}`);

    const still = await svc(`/rest/v1/jobs?id=eq.${job.id}&select=company`);
    check("owner's canary job unchanged", still.data?.[0]?.company === "RLS canary");
  } finally {
    await svc(`/rest/v1/ai_usage?user_id=eq.${owner.id}&model=eq.canary`, { method: "DELETE" });
    await svc(`/rest/v1/profile_facts?user_id=eq.${owner.id}&group_title=eq.canary`, { method: "DELETE" });
    // Only the service role may delete a sent document, which is what cleans up the canary.
    await svc(`/rest/v1/documents?id=eq.${doc.id}`, { method: "DELETE" });
    await svc(`/rest/v1/jobs?id=eq.${job.id}`, { method: "DELETE" }); // cascades to answers, history, coach rows
    if (!hadPrefs) await svc(`/rest/v1/profile_prefs?user_id=eq.${owner.id}`, { method: "DELETE" });
    await fetch(`${URL_}/storage/v1/object/docs/${objectPath}`, { method: "DELETE", headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } });
    await svc(`/auth/v1/admin/users/${stranger.id}`, { method: "DELETE" });
    console.log("info  removed canary rows and the test user");
  }
}

try {
  await main();
} catch (e) {
  console.log(`FAIL  ${e.message}`);
  results.push(false);
}
const failed = results.filter((ok) => !ok).length;
console.log(failed ? `\nRLS check FAILED (${failed} of ${results.length})` : `\nRLS check PASS (${results.length} checks)`);
process.exit(failed ? 1 : 0);
