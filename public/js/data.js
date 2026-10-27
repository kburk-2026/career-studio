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

// Phase 3 adds apiSource() here. Until then every visitor sees the demo.
export function pickSource() {
  return demoSource();
}
