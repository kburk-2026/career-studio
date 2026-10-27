-- Career Studio schema, Phase 2.
-- Run once in the Supabase SQL editor (or `supabase db push`).
--
-- Every table carries user_id and has row-level security on, with policies
-- limited to the signed-in owner (user_id = auth.uid()). The browser only ever
-- uses the anon key plus the user's own session token, so RLS always applies.
-- The service-role key (which bypasses RLS) is used only by local scripts.

-- Applications -------------------------------------------------------------

create table jobs (
    id                bigint generated always as identity primary key,
    user_id           uuid not null default auth.uid() references auth.users on delete cascade,
    source_id         bigint,                 -- row id in the local JobHuntAgent tracker
    company           text not null,
    role_title        text not null,
    location          text,
    url               text,
    jd_text           text,
    status            text not null default 'APPLIED'
                      check (status in ('APPLIED','EMAILED','INTERVIEWING','OFFER','EMPLOYER_REJECTED')),
    applied_on        date,
    fit_score         smallint check (fit_score between 0 and 100),
    odds_score        smallint check (odds_score between 0 and 100),
    strengths         jsonb not null default '[]',
    gaps              jsonb not null default '[]',
    resume_file       text,                   -- file name only, never a local path
    cover_letter_file text,
    notes             text,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now(),
    unique (user_id, source_id)
);
create index jobs_user_status on jobs (user_id, status);

-- Final submitted answers to application-form questions.
create table application_answers (
    id          bigint generated always as identity primary key,
    user_id     uuid not null default auth.uid() references auth.users on delete cascade,
    job_id      bigint not null references jobs on delete cascade,
    position    smallint not null default 0,
    question    text not null,
    answer      text not null,
    char_limit  integer,
    created_at  timestamptz not null default now()
);
create index application_answers_job on application_answers (job_id);

create table status_history (
    id          bigint generated always as identity primary key,
    user_id     uuid not null default auth.uid() references auth.users on delete cascade,
    job_id      bigint not null references jobs on delete cascade,
    status      text not null,
    changed_at  timestamptz not null default now()
);
create index status_history_job on status_history (job_id);

-- Skills profile -----------------------------------------------------------
-- Edits made in the app start unverified. Only confirmed facts are used as
-- coach evidence or pulled back into JobHuntAgent's verified_facts.md.

create table profile_facts (
    id           bigint generated always as identity primary key,
    user_id      uuid not null default auth.uid() references auth.users on delete cascade,
    group_title  text not null,
    position     smallint not null default 0,
    text         text not null,
    verified     boolean not null default false,
    source       text not null default 'app'
                 check (source in ('import','app','coach')),
    history      jsonb not null default '[]',  -- prior {text, verified, at} versions, for undo
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);
create index profile_facts_user on profile_facts (user_id, group_title, position);

-- Interview coach (used from Phase 4) --------------------------------------

create table coach_sessions (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid not null default auth.uid() references auth.users on delete cascade,
    job_id      bigint not null references jobs on delete cascade,
    state       text not null default 'ASK_MAIN'
                check (state in ('ASK_MAIN','AWAIT_ANSWER','FOLLOWUP','AWAIT_FOLLOWUP','DONE')),
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

create table coach_turns (
    id               bigint generated always as identity primary key,
    user_id          uuid not null default auth.uid() references auth.users on delete cascade,
    session_id       uuid not null references coach_sessions on delete cascade,
    position         smallint not null,
    kind             text not null check (kind in ('main','followup')),
    question         text not null,
    answer           text,
    critique         jsonb,
    improved_answer  text,
    guard_flags      jsonb not null default '[]',
    created_at       timestamptz not null default now(),
    answered_at      timestamptz,
    unique (session_id, position)
);

-- AI spend tracking. Written only by the server (service role) in Phase 4;
-- the owner can read their own rows.
create table ai_usage (
    id             bigint generated always as identity primary key,
    user_id        uuid not null references auth.users on delete cascade,
    model          text not null,
    input_tokens   integer not null,
    output_tokens  integer not null,
    cost_usd       numeric(10,6) not null,
    created_at     timestamptz not null default now()
);
create index ai_usage_user_time on ai_usage (user_id, created_at);

-- updated_at ---------------------------------------------------------------

create function touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
    new.updated_at = now();
    return new;
end $$;

create trigger jobs_touch before update on jobs
    for each row execute function touch_updated_at();
create trigger profile_facts_touch before update on profile_facts
    for each row execute function touch_updated_at();
create trigger coach_sessions_touch before update on coach_sessions
    for each row execute function touch_updated_at();

-- Row-level security -------------------------------------------------------

alter table jobs                enable row level security;
alter table application_answers enable row level security;
alter table status_history      enable row level security;
alter table profile_facts       enable row level security;
alter table coach_sessions      enable row level security;
alter table coach_turns         enable row level security;
alter table ai_usage            enable row level security;

-- Owner-only read/write on the user-editable tables.
do $$
declare t text;
begin
    foreach t in array array['jobs','application_answers','status_history',
                             'profile_facts','coach_sessions','coach_turns']
    loop
        execute format(
            'create policy owner_all on %I for all to authenticated
                 using (user_id = (select auth.uid()))
                 with check (user_id = (select auth.uid()))', t);
    end loop;
end $$;

-- ai_usage: owner may read, never write (so the budget can't be reset from the browser).
create policy owner_read on ai_usage for select to authenticated
    using (user_id = (select auth.uid()));

-- Table privileges are granted explicitly (the project has "automatically
-- expose new tables" off). RLS above still limits every row to its owner.
-- Nothing at all for anonymous visitors.
revoke all on all tables in schema public from anon;
grant select, insert, update, delete on
    jobs, application_answers, status_history,
    profile_facts, coach_sessions, coach_turns
    to authenticated;
grant select on ai_usage to authenticated;
-- Local scripts and (in Phase 4) the server's usage writer.
grant all on all tables in schema public to service_role;
