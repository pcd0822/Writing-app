-- ─────────────────────────────────────────────────────────────────────────
-- Writing-app RLS policies
--
-- Strategy: every table has RLS enabled and NO policies.
--   * anon and authenticated roles → denied by default (no row visible)
--   * service_role bypasses RLS entirely → all access goes through
--     Netlify Functions, which hold the service_role key server-side and
--     verify the caller (Firebase ID token for teachers; shareToken +
--     studentNo + studentCode for students) before any DB call.
--
-- This means the SUPABASE_ANON_KEY can be embedded in client code without
-- granting any data access — the client cannot reach Supabase directly
-- and never needs to. The anon key is kept in env only for symmetry and
-- in case a future read-only client path is added behind explicit policies.
--
-- If we later introduce client-direct access (e.g. realtime subscriptions
-- on teacher_comments), add narrow ALLOW policies in a follow-up migration.
-- ─────────────────────────────────────────────────────────────────────────

alter table classes                 enable row level security;
alter table students                enable row level security;
alter table assignments             enable row level security;
alter table assignment_allocations  enable row level security;
alter table share_links             enable row level security;
alter table submissions             enable row level security;
alter table feedback_notes          enable row level security;
alter table ai_logs                 enable row level security;
alter table scores                  enable row level security;
alter table step_transitions        enable row level security;
alter table ai_interactions         enable row level security;
alter table teacher_comments        enable row level security;
alter table tombstones              enable row level security;

-- Belt-and-braces: explicitly revoke from anon/authenticated. RLS already
-- blocks reads/writes, but revoking grants prevents schema introspection
-- (e.g. listing column names via PostgREST OPTIONS) too.
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
