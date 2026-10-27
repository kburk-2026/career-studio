// Loads career-studio/.env for local scripts. Never logs values.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function loadEnv(path = fileURLToPath(new URL("../.env", import.meta.url))) {
  const env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  for (const k of ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "ALLOWED_EMAIL"]) {
    if (!env[k]) throw new Error(`${k} is missing from .env`);
  }
  env.SUPABASE_URL = env.SUPABASE_URL.replace(/\/(rest\/v1\/?)?$/, "");
  return env;
}
