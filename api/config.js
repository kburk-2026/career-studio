// Public sign-in settings for the browser. The anon key is designed to be
// public; row-level security is what protects the data.
import { config, json } from "./_lib/supabase.js";

export function GET() {
  const cfg = config();
  if (!cfg.ready) return json(503, { error: "Server is not configured." });
  return json(200, { supabaseUrl: cfg.url, anonKey: cfg.anonKey });
}
