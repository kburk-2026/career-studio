// Data source for the app.
//
// The UI only talks to a "source" object with these methods, so Phase 3 can
// swap the demo files for authenticated API calls without touching app.js:
//
//   meta()               -> { mode, candidate, generated_at }
//   listApplications()   -> [{ id, company, role_title, status, ... }]
//   getApplication(id)   -> { ...detail, coach? } or null
//   getProfile()         -> { source_label, groups: [{ title, items: [{ text, verified }] }] }

const DEMO_ROOT = "demo/";

async function getJson(path) {
  const res = await fetch(path, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Could not load ${path} (${res.status}).`);
  return res.json();
}

export function demoSource() {
  return {
    mode: "demo",
    async meta() {
      const list = await getJson(`${DEMO_ROOT}applications.json`);
      return { mode: "demo", candidate: list.candidate, generated_at: list.generated_at };
    },
    async listApplications() {
      return (await getJson(`${DEMO_ROOT}applications.json`)).jobs || [];
    },
    async getApplication(id) {
      // Only integer ids reach the path, so a crafted id can't walk the folder.
      if (!Number.isInteger(id)) return null;
      try {
        return await getJson(`${DEMO_ROOT}jobs/${id}.json`);
      } catch {
        return null;
      }
    },
    async getProfile() {
      return getJson(`${DEMO_ROOT}profile.json`);
    },
  };
}

// The signed-in owner's real records, read through the API as that user.
export function apiSource(getToken) {
  async function api(path) {
    const token = await getToken();
    if (!token) throw Object.assign(new Error("Your session has expired. Sign in again."), { status: 401 });
    const res = await fetch(`api/${path}`, { headers: { Accept: "application/json", Authorization: `Bearer ${token}` } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error || `Request failed (${res.status}).`), { status: res.status });
    return body;
  }
  let listing = null;
  const list = () => (listing ||= api("jobs"));
  return {
    mode: "live",
    async meta() {
      return (await list()).meta;
    },
    async listApplications() {
      return (await list()).jobs;
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
    async getProfile() {
      return api("profile");
    },
  };
}

// Signed-in owner gets live data; every other visitor sees the demo.
export function pickSource({ signedIn, getToken }) {
  return signedIn ? apiSource(getToken) : demoSource();
}
