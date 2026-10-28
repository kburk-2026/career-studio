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

// PostgREST write as the signed-in user. Returns the affected rows.
export async function restWrite({ token, cfg }, method, path, body, { upsert = false } = {}) {
  const res = await fetch(`${cfg.url}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: cfg.anonKey,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      Prefer: upsert ? "return=representation,resolution=merge-duplicates" : "return=representation",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    // Database triggers (e.g. the sent-document lock) explain themselves;
    // pass that message on, but nothing else from upstream.
    let detail = {};
    try { detail = JSON.parse(text); } catch { /* not JSON */ }
    if (detail.code === "P0001" && detail.message) throw new HttpError(409, detail.message);
    throw new HttpError(502, `Database write failed (${res.status}).`);
  }
  return text ? JSON.parse(text) : [];
}

// Calls a Postgres function (RPC) as the signed-in user.
export async function rpc({ token, cfg }, name, args) {
  const res = await fetch(`${cfg.url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: cfg.anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new HttpError(502, `Database call failed (${res.status}).`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const MAX_BODY = 64 * 1024;

// Reads a JSON object body with a size cap.
export async function readJson(request, max = MAX_BODY) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > max) throw new HttpError(413, "Request too large.");
  const text = await request.text();
  if (text.length > max) throw new HttpError(413, "Request too large.");
  let body;
  try {
    body = JSON.parse(text || "{}");
  } catch {
    throw new HttpError(400, "Invalid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Expected a JSON object.");
  return body;
}

// Positive integer id from the query string, or a 400.
export function idParam(request, name = "id") {
  const raw = new URL(request.url).searchParams.get(name);
  const id = Number(raw);
  if (raw === null || !Number.isInteger(id) || id <= 0) throw new HttpError(400, `Invalid ${name}.`);
  return id;
}

// Field validators: each returns the clean value or throws a 400.
export const v = {
  text(value, field, { max = 2000, required = false } = {}) {
    if (value === undefined || value === null || value === "") {
      if (required) throw new HttpError(400, `${field} is required.`);
      return null;
    }
    if (typeof value !== "string") throw new HttpError(400, `${field} must be text.`);
    const s = value.trim();
    if (s.length > max) throw new HttpError(400, `${field} is too long (max ${max}).`);
    if (required && !s) throw new HttpError(400, `${field} is required.`);
    return s || null;
  },
  int(value, field, { min = 0, max = 10_000_000 } = {}) {
    if (value === undefined || value === null || value === "") return null;
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${field} must be a whole number.`);
    return n;
  },
  bool(value, field) {
    if (value === undefined || value === null) return null;
    if (typeof value !== "boolean") throw new HttpError(400, `${field} must be true or false.`);
    return value;
  },
  oneOf(value, field, allowed) {
    if (!allowed.includes(value)) throw new HttpError(400, `${field} must be one of: ${allowed.join(", ")}.`);
    return value;
  },
};

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
