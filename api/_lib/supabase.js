// Shared helpers for the API functions.
//
// Every data request runs as the signed-in user: the user's own access token
// goes to Supabase with the public anon key, so row-level security applies.
// The service-role key is never read here and must never be set in Vercel.

export function config() {
  const url = (process.env.SUPABASE_URL || "").replace(/\/(rest\/v1\/?)?$/, "");
  const anonKey = process.env.SUPABASE_ANON_KEY || "";
  const allowedEmail = (process.env.ALLOWED_EMAIL || "").trim().toLowerCase();
  return { url, anonKey, allowedEmail, ready: Boolean(url && anonKey && allowedEmail) };
}

export function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Confirms the bearer token belongs to the one allowed account.
// RLS would already hide other users' rows; this also keeps any other
// account from reaching the API at all.
export async function requireOwner(request) {
  const cfg = config();
  if (!cfg.ready) throw new HttpError(503, "Server is not configured.");
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) throw new HttpError(401, "Sign in required.");

  const res = await fetch(`${cfg.url}/auth/v1/user`, {
    headers: { apikey: cfg.anonKey, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new HttpError(401, "Your session has expired. Sign in again.");
  const user = await res.json();
  if ((user.email || "").toLowerCase() !== cfg.allowedEmail) throw new HttpError(403, "This account is not allowed.");
  return { token, user, cfg };
}

// PostgREST read as the signed-in user.
export async function rest({ token, cfg }, path) {
  const res = await fetch(`${cfg.url}/rest/v1/${path}`, {
    headers: { apikey: cfg.anonKey, Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) throw new HttpError(502, `Database request failed (${res.status}).`);
  return res.json();
}

// Wraps a handler so thrown HttpErrors become JSON responses and nothing
// internal (stack traces, upstream bodies) reaches the browser.
export function handle(fn) {
  return async (request) => {
    try {
      return await fn(request);
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, { error: e.message });
      console.error(e);
      return json(500, { error: "Something went wrong." });
    }
  };
}
