# Career Studio: private job-search dashboard + AI interview coach

> The approved build plan, kept as written (Oct 2026) so the project history shows how decisions were made. Phase status lives in the README.

## Context

The handoff package (`handoff/claude_code_interview_coach/`) has a working front-end mockup (`source/dashboard_app/mockup.html`), an old passcode-gated Vercel API (`source/dashboard_app/api/*.js`), a single-table schema, and a sanitized fixture for one interviewing application. Karen wants a product that (a) helps her land a job and (b) publicly shows she can build a product with AI. It's her first AI integration; she knows GitHub (Pro), and Vercel, Supabase and the AI APIs are all new to her.

Her decisions:
- Interview practice for Wednesday Oct 28 runs separately, in chat, starting now. The product is built afterward with no deadline.
- New repo on her GitHub account. Code goes public with a demo mode built on a fictional candidate. Real data sits only behind her login.
- Claude API now, behind a small adapter so OpenAI can be plugged in later.
- Free tiers (Vercel Hobby, Supabase Free) plus a hard AI spend cap of about $10-20 a month.
- Dashboard and coach ship together as one release, built in the phase order below.
- Plain HTML/JS front end, evolved from the mockup.
- The profile's source of truth is the database. Edits stay "unverified" until she confirms them, and a script pulls confirmed facts into JobHuntAgent's `verified_facts.md`.

## Integrity and viability findings

1. **Timeline:** the interview is in 2 days. Nothing built here will be ready in time, which is why the quick track is separate.
2. **Existing API is unsafe:** `api/jobs.js` takes the passcode as a URL query parameter and builds the `status` filter by string interpolation, which allows PostgREST filter injection. Both endpoints use `SUPABASE_SERVICE_KEY`, which bypasses row-level security. `schema.sql` has no `user_id` and no RLS. **Rewrite, don't extend.**
3. **The model can't be trusted to enforce "one question at a time".** The server must enforce it with a stored state machine.
4. **The model can't be trusted to "never fabricate".** Add a code-level guard: any number in an AI-written "improved answer" must appear in the evidence bank, or it gets flagged.
5. **A public demo with live AI is a cost and abuse risk.** The demo replays a recorded coach session. Live AI is available only to the signed-in owner.
6. **Supabase Free pauses after about 7 days of inactivity.** That's fine for a portfolio, but the README must say the first load may take a moment to wake it.
7. **Profile sync:** the hosted app can't write to files on her Mac. Only the pull script does that, and she runs it on demand.
8. **GitHub Pages is off the table** for anything personal: Pages sites are public even when the repo is private.

## Architecture

```
career-studio/              (new repo, private until the Phase 6 audit, then public)
  public/                   static app (evolved from mockup.html), demo fixture, recorded demo session
  api/                      Vercel serverless functions
    _lib/auth.js            verify Supabase JWT, build per-request client using USER token (RLS applies)
    _lib/ai/index.js        provider adapter: generate({system, messages, schema}) -> validated JSON
    _lib/ai/claude.js       Anthropic SDK impl (structured output via tool use)
    _lib/ai/openai.js       stub, same interface
    _lib/coach/machine.js   state machine: ASK_MAIN -> AWAIT_ANSWER -> FOLLOWUP -> AWAIT_FOLLOWUP -> next
    _lib/coach/prompt.js    system prompt; JD + evidence wrapped in <job_description>/<evidence> data tags
    _lib/coach/guard.js     numeric-claim + banned-claim checks on model output
    _lib/limits.js          body size, per-user daily turn cap, monthly token budget (ai_usage table)
    coach.js  jobs.js  profile.js  export.js
  supabase/migrations/      tables + RLS policies (user_id = auth.uid()) on every table
  scripts/
    import_jobhunt.py       backs up data/jobs.db, then copies sent applications into Supabase (reuses sync_supabase.py patterns)
    pull_profile.py         confirmed profile facts -> JobHuntAgent candidate_profile/verified_facts.md
  evals/                    injection JD, fabrication bait, one-question-rule cases; `npm run eval`
  tests/                    node:test for machine.js, guard.js, limits.js
  docs/CASE_STUDY.md        the showcase write-up: decisions, guardrails, what AI does and doesn't do
```

**Tables:** `jobs`, `application_answers`, `status_history`, `profile_facts` (fields: verified, source, history), `coach_sessions`, `coach_turns` (fields: question, answer, critique JSON, follow-up, improved answer, timestamps), `ai_usage`. Signups are disabled in Supabase Auth. Sign-in is by magic link to one allowlisted email.

**Coach turn flow:** the browser sends `{session_id, action, answer}` with the user's JWT. The server loads the role and the verified evidence through RLS, checks the state machine, calls the adapter, validates the output schema, runs the guard, saves the turn, and returns the result. Before the first call, the app shows a one-time disclosure of exactly what gets sent to Anthropic.

**Model:** a Claude Sonnet-class model, with an environment variable to switch models. Pricing gets checked against Anthropic's current page during Phase 4. The cap is enforced in two places: the Anthropic Console spend limit and the app's own `ai_usage` budget.

## Phases (each ends with something Karen can see and verify)

- **Phase 0, quick track (now, in chat):** a live mock interview in chat for an upcoming interview, using only verified evidence. No code.
- **Phase 1, repo and local app (GitHub only):** create the repo and port the mockup into `public/`. Build a fictional demo candidate fixture. Run a local preview. Set up `.gitignore` for env files and exports.
- **Phase 2, Supabase:** guided account setup, then migrations, RLS, and magic-link auth. Then the import script, run against a backup of `jobs.db`. Then an RLS test: an anonymous request, and a request signed in as a second user, must both see zero rows.
- **Phase 3, Vercel:** connect the repo and set env vars in the Vercel dashboard (never in chat). Set up a protected preview deployment and wire `jobs.js` and `profile.js` to it.
- **Phase 4, live coach:** the adapter, the Claude implementation, the state machine, prompts, the guard, limits, and export and delete. Pass the evals.
- **Phase 5, dashboard and profile:** real data, profile editing with the unverified flag, confirm and undo, then `pull_profile.py`.
- **Phase 6, release readiness:** security audit (secret scan of the git history, no keys in the bundle, RLS, injection evals), mobile check, recorded demo session, README and case study. Make the repo public **only on Karen's explicit go-ahead.**

## Secrets Karen will configure herself (never pasted in chat)

`ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `ALLOWED_EMAIL`. These go in the Vercel env vars. `SUPABASE_SERVICE_ROLE_KEY` goes **only** in a local `.env`, for the import and pull scripts, and never into Vercel.

## Verification

- `npm test`: state-machine tests (calling "next question" before the follow-up is answered returns 409), guard tests, limit tests.
- `npm run eval`: an injection JD can't change the coach's role. Fabrication bait produces no invented metrics. Every response has exactly one question.
- RLS check script returns zero rows for anonymous users and for a second user.
- `grep` of the built bundle and the full git history finds no keys.
- In the preview: sign in, open an interviewing application, do 2 main questions plus follow-ups, reload, resume, export, delete. Check at 375px and on desktop.

## Not doing without explicit go-ahead

Pushing, deploying, making the repo public, upgrading to paid plans, or contacting employers.
