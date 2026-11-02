// Drafts always show the profile's current links when opened or exported.
// Sent documents are left exactly as they were sent.
import { rest } from "./supabase.js";
import { linksFromPrefs } from "../../public/js/doc.js";

export async function withProfileLinks(session, doc) {
  if (doc.sent || !doc.content) return doc;
  const [prefs] = await rest(session, "profile_prefs?select=linkedin_url,portfolio_url,website_url");
  return { ...doc, content: { ...doc.content, links: linksFromPrefs(prefs) } };
}
