-- Interview coach (run once in the Supabase SQL editor, after 0002_v2.sql).
-- Stores each session's prep (hiring priorities, likely concern, STAR stories)
-- and how many main questions have been asked.

alter table coach_sessions
    add column prep        jsonb,
    add column main_count  smallint not null default 0;

create index coach_sessions_job on coach_sessions (job_id, created_at desc);
create index coach_turns_session on coach_turns (session_id, position);
