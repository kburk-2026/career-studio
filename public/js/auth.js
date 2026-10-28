// Magic-link sign-in against Supabase Auth, with no SDK.
//
// Flow: the owner enters their email, Supabase emails a one-time link, and the
// link returns here with the session in the URL fragment. We keep the session
// in localStorage, strip the fragment from the address bar, and refresh the
// access token before it expires. Sign-ups are disabled server-side, and
// create_user:false means an unknown email never gets an account.

const KEY = "cs_session";
let cfgPromise = null;

const storage = {
  get() { try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch { return null; } },
  set(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* session lasts this page only */ } },
  clear() { try { localStorage.removeItem(KEY); } catch { /* nothing stored */ } },
};

// Sign-in settings come from the server. Missing (local preview without API,
// or an unconfigured deploy) means demo only.
export function loadConfig() {
  cfgPromise ||= fetch("api/config", { headers: { Accept: "application/json" } })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  return cfgPromise;
}

// Parses "#access_token=...&refresh_token=...&expires_in=3600" or an error fragment.
export function parseFragment(hash, now = Date.now()) {
  const p = new URLSearchParams(String(hash || "").replace(/^#/, ""));
  if (p.get("error_description")) return { error: p.get("error_description").replace(/\+/g, " ") };
  const access = p.get("access_token");
  const refresh = p.get("refresh_token");
  if (!access || !refresh) return null;
  const expiresIn = Number(p.get("expires_in")) || 3600;
  return { session: { access_token: access, refresh_token: refresh, expires_at: now + expiresIn * 1000 } };
}

// Call once on page load. Returns an error message from a failed link, if any.
export function consumeRedirect() {
  const parsed = parseFragment(location.hash);
  if (!parsed) return null;
  history.replaceState(null, "", location.pathname + location.search);
  if (parsed.session) storage.set(parsed.session);
  return parsed.error || null;
}

export function hasSession() {
  return Boolean(storage.get());
}

// Returns a fresh access token, renewing it if it expires within a minute.
//
// Refresh tokens are single-use, so concurrent callers share one renewal
// (several requests start at once when the page loads). The session is only
// dropped when Supabase says the refresh token is no longer valid; a network
// blip keeps it, so the owner stays signed in until they sign out.
let renewing = null;

export async function getAccessToken({ force = false } = {}) {
  const s = storage.get();
  if (!s) return null;
  if (!force && s.expires_at - Date.now() > 60_000) return s.access_token;
  renewing ||= renew(s).finally(() => { renewing = null; });
  return renewing;
}

async function renew(s) {
  const cfg = await loadConfig();
  if (!cfg) return s.expires_at > Date.now() ? s.access_token : null;
  const res = await fetch(`${cfg.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { apikey: cfg.anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: s.refresh_token }),
  }).catch(() => null);
  if (!res) return s.expires_at > Date.now() ? s.access_token : null; // offline: keep the session
  if (res.status === 400 || res.status === 401) {
    // Another tab may have renewed first; use its newer session if so.
    const latest = storage.get();
    if (latest && latest.refresh_token !== s.refresh_token) return latest.access_token;
    storage.clear();
    return null;
  }
  if (!res.ok) return s.expires_at > Date.now() ? s.access_token : null; // server trouble: try again later
  const d = await res.json();
  storage.set({ access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Date.now() + d.expires_in * 1000 });
  return d.access_token;
}

export async function sendMagicLink(email) {
  const cfg = await loadConfig();
  if (!cfg) throw new Error("Sign-in isn't available here.");
  const redirect = encodeURIComponent(location.origin + location.pathname);
  const res = await fetch(`${cfg.supabaseUrl}/auth/v1/otp?redirect_to=${redirect}`, {
    method: "POST",
    headers: { apikey: cfg.anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email, create_user: false }),
  }).catch(() => null);
  // Rate limits are worth reporting; anything else gets the same neutral
  // answer so the form doesn't reveal which emails have accounts.
  if (res?.status === 429) throw new Error("Too many requests. Wait a minute and try again.");
}

// Saves the owner's display name on their own account (Supabase user metadata).
export async function updateAccountName(name) {
  const cfg = await loadConfig();
  const token = await getAccessToken();
  if (!cfg || !token) throw Object.assign(new Error("Your session has expired. Sign in again."), { status: 401 });
  const res = await fetch(`${cfg.supabaseUrl}/auth/v1/user`, {
    method: "PUT",
    headers: { apikey: cfg.anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ data: { full_name: String(name).slice(0, 120) } }),
  });
  if (!res.ok) throw new Error("Could not save your name.");
  return { name };
}

export async function signOut() {
  const s = storage.get();
  storage.clear();
  const cfg = await loadConfig();
  if (s && cfg) {
    await fetch(`${cfg.supabaseUrl}/auth/v1/logout`, {
      method: "POST",
      headers: { apikey: cfg.anonKey, Authorization: `Bearer ${s.access_token}` },
    }).catch(() => null);
  }
}
