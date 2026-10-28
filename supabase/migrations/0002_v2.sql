-- Career Studio schema v2 (Stage A).
-- Run once in the Supabase SQL editor, after 0001_init.sql.
--
-- Adds: new application statuses and review fields, job preferences,
-- fact kinds, documents with a sent-lock, a private Storage bucket, automatic
-- status history, and an insert-only AI usage recorder.

-- Jobs ---------------------------------------------------------------------

alter table jobs drop constraint if exists jobs_status_check;
alter table jobs add constraint jobs_status_check check (status in
    ('IN_PROGRESS','APPLIED','EMAILED','INTERVIEWING','INTERVIEW_DONE','OFFER','EMPLOYER_REJECTED'));

alter table jobs
    add column source_url     text,
    add column fit_breakdown  jsonb,          -- {core, shape, domain, scope, tools, quals: 0-4, reasons}
    add column pref_match     jsonb,          -- [{status: ok|warn|no, text}]
    add column posting_facts  jsonb;          -- {salary_min, salary_max, arrangement, location, industry, level}

-- Every status change (and the first status) lands in status_history.
create function log_job_status() returns trigger
language plpgsql set search_path = '' as $$
begin
    if tg_op = 'INSERT' or new.status is distinct from old.status then
        insert into public.status_history (user_id, job_id, status)
        values (new.user_id, new.id, new.status);
    end if;
    return new;
end $$;

create trigger jobs_status_log after insert or update of status on jobs
    for each row execute function log_job_status();

-- Application answers --------------------------------------------------------

alter table application_answers
    add column final       boolean not null default false,
    add column updated_at  timestamptz not null default now();
update application_answers set final = true;   -- everything imported so far was submitted

create trigger application_answers_touch before update on application_answers
    for each row execute function touch_updated_at();

-- Profile ------------------------------------------------------------------

alter table profile_facts
    add column kind text not null default 'skill'
        check (kind in ('skill','result','education','role','summary'));
alter table profile_facts drop constraint if exists profile_facts_source_check;
alter table profile_facts add constraint profile_facts_source_check
    check (source in ('import','app','coach','upload'));

-- One row of job preferences per user. Used only for the preference match;
-- never sent to employers.
create table profile_prefs (
    user_id               uuid primary key default auth.uid() references auth.users on delete cascade,
    target_titles         text,
    level                 text,
    salary_min            integer check (salary_min >= 0),
    salary_target         integer check (salary_target >= 0),
    employment_type       text,
    arrangement           text,
    location              text,
    industries_preferred  text,
    industries_avoid      text,
    company_size          text,
    travel                text,
    needs_sponsorship     boolean,
    earliest_start        text,
    must_haves            text,
    updated_at            timestamptz not null default now()
);
create trigger profile_prefs_touch before update on profile_prefs
    for each row execute function touch_updated_at();

-- Documents ----------------------------------------------------------------
-- Resumes and cover letters, uploaded or generated. Once marked sent, a
-- document is frozen: editing makes a copy (parent_id) instead.

create table documents (
    id          bigint generated always as identity primary key,
    user_id     uuid not null default auth.uid() references auth.users on delete cascade,
    job_id      bigint references jobs on delete set null,
    parent_id   bigint references documents on delete set null,
    kind        text not null check (kind in ('resume','letter')),
    source      text not null check (source in ('uploaded','generated','built')),
    title       text not null,
    content     jsonb,                 -- structured resume/letter content for the editor
    file_path   text,                  -- object path in the private docs bucket
    file_name   text,
    sent        boolean not null default false,
    sent_at     timestamptz,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);
create index documents_user on documents (user_id, created_at desc);
create index documents_job on documents (job_id);

create function lock_sent_document() returns trigger
language plpgsql set search_path = '' as $$
begin
    if tg_op = 'DELETE' then
        -- Local maintenance scripts (service role) may clean up; nobody else.
        if old.sent and current_user <> 'service_role' then
            raise exception 'Sent documents cannot be deleted.';
        end if;
        return old;
    end if;
    if old.sent and (new.sent is distinct from old.sent
                     or new.content is distinct from old.content
                     or new.file_path is distinct from old.file_path
                     or new.title is distinct from old.title) then
        raise exception 'Sent documents are locked. Make a copy to edit.';
    end if;
    if new.sent and not old.sent then new.sent_at = now(); end if;
    new.updated_at = now();
    return new;
end $$;

create trigger documents_lock before update or delete on documents
    for each row execute function lock_sent_document();

-- AI usage: insert-only recorder ---------------------------------------------
-- The browser-facing API runs as the signed-in user, who can read but not
-- write ai_usage directly. This function can only add rows, so the monthly
-- budget can never be lowered or reset.

create function record_ai_usage(p_model text, p_input integer, p_output integer, p_cost numeric)
returns void
language plpgsql security definer set search_path = '' as $$
begin
    if auth.uid() is null then raise exception 'Sign in required.'; end if;
    if p_input < 0 or p_output < 0 or p_cost < 0 then raise exception 'Invalid usage.'; end if;
    insert into public.ai_usage (user_id, model, input_tokens, output_tokens, cost_usd)
    values (auth.uid(), left(p_model, 80), p_input, p_output, p_cost);
end $$;
revoke all on function record_ai_usage(text, integer, integer, numeric) from public, anon;
grant execute on function record_ai_usage(text, integer, integer, numeric) to authenticated;

-- Row-level security and grants ---------------------------------------------

alter table profile_prefs enable row level security;
alter table documents     enable row level security;

create policy owner_all on profile_prefs for all to authenticated
    using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy owner_all on documents for all to authenticated
    using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

revoke all on profile_prefs, documents from anon;
grant select, insert, update, delete on profile_prefs, documents to authenticated;
grant all on profile_prefs, documents to service_role;

-- Private Storage bucket -----------------------------------------------------
-- Files live under <user id>/..., and each user can reach only their folder.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('docs', 'docs', false, 10485760,
        array['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict (id) do nothing;

create policy docs_owner_read on storage.objects for select to authenticated
    using (bucket_id = 'docs' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy docs_owner_insert on storage.objects for insert to authenticated
    with check (bucket_id = 'docs' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy docs_owner_delete on storage.objects for delete to authenticated
    using (bucket_id = 'docs' and (storage.foldername(name))[1] = (select auth.uid())::text);
