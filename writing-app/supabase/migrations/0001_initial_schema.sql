-- ─────────────────────────────────────────────────────────────────────────
-- Writing-app Supabase initial schema
--
-- Design notes:
-- * Timestamps are epoch milliseconds (BIGINT) to match the existing zod
--   schema (z.number().int()) without conversion on either side.
-- * Teacher identity is the Firebase Auth UID (TEXT). We do NOT use
--   Supabase Auth — Netlify Functions verify the Firebase ID token and
--   write/read using the service_role key. RLS is enabled on every table
--   and no policies are added (see 0002_rls_policies.sql), so anon and
--   authenticated roles cannot reach any row. service_role bypasses RLS.
-- * Entity IDs (classes/assignments/submissions/...) are the same nanoid
--   strings already in use, so an idempotent upsert from sheet → Supabase
--   is straightforward in the migration script.
-- * Foreign keys cascade on delete. Tombstones are kept as a table for
--   compatibility but are unused once a class is the single source of
--   truth (Supabase). Phase 3 client code will stop writing to it.
-- ─────────────────────────────────────────────────────────────────────────

set search_path = public;

-- ── classes ──────────────────────────────────────────────────────────────
create table classes (
  id          text primary key,
  teacher_uid text not null,
  name        text not null,
  created_at  bigint not null
);
create index classes_teacher_idx on classes(teacher_uid);

-- ── students (one row per student per class) ─────────────────────────────
create table students (
  id           bigserial primary key,
  class_id     text not null references classes(id) on delete cascade,
  student_no   text not null,
  student_code text not null check (student_code ~ '^[A-Za-z0-9]{8}$'),
  created_at   bigint not null,
  unique (class_id, student_no)
);
create index students_class_idx on students(class_id);

-- ── assignments ──────────────────────────────────────────────────────────
create table assignments (
  id          text primary key,
  teacher_uid text not null,
  title       text not null,
  prompt      text not null,
  task        text not null,
  -- Attachment[] — { name, type?, size?, dataUrl?, driveFileId?, driveDownloadUrl? }
  attachments jsonb not null default '[]'::jsonb,
  -- AssignmentCriteria | null — { outline, draft, revise } each with minChars/minParagraphs
  criteria    jsonb,
  created_at  bigint not null
);
create index assignments_teacher_idx on assignments(teacher_uid);

-- ── assignment_allocations ───────────────────────────────────────────────
-- One row per (assignment, class[, student]) target. The discriminated
-- union from AssignmentTargetSchema is encoded as target_type + nullable
-- student_no. The unique constraint uses coalesce(student_no, '') so
-- (assignment, class) class-level allocation is distinct from
-- (assignment, class, studentNo) student-level allocations.
create table assignment_allocations (
  id            bigserial primary key,
  assignment_id text not null references assignments(id) on delete cascade,
  target_type   text not null check (target_type in ('class', 'student')),
  class_id      text not null references classes(id) on delete cascade,
  student_no    text,
  check (
    (target_type = 'class'   and student_no is null) or
    (target_type = 'student' and student_no is not null)
  )
);
create index alloc_assignment_idx on assignment_allocations(assignment_id);
create index alloc_class_idx      on assignment_allocations(class_id);
-- Expression-based uniqueness must live in a UNIQUE INDEX, not a UNIQUE
-- constraint. coalesce(student_no, '') makes a class-level allocation
-- (student_no IS NULL) distinct from any student-level row.
create unique index alloc_unique_target_idx
  on assignment_allocations (assignment_id, class_id, coalesce(student_no, ''));

-- ── share_links ──────────────────────────────────────────────────────────
create table share_links (
  token          text primary key,
  teacher_uid    text not null,
  assignment_id  text not null references assignments(id) on delete cascade,
  created_at     bigint not null,
  expires_at     bigint not null,
  revoked_at     bigint,
  -- Optional: the spreadsheet ID used for the manual sheet-export backup.
  spreadsheet_id text
);
create index share_links_assignment_idx on share_links(assignment_id);
create index share_links_teacher_idx    on share_links(teacher_uid);

