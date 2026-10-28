// The coach's turn order, enforced on the server so the model can't skip it.
//
//   start  -> AWAIT_ANSWER      (prep plus the first main question)
//   answer: AWAIT_ANSWER   -> AWAIT_FOLLOWUP (or ASK_MAIN if no follow-up)
//           AWAIT_FOLLOWUP -> ASK_MAIN (or DONE after the last main question)
//   next:   ASK_MAIN       -> AWAIT_ANSWER
//   end:    any            -> DONE
import { HttpError } from "../supabase.js";

export const MAX_MAIN = 6;

const WHY = {
  answer: { ASK_MAIN: "There's no open question. Ask for the next question first.", DONE: "This session has ended. Start a new one." },
  next: {
    AWAIT_ANSWER: "Answer the current question first.",
    AWAIT_FOLLOWUP: "Answer the follow-up question first.",
    DONE: "This session has ended. Start a new one.",
  },
};

export function transition(state, action, { hasFollowUp = false, mainCount = 0 } = {}) {
  if (action === "end") return "DONE";
  if (action === "answer") {
    if (state === "AWAIT_ANSWER") return hasFollowUp ? "AWAIT_FOLLOWUP" : mainCount >= MAX_MAIN ? "DONE" : "ASK_MAIN";
    if (state === "AWAIT_FOLLOWUP") return mainCount >= MAX_MAIN ? "DONE" : "ASK_MAIN";
    throw new HttpError(409, WHY.answer[state] || "No question is waiting for an answer.");
  }
  if (action === "next") {
    if (state === "ASK_MAIN" && mainCount < MAX_MAIN) return "AWAIT_ANSWER";
    if (state === "ASK_MAIN") throw new HttpError(409, `That was the last of ${MAX_MAIN} questions. Start a new session to keep practicing.`);
    throw new HttpError(409, WHY.next[state] || "Not ready for the next question.");
  }
  throw new HttpError(400, "Unknown action.");
}

// One question per turn: anything after the first question mark is dropped.
export function oneQuestion(text) {
  const t = String(text || "").trim();
  const q = t.indexOf("?");
  return q === -1 ? t : t.slice(0, q + 1);
}
