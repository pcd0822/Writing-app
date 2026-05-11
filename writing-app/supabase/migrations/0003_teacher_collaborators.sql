-- ─────────────────────────────────────────────────────────────────────────
-- Co-teacher invitations.
--
-- A teacher (owner) can grant another teacher (collaborator) full access to
-- their workspace via:
--   * email: pre-fills collaborator_email; matched on collaborator login.
--   * link : pre-fills invite_token; matched on the invite landing page.
--
-- Single-workspace invariant (v1): a teacher can be an accepted collaborator
-- on AT MOST one owner. Enforced by a partial UNIQUE INDEX below. While
-- they're a collaborator, their own Supabase rows stay untouched but become
-- inaccessible via supabase-db-get (which resolves to owner_uid).
--
-- Status machine:
--   pending  → accepted   (collaborator side, on accept-by-token or
--                          accept-by-email auto-claim)
--   pending  → revoked    (owner side, before acceptance)
--   accepted → revoked    (owner side, after acceptance — collab loses access)
--   accepted → revoked    (collaborator side, "leave workspace")
--
-- We keep revoked rows for audit and to prevent token replay; a re-invite
-- always creates a new row.
-- ─────────────────────────────────────────────────────────────────────────

set search_path = public;

create table teacher_collaborators (
  id                 text primary key,
  owner_uid          text not null,
  -- Filled when an invite is accepted. NULL while pending.
  collaborator_uid   text,
  -- Lowercase email. Required for email-based invite, also captured for
  -- audit on token-based invite once accepted.
  collaborator_email text,
  -- Random URL-safe token. NULL for email-only invites. UNIQUE so the
  -- accept endpoint can look the row up by token alone.
  invite_token       text unique,
  status             text not null check (status in ('pending','accepted','revoked')),
  created_at         bigint not null,
  accepted_at        bigint,
  revoked_at         bigint,
  -- Optional expiry for invite links; NULL = no expiry. Email-based invites
  -- can also carry an expiry. Past-due rows are rejected at accept time.
  expires_at         bigint,
  -- A collaborator can never own a workspace where they're already a member
  -- and vice-versa; enforced in the helper layer, not at the DB level.
  check (collaborator_uid is null or owner_uid <> collaborator_uid)
);

create index teacher_collab_owner_idx
  on teacher_collaborators(owner_uid);

create index teacher_collab_uid_idx
  on teacher_collaborators(collaborator_uid)
  where collaborator_uid is not null;

create index teacher_collab_email_idx
  on teacher_collaborators(lower(collaborator_email))
  where collaborator_email is not null and status = 'pending';

-- Single-workspace invariant: a teacher has at most one ACCEPTED row.
-- Revoked rows can pile up; pending rows are not unique (you can have
-- pending invites from multiple owners, but you can only accept one).
create unique index teacher_collab_one_accepted_per_uid
  on teacher_collaborators(collaborator_uid)
  where status = 'accepted';

-- Prevent duplicate pending invites for the same (owner, email).
create unique index teacher_collab_pending_email_unique
  on teacher_collaborators(owner_uid, lower(collaborator_email))
  where status = 'pending' and collaborator_email is not null;

-- RLS: same model as the other tables — enable but no policies. Only the
-- service_role (Netlify functions with verified Firebase tokens) reads/writes.
-- 0002's `revoke all on all tables` only ran against tables existing at that
-- migration's time, so this new table needs its own explicit revoke.
alter table teacher_collaborators enable row level security;
revoke all on table teacher_collaborators from anon, authenticated;
