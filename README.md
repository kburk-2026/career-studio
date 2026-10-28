# Career Studio

A private job-search dashboard with an evidence-grounded AI interview coach.

It tracks submitted applications (status, fit, exact documents sent, and the
answers given on application forms), keeps a verified skills profile, and runs
mock interviews one question at a time. The coach critiques each answer, asks
one realistic follow-up, and models a stronger answer using **only verified
facts**.

The guardrails are code, not just prompt wording:

- **One question at a time** is enforced by a server-side state machine, not
  left to the model.
- **No invented numbers.** Any figure in an AI-written answer must appear in
  the verified evidence bank, or it gets flagged.
- **Unverified claims stay labeled** until the owner confirms them.
- **Private by default.** Real records sit behind sign-in with row-level
  security. The public demo uses a fictional candidate, and a privacy check
  blocks real names, contact details, and keys from being committed.

## Status

| Phase | What | State |
|---|---|---|
| 1 | Repo, app shell, fictional demo, privacy guard | **Done** |
| 2 | Supabase: schema, row-level security, sign-in | **Done** |
| 3 | Vercel: hosting and authenticated API | **In progress** (sign-in + API built) |
| 4 | Live AI coach (Claude, behind a provider adapter) | Planned |
| 5 | Real dashboard data and profile editing | Planned |
| 6 | Security audit, demo recording, case study | Planned |

The full plan is in [docs/PLAN.md](docs/PLAN.md).

## Run it locally

Requires Node 20+. There are no dependencies to install.

```bash
npm run dev      # preview at http://localhost:4173
npm test         # unit and fixture tests
npm run check    # privacy guard: secrets, contact details, private names
npm run check:rls  # live row-level security test (needs a local .env; see .env.example)
```

## How it's built

- `public/`: a static app in plain HTML, CSS, and JavaScript with no build step.
  - `js/data.js` is the only part that knows where data comes from. Today it reads the fictional demo; in Phase 3 it switches to the authenticated API.
  - `js/format.js` holds pure helpers, covered by tests.
- `public/demo/`: the fictional candidate and employers. Every file is marked `"fictional": true`, and the privacy check enforces it.
- `scripts/check_privacy.mjs` scans every file git would publish.
- `docs/PLAN.md` is the approved build plan.

Built with Claude Code.
