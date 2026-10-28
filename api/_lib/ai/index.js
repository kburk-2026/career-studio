// Provider-neutral AI entry point.
//
// Callers name a task, not a model: "writer" tasks (resumes, cover letters)
// use the strongest model; "analyst" tasks (job review, extraction, answer
// drafts) use a faster, cheaper one. Both are switchable by env var.
import { generateClaude } from "./claude.js";
import { generateOpenAI } from "./openai.js";

export const TASKS = {
  writer: { model: () => process.env.MODEL_WRITER || "claude-opus-5-5", effort: "high", maxTokens: 16000 },
  analyst: { model: () => process.env.MODEL_ANALYST || "claude-sonnet-5-5", effort: "medium", maxTokens: 8000 },
};

const PROVIDERS = { claude: generateClaude, openai: generateOpenAI };

export async function generate({ task, system, cachedContext, content, schema }) {
  const t = TASKS[task];
  if (!t) throw new Error(`Unknown AI task: ${task}`);
  const provider = PROVIDERS[process.env.AI_PROVIDER || "claude"];
  return provider({ model: t.model(), effort: t.effort, maxTokens: t.maxTokens, system, cachedContext, content, schema });
}
