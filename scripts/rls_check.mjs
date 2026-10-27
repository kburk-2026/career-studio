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
  "coach_sessions", "coach_turns", "ai_usage"];

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
    const r = await svc(`/rest/v1/${t}?select=id&limit=1`);
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
      const r = await svc(`/rest/v1/${t}?select=id&user_id=eq.${owner.id}`);
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

    const a = await other("/rest/v1/ai_usage", { method: "POST", body: { user_id: stranger.id, model: "x", input_tokens: 0, output_tokens: 0, cost_usd: 0 } });
    check("signed-in user cannot write AI usage rows", a.status >= 400, `HTTP ${a.status}`);

    const still = await svc(`/rest/v1/jobs?id=eq.${job.id}&select=company`);
    check("owner's canary job unchanged", still.data?.[0]?.company === "RLS canary");
  } finally {
    await svc(`/rest/v1/ai_usage?user_id=eq.${owner.id}&model=eq.canary`, { method: "DELETE" });
    await svc(`/rest/v1/profile_facts?user_id=eq.${owner.id}&group_title=eq.canary`, { method: "DELETE" });
    await svc(`/rest/v1/jobs?id=eq.${job.id}`, { method: "DELETE" }); // cascades to answers, history, coach rows
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
