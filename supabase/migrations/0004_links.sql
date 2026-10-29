-- Profile links and presentations/publications (run once in the Supabase SQL
-- editor, after 0003_coach.sql).

-- Links shown on generated resumes and cover letters.
alter table profile_prefs
    add column linkedin_url   text check (linkedin_url  is null or linkedin_url  ~ '^https://'),
    add column portfolio_url  text check (portfolio_url is null or portfolio_url ~ '^https://'),
    add column website_url    text check (website_url   is null or website_url   ~ '^https://');

-- Presentations and publications are profile facts with an optional link.
alter table profile_facts drop constraint if exists profile_facts_kind_check;
alter table profile_facts add constraint profile_facts_kind_check
    check (kind in ('skill','result','education','role','summary','publication'));
alter table profile_facts
    add column url text check (url is null or url ~ '^https://');
