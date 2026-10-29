// AI spending limits, checked before every AI call.
//
// The Anthropic Console spend limit is the hard stop; this is the app's own,
// lower cap so a runaway loop or a bug stops early. Usage is recorded through
// record_ai_usage(), which can only add rows.
import { rest, rpc, HttpError } from "./supabase.js";

export const monthlyCap = () => Number(process.env.AI_MONTHLY_CAP_USD || 15);
export const dailyCalls = () => Number(process.env.AI_DAILY_CALLS || 60);

export function startOfMonth(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

export function summarize(rows, now = new Date()) {
  const dayAgo = now.getTime() - 24 * 3600 * 1000;
  return {
    spent: rows.reduce((sum, r) => sum + Number(r.cost_usd || 0), 0),
    callsToday: rows.filter((r) => Date.parse(r.created_at) >= dayAgo).length,
  };
}

export async function checkBudget(session) {
  const rows = await rest(session, `ai_usage?select=cost_usd,created_at&created_at=gte.${startOfMonth()}`);
  const { spent, callsToday } = summarize(rows);
  if (spent >= monthlyCap()) throw new HttpError(429, "This month's AI limit is reached.");
  if (callsToday >= dailyCalls()) throw new HttpError(429, "Today's AI limit is reached. Try again tomorrow.");
  return { spent, remaining: monthlyCap() - spent };
}

export async function recordUsage(session, meta) {
  if (!meta) return;
  const u = meta.usage || {};
  await rpc(session, "record_ai_usage", {
    p_model: meta.model,
    p_input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
    p_output: u.output_tokens || 0,
    p_cost: Number(meta.cost.toFixed(6)),
  });
}

// Runs one AI call inside the budget, recording what it cost even if the
// reply turns out to be unusable.
export async function withBudget(session, call) {
  await checkBudget(session);
  try {
    const result = await call();
    await recordUsage(session, result.meta);
    return result;
  } catch (e) {
    if (e.meta) await recordUsage(session, e.meta).catch(() => {});
    throw e;
  }
}
