-- Standing feedback for the resume and cover letter writer (run once in the
-- Supabase SQL editor, after 0004_links.sql).
alter table profile_prefs
    add column writer_notes text check (char_length(writer_notes) <= 4000);
