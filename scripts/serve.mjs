// Tiny zero-dependency static server for local preview: npm run dev
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

const ROOT = resolve("public");
const PORT = Number(process.env.PORT) || 4173;
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
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
