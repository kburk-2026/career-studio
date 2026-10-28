import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// Browser stand-ins for auth.js, which reads localStorage and fetches api/config.
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const { getAccessToken } = await import("../public/js/auth.js");
const { apiSource } = await import("../public/js/data.js");

const realFetch = globalThis.fetch;
let refreshCalls;

function session(expiresInMs) {
  store.set("cs_session", JSON.stringify({ access_token: "old", refresh_token: "r1", expires_at: Date.now() + expiresInMs }));
}

function fakeAuth(refreshReply) {
  refreshCalls = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === "api/config") return Response.json({ supabaseUrl: "https://ref.supabase.co", anonKey: "anon" });
    if (u.includes("grant_type=refresh_token")) {
      refreshCalls++;
      await new Promise((r) => setTimeout(r, 10));
      return refreshReply();
    }
    throw new Error(`unexpected ${u}`);
  };
}

beforeEach(() => store.clear());
afterEach(() => { globalThis.fetch = realFetch; });

test("a fresh token is used as is", async () => {
  session(30 * 60_000);
  fakeAuth(() => Response.json({}));
  assert.equal(await getAccessToken(), "old");
  assert.equal(refreshCalls, 0);
});

test("concurrent requests share one renewal (refresh tokens are single-use)", async () => {
  session(-1000);
  fakeAuth(() => Response.json({ access_token: "new", refresh_token: "r2", expires_in: 3600 }));
  const tokens = await Promise.all([getAccessToken(), getAccessToken(), getAccessToken(), getAccessToken()]);
  assert.deepEqual(tokens, ["new", "new", "new", "new"]);
  assert.equal(refreshCalls, 1);
  assert.equal(JSON.parse(store.get("cs_session")).refresh_token, "r2");
});

test("a network blip keeps the session", async () => {
  session(30_000); // still valid, but inside the renewal window
  fakeAuth(() => { throw new Error("offline"); });
  assert.equal(await getAccessToken(), "old");
  assert.ok(store.has("cs_session"));
});

test("a server error keeps the session for a later retry", async () => {
  session(-1000);
  fakeAuth(() => new Response("", { status: 503 }));
  assert.equal(await getAccessToken(), null, "expired token is not used");
  assert.ok(store.has("cs_session"), "but the session is kept");
});

test("only an invalid refresh token signs you out", async () => {
  session(-1000);
  fakeAuth(() => Response.json({ error: "invalid_grant" }, { status: 400 }));
  assert.equal(await getAccessToken(), null);
  assert.ok(!store.has("cs_session"));
});

test("a rejected request renews once and retries", async () => {
  let apiCalls = 0;
  const tokens = [];
  const getToken = async ({ force } = {}) => (force ? "renewed" : "stale");
  globalThis.fetch = async (url, init) => {
    apiCalls++;
    tokens.push(init.headers.Authorization);
    return init.headers.Authorization === "Bearer renewed" ? Response.json({ documents: [] }) : Response.json({ error: "expired" }, { status: 401 });
  };
  const docs = await apiSource(getToken).listDocuments();
  assert.deepEqual(docs, []);
  assert.equal(apiCalls, 2);
  assert.deepEqual(tokens, ["Bearer stale", "Bearer renewed"]);
});
