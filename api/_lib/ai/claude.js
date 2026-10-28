// Claude implementation of the AI adapter.
//
// Structured output only: every call passes a JSON schema, and the reply is
// parsed and returned as data. The stable system prompt (rules plus the
// confirmed profile) is cached, so repeat calls in a session cost less.
import Anthropic from "@anthropic-ai/sdk";
import { HttpError } from "../supabase.js";

// $ per million tokens. Cache writes cost 1.25x input.
export const PRICES = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
};

export function costOf(model, usage = {}) {
  const p = PRICES[model] || PRICES["claude-opus-5-5"]; // unknown model: price high, not low
  const m = 1_000_000;
  return (
    ((usage.input_tokens || 0) * p.input +
      (usage.cache_creation_input_tokens || 0) * p.input * 1.25 +
      (usage.cache_read_input_tokens || 0) * p.cacheRead +
      (usage.output_tokens || 0) * p.output) / m
  );
}

let client = null;

export async function generateClaude({ model, effort, system, cachedContext, content, schema, maxTokens }) {
  if (!process.env.ANTHROPIC_API_KEY) throw new HttpError(503, "AI is not configured on the server.");
  client ||= new Anthropic();

  const systemBlocks = [{ type: "text", text: system }];
  if (cachedContext) systemBlocks.push({ type: "text", text: cachedContext, cache_control: { type: "ephemeral" } });

  let response;
  try {
    response = await client.beta.messages.create({
      model,
      max_tokens: maxTokens,
      system: systemBlocks,
      messages: [{ role: "user", content }],
      output_config: { effort, format: { type: "json_schema", schema } },
      // If a safety classifier declines, the API retries on a suitable model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) throw new HttpError(429, "The AI is busy. Try again in a minute.");
    if (e instanceof Anthropic.AuthenticationError) throw new HttpError(503, "The AI key on the server was rejected.");
    if (e instanceof Anthropic.BadRequestError) {
      console.error("Claude bad request:", e.message);
      throw new HttpError(502, "The AI request was rejected.");
    }
    if (e instanceof Anthropic.APIError) throw new HttpError(502, `The AI service returned an error (${e.status}).`);
    throw new HttpError(502, "Could not reach the AI service.");
  }

  const usage = response.usage || {};
  const servedBy = response.model || model;
  const meta = { model: servedBy, usage, cost: costOf(servedBy, usage) };

  if (response.stop_reason === "refusal") throw Object.assign(new HttpError(422, "The AI declined this request."), { meta });
  if (response.stop_reason === "max_tokens") throw Object.assign(new HttpError(502, "The AI reply was cut off. Try a shorter posting."), { meta });

  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  try {
    return { data: JSON.parse(text), meta };
  } catch {
    throw Object.assign(new HttpError(502, "The AI reply was not valid data."), { meta });
  }
}