-- ── submissions ──────────────────────────────────────────────────────────
-- Exactly one submission per (assignment, class, student_no). All long
-- text fields live in this row directly — Postgres TEXT has no 50 KB cell
-- limit so the meta/chunk split that sheet sync needed is gone.
create table submissions (
  id                         text primary key,
  assignment_id              text not null references assignments(id) on delete cascade,
  class_id                   text not null references classes(id)     on delete cascade,
  student_no                 text not null,
  created_at                 bigint not null,
  updated_at                 bigint not null,
  outline_text               text not null default '',
  draft_text                 text not null default '',
  revise_text                text not null default '',
  outline_submitted_at       bigint,
  draft_submitted_at         bigint,
  revise_submitted_at        bigint,
  outline_approved_at        bigint,
  draft_approved_at          bigint,
  revise_approved_at         bigint,
  final_approved_at          bigint,
  final_report_published_at  bigint,
  final_report_snapshot      text not null default '',
  -- GRASP context (JSON-serialised string in the existing schema).
  grasp_data                 text not null default '',
  outline_reject_reason      text not null default '',
  draft_reject_reason        text not null default '',
  revise_reject_reason       text not null default '',
  -- 0=grasp pending, 1=outline, 2=draft, 3=revise
  current_step               int  not null default 1,
  unique (assignment_id, class_id, student_no)
);
create index submissions_assignment_idx on submissions(assignment_id);
create index submissions_class_idx      on submissions(class_id);
create index submissions_student_idx    on submissions(class_id, student_no);
create index submissions_updated_idx    on submissions(updated_at);

-- ── feedback_notes ───────────────────────────────────────────────────────
-- start/end are the character offsets the teacher selected when leaving
-- the note. Renamed to start_pos/end_pos because START/END are reserved.
create table feedback_notes (
  id            text primary key,
  submission_id text not null references submissions(id) on delete cascade,
  stage         text not null check (stage in ('outline','draft','revise')),
  created_at    bigint not null,
  teacher_text  text not null,
  anchor_text   text not null,
  start_pos     int  not null check (start_pos >= 0),
  end_pos       int  not null check (end_pos   >= 0),
  resolved_at   bigint
);
create index feedback_notes_submission_idx on feedback_notes(submission_id);

-- ── ai_logs ──────────────────────────────────────────────────────────────
create table ai_logs (
  id            text primary key,
  submission_id text not null references submissions(id) on delete cascade,
  stage         text not null check (stage in ('outline','draft','revise')),
  created_at    bigint not null,
  role          text not null check (role in ('student','assistant')),
  text          text not null
);
create index ai_logs_submission_idx on ai_logs(submission_id);

-- ── scores (one row per submission) ──────────────────────────────────────
create table scores (
  submission_id   text primary key references submissions(id) on delete cascade,
  created_at      bigint not null,
  teacher_summary text not null default '',
  score           int,
  outline_score   int,
  draft_score     int,
  revise_score    int,
  is_finalized    boolean not null default false
);

-- ── step_transitions ─────────────────────────────────────────────────────
-- "ts" rather than "timestamp" since the latter is a reserved keyword.
create table step_transitions (
  id            text primary key,
  submission_id text not null references submissions(id) on delete cascade,
  student_no    text not null,
  from_step     int  not null,
  to_step       int  not null,
  ts            bigint not null,
  reason        text not null check (reason in ('initial_progress','revision_back','revision_forward'))
);
create index step_transitions_submission_idx on step_transitions(submission_id);

-- ── ai_interactions ──────────────────────────────────────────────────────
create table ai_interactions (
  id            text primary key,
  submission_id text not null references submissions(id) on delete cascade,
  ts            bigint not null,
  step          int not null,
  type          text not null check (type in ('continue','rephrase','argument','audience','structure','tutor')),
  prompt        text not null default '',
  response      text not null default '',
  action        text not null default 'rejected' check (action in ('accepted','modified','rejected'))
);
create index ai_interactions_submission_idx on ai_interactions(submission_id);

-- ── teacher_comments ─────────────────────────────────────────────────────
create table teacher_comments (
  id            text primary key,
  submission_id text not null references submissions(id) on delete cascade,
  stage         text not null check (stage in ('outline','draft','revise')),
  created_at    bigint not null,
  text          text not null,
  read_at       bigint
);
create index teacher_comments_submission_idx on teacher_comments(submission_id);

-- ── tombstones ───────────────────────────────────────────────────────────
-- Kept for migration compatibility. Phase 3 client code stops writing
-- here once Supabase becomes the single source of truth.
create table tombstones (
  teacher_uid text   not null,
  kind        text   not null check (kind in ('class','assignment','submission')),
  entity_id   text   not null,
  deleted_at  bigint not null,
  primary key (teacher_uid, kind, entity_id)
);
