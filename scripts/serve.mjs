// Tiny zero-dependency server for local preview: npm run dev
//
// Serves public/ and runs api/*.js the way Vercel does (Web-standard GET
// handlers). If a local .env exists, only the three settings Vercel also has
// are loaded; the service-role key is never passed to the API code.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { loadEnv } from "./_env.mjs";

const ROOT = resolve("public");
const API = resolve("api");
const PORT = Number(process.env.PORT) || 4173;
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };

if (existsSync(".env")) {
  try {
    const env = loadEnv();
    for (const k of ["SUPABASE_URL", "SUPABASE_ANON_KEY", "ALLOWED_EMAIL"]) process.env[k] = env[k];
  } catch (e) {
    console.warn(`.env not loaded (${e.message}); the API will report it is not configured.`);
  }
}

async function runApi(req, res, name) {
  // Route names are plain words only; _lib and anything else is not a route.
  if (!/^[a-z]+$/.test(name) || !existsSync(join(API, `${name}.js`))) {
    res.writeHead(404).end("Not found");
    return;
  }
  const mod = await import(pathToFileURL(join(API, `${name}.js`)).href);
  const method = req.method;
  if (!["GET", "POST", "PATCH", "DELETE"].includes(method) || typeof mod[method] !== "function") {
    res.writeHead(405).end("Method not allowed");
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = method === "GET" ? undefined : Buffer.concat(chunks);
  const request = new Request(`http://localhost:${PORT}${req.url}`, { method, headers: req.headers, body });
  const response = await mod[method](request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const api = path.match(/^\/api\/([^/]+)$/);
  if (api) {
    try {
      await runApi(req, res, api[1]);
    } catch (e) {
      console.error(e);
      res.writeHead(500).end("Server error");
    }
    return;
  }
  const file = normalize(join(ROOT, path.endsWith("/") ? `${path}index.html` : path));
  if (file !== ROOT && !file.startsWith(ROOT + sep)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": `${TYPES[extname(file)] || "application/octet-stream"}; charset=utf-8`, "Cache-Control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
}).listen(PORT, () => console.log(`Career Studio preview: http://localhost:${PORT}`));
