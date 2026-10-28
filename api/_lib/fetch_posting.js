// Fetches a job posting from a link, safely.
//
// The server only fetches public https pages: every hop (including redirects)
// is resolved and refused if it points at a private, loopback, or link-local
// address, so a link can't be used to reach internal services. Small and
// fast: 5 seconds, 1 MB, then HTML is reduced to text.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { HttpError } from "./supabase.js";

const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;

export function isPrivateAddress(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe8") || v6.startsWith("fe9") ||
    v6.startsWith("fea") || v6.startsWith("feb") || v6.startsWith("ff");
}

export async function assertPublicUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, "That link isn't a valid web address.");
  }
  if (url.protocol !== "https:") throw new HttpError(400, "Only https:// links can be read.");
  if (url.username || url.password) throw new HttpError(400, "Links with sign-in details can't be read.");
  if (url.port && url.port !== "443") throw new HttpError(400, "That link uses an unusual port.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addresses.length) throw new HttpError(400, "That site couldn't be found.");
  if (addresses.some((a) => isPrivateAddress(a.address))) throw new HttpError(400, "That link points to a private address.");
  return url;
}

export function htmlToText(html) {
  return String(html)
    .replace(/<(script|style|noscript|svg|head|nav|footer)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*/g, "\n\n")
    .trim();
}

export async function fetchPosting(raw) {
  let url = await assertPublicUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "User-Agent": "CareerStudio/1.0 (personal job-posting reader)", Accept: "text/html,text/plain" },
    }).catch(() => { throw new HttpError(502, "That page didn't respond. Paste the posting text instead."); });

    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = await assertPublicUrl(new URL(res.headers.get("location"), url).toString());
      continue;
    }
    if (!res.ok) throw new HttpError(502, `That page returned an error (${res.status}). Paste the posting text instead.`);
    const type = res.headers.get("content-type") || "";
    if (!/text\/(html|plain)/i.test(type)) throw new HttpError(415, "That link isn't a web page. Paste the posting text instead.");

    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) { await reader.cancel(); throw new HttpError(413, "That page is too large. Paste the posting text instead."); }
      chunks.push(value);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    const text = /html/i.test(type) ? htmlToText(body) : body.trim();
    // Pages that load the posting with JavaScript come back nearly empty.
    if (text.length < 300) throw new HttpError(422, "That site didn't share the posting text. Paste it instead.");
    return { text: text.slice(0, 60_000), finalUrl: url.toString() };
  }
  throw new HttpError(502, "Too many redirects. Paste the posting text instead.");
}
