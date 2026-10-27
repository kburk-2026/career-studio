// Privacy guard: fails if anything git would publish contains a secret,
// contact detail, or a real name/employer from the private canary list.
//
//   npm run check
//
// Canaries live in .privacy-canaries.txt (gitignored, one term per line).
// Copy .privacy-canaries.example.txt to start one.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SECRET_PATTERNS = [
  ["Anthropic API key", /sk-ant-[A-Za-z0-9_-]{10,}/],
  ["OpenAI-style API key", /\bsk-(?:proj-)?[A-Za-z0-9]{20,}/],
  ["JWT / Supabase key", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["Service role reference with value", /service_role["'\s:=]+eyJ/i],
];
const CONTACT_PATTERNS = [
  ["Email address", /\b[A-Za-z0-9._%+-]+@(?!example\.(?:com|org)\b|anthropic\.com\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/],
  ["Phone number", /(?<!\d)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\d)/],
];

export function loadCanaries(path = ".privacy-canaries.txt") {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Returns [{ file, line, kind }] for every hit. Matched text is not returned,
// so the report itself never echoes a secret.
export function scanText(file, text, canaries = []) {
  const canaryRes = canaries.map((c) => [`Private term "${c[0]}…"`, new RegExp(`\\b${escapeRe(c)}\\b`, "i")]);
  const checks = [...SECRET_PATTERNS, ...CONTACT_PATTERNS, ...canaryRes];
  const hits = [];
  text.split("\n").forEach((lineText, i) => {
    for (const [kind, re] of checks) if (re.test(lineText)) hits.push({ file, line: i + 1, kind });
  });
  return hits;
}

export function publishableFiles() {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" });
  return out.split("\n").filter(Boolean).filter((f) => existsSync(f));
}

const BINARY = /\.(png|jpe?g|gif|ico|pdf|woff2?|zip)$/i;

function main() {
  const canaries = loadCanaries();
  const files = publishableFiles().filter((f) => !BINARY.test(f));
  const hits = files.flatMap((f) => scanText(f, readFileSync(f, "utf8"), canaries));

  // Every demo record must say it is fictional.
  for (const f of files.filter((f) => f.startsWith("public/demo/") && f.endsWith(".json"))) {
    if (JSON.parse(readFileSync(f, "utf8")).fictional !== true) hits.push({ file: f, line: 1, kind: 'Demo file missing "fictional": true' });
  }

  if (!canaries.length) console.warn("WARN  no .privacy-canaries.txt; real-name checks skipped.");
  if (hits.length) {
    for (const h of hits) console.error(`FAIL  ${h.file}:${h.line}  ${h.kind}`);
    console.error(`\nPrivacy check FAILED (${hits.length} issue${hits.length === 1 ? "" : "s"}).`);
    process.exit(1);
  }
  console.log(`Privacy check PASS (${files.length} files, ${canaries.length} private terms).`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
