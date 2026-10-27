# Career Studio: working rules

- **No real personal data in the repo.** `public/demo/` is fictional only, and every file there carries `"fictional": true`. Real records live in Supabase behind sign-in (Phase 2 on).
- Run `npm test` and `npm run check` before every commit. Not PASS means not finished.
- Secrets go in host environment variables or a local `.env`, never in code, chat, or git. The Supabase service-role key never goes to Vercel.
- The coach never invents metrics, credentials, or shipped capabilities. Prototypes stay labeled as prototypes.
- Rules the code enforces stay in code (state machine, numeric guard, RLS), not just in prompts.
- Plain HTML/CSS/JS with no build step. Keep the UI talking to `public/js/data.js` only.
- Don't push, deploy, make the repo public, or upgrade a paid plan without the owner's explicit go-ahead.
- Plan and phase status: `docs/PLAN.md` and the README table.
