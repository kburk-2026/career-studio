// Placeholder so a second provider can be added behind the same interface:
// generate*({ model, effort, system, cachedContext, content, schema, maxTokens })
//   -> { data, meta: { model, usage, cost } }
import { HttpError } from "../supabase.js";

export async function generateOpenAI() {
  throw new HttpError(501, "The OpenAI provider is not implemented yet.");
}
