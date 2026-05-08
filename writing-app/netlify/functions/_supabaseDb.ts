import type {
  AiInteraction,
  AiLog,
  Assignment,
  AssignmentAllocation,
  ClassRoom,
  FeedbackNote,
  Score,
  ShareLink,
  StepTransition,
  Submission,
  TeacherComment,
  TeacherDb,
  Tombstone,
} from "../../src/lib/types";
import { getSupabaseAdmin } from "./_supabase";

// ─────────────────────────────────────────────────────────────────────────
// TeacherDb ↔ Postgres row mapping for the writing-app Supabase tables.
//
// Conventions:
// * snake_case in Postgres ↔ camelCase in TS. Mapping is local to this file
//   so the rest of the codebase keeps using the existing zod types.
// * Timestamps stay as epoch ms (BIGINT). PostgREST returns BIGINT as a
//   JavaScript number when it fits in a safe integer (it always does for
//   our timestamps until 2255 AD), so no conversion is needed.
// * Empty/optional text fields default to "" so the parsed shape matches
//   the zod defaults in src/lib/types.ts.
// * Read assembles a TeacherDb for a given teacher_uid by listing their
//   classes/assignments/share_links/tombstones directly, then fetching
//   children via the discovered IDs (IN (...) queries). Write upserts
//   every entity. Hard delete is NOT performed by writeTeacherDbForUser —
//   call the dedicated delete helpers when removing entities.
// ─────────────────────────────────────────────────────────────────────────

type SupaClassRow = {
  id: string;
  teacher_uid: string;
  name: string;
  created_at: number;
};
type SupaStudentRow = {
  class_id: string;
  student_no: string;
  student_code: string;
  created_at: number;
};
type SupaAssignmentRow = {
  id: string;
  teacher_uid: string;
  title: string;
  prompt: string;
  task: string;
  attachments: unknown;
  criteria: unknown;
  created_at: number;
};
type SupaAllocationRow = {
  assignment_id: string;
  target_type: "class" | "student";
  class_id: string;
  student_no: string | null;
};
type SupaShareLinkRow = {
  token: string;
  teacher_uid: string;
  assignment_id: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  spreadsheet_id: string | null;
};
type SupaSubmissionRow = {
  id: string;
  assignment_id: string;
  class_id: string;
  student_no: string;
  created_at: number;
  updated_at: number;
  outline_text: string;
  draft_text: string;
  revise_text: string;
  outline_submitted_at: number | null;
  draft_submitted_at: number | null;
  revise_submitted_at: number | null;
  outline_approved_at: number | null;
  draft_approved_at: number | null;
  revise_approved_at: number | null;
  final_approved_at: number | null;
  final_report_published_at: number | null;
  final_report_snapshot: string;
  grasp_data: string;
  outline_reject_reason: string;
  draft_reject_reason: string;
  revise_reject_reason: string;
  current_step: number;
};
type SupaFeedbackNoteRow = {
  id: string;
  submission_id: string;
  stage: "outline" | "draft" | "revise";
  created_at: number;
  teacher_text: string;
  anchor_text: string;
  start_pos: number;
  end_pos: number;
  resolved_at: number | null;
};
type SupaAiLogRow = {
  id: string;
  submission_id: string;
  stage: "outline" | "draft" | "revise";
  created_at: number;
  role: "student" | "assistant";
  text: string;
};
type SupaScoreRow = {
  submission_id: string;
  created_at: number;
  teacher_summary: string;
  score: number | null;
  outline_score: number | null;
  draft_score: number | null;
  revise_score: number | null;
  is_finalized: boolean;
};
type SupaStepTransitionRow = {
  id: string;
  submission_id: string;
  student_no: string;
  from_step: number;
  to_step: number;
  ts: number;
  reason: "initial_progress" | "revision_back" | "revision_forward";
};
type SupaAiInteractionRow = {
  id: string;
  submission_id: string;
  ts: number;
  step: number;
  type: "continue" | "rephrase" | "argument" | "audience" | "structure" | "tutor";
  prompt: string;
  response: string;
  action: "accepted" | "modified" | "rejected";
};
type SupaTeacherCommentRow = {
  id: string;
  submission_id: string;
  stage: "outline" | "draft" | "revise";
  created_at: number;
  text: string;
  read_at: number | null;
};
type SupaTombstoneRow = {
  teacher_uid: string;
  kind: "class" | "assignment" | "submission";
  entity_id: string;
  deleted_at: number;
};

// ── Row → domain ─────────────────────────────────────────────────────────

function rowToClass(c: SupaClassRow, students: SupaStudentRow[]): ClassRoom {
  return {
    id: c.id,
    name: c.name,
    createdAt: c.created_at,
    students: students.map((s) => ({
      studentNo: s.student_no,
      studentCode: s.student_code,
    })),
  };
}

function rowToAssignment(a: SupaAssignmentRow): Assignment {
  return {
    id: a.id,
    title: a.title,
    prompt: a.prompt,
    task: a.task,
    attachments: Array.isArray(a.attachments) ? (a.attachments as Assignment["attachments"]) : [],
    createdAt: a.created_at,
    criteria: (a.criteria ?? undefined) as Assignment["criteria"],
  };
}

function allocationsFromRows(rows: SupaAllocationRow[]): AssignmentAllocation[] {
  // Group by assignment_id. Each group's rows become the targets[] array.
  const byAssignment = new Map<string, AssignmentAllocation>();
  for (const r of rows) {
    let entry = byAssignment.get(r.assignment_id);
    if (!entry) {
      entry = { assignmentId: r.assignment_id, targets: [] };
      byAssignment.set(r.assignment_id, entry);
    }
    if (r.target_type === "class") {
      entry.targets.push({ type: "class", classId: r.class_id });
    } else {
      entry.targets.push({
        type: "student",
        classId: r.class_id,
        studentNo: r.student_no ?? "",
      });
    }
  }
  return Array.from(byAssignment.values());
}

function rowToShareLink(s: SupaShareLinkRow): ShareLink {
  return {
    token: s.token,
    assignmentId: s.assignment_id,
    createdAt: s.created_at,
    expiresAt: s.expires_at,
    revokedAt: s.revoked_at,
    spreadsheetId: s.spreadsheet_id ?? undefined,
  };
}

function rowToSubmission(s: SupaSubmissionRow): Submission {
  return {
    id: s.id,
    assignmentId: s.assignment_id,
    classId: s.class_id,
    studentNo: s.student_no,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    outlineText: s.outline_text,
    draftText: s.draft_text,
    reviseText: s.revise_text,
    outlineSubmittedAt: s.outline_submitted_at,
    draftSubmittedAt: s.draft_submitted_at,
    reviseSubmittedAt: s.revise_submitted_at,
    outlineApprovedAt: s.outline_approved_at,
    draftApprovedAt: s.draft_approved_at,
    reviseApprovedAt: s.revise_approved_at,
    finalApprovedAt: s.final_approved_at,
    finalReportPublishedAt: s.final_report_published_at,
    finalReportSnapshot: s.final_report_snapshot,
    graspData: s.grasp_data,
    outlineRejectReason: s.outline_reject_reason,
    draftRejectReason: s.draft_reject_reason,
    reviseRejectReason: s.revise_reject_reason,
    currentStep: s.current_step,
  };
}

function rowToFeedbackNote(f: SupaFeedbackNoteRow): FeedbackNote {
  return {
    id: f.id,
    submissionId: f.submission_id,
    stage: f.stage,
    createdAt: f.created_at,
    teacherText: f.teacher_text,
    anchorText: f.anchor_text,
    start: f.start_pos,
    end: f.end_pos,
    resolvedAt: f.resolved_at,
  };
}

function rowToAiLog(a: SupaAiLogRow): AiLog {
  return {
    id: a.id,
    submissionId: a.submission_id,
    stage: a.stage,
    createdAt: a.created_at,
    role: a.role,
    text: a.text,
  };
}

function rowToScore(s: SupaScoreRow): Score {
  return {
    submissionId: s.submission_id,
    createdAt: s.created_at,
    teacherSummary: s.teacher_summary,
    score: s.score,
    outlineScore: s.outline_score,
    draftScore: s.draft_score,
    reviseScore: s.revise_score,
    isFinalized: s.is_finalized,
  };
}

function rowToStepTransition(t: SupaStepTransitionRow): StepTransition {
  return {
    id: t.id,
    submissionId: t.submission_id,
    studentNo: t.student_no,
    fromStep: t.from_step,
    toStep: t.to_step,
    timestamp: t.ts,
    reason: t.reason,
  };
}

function rowToAiInteraction(a: SupaAiInteractionRow): AiInteraction {
  return {
    id: a.id,
    submissionId: a.submission_id,
    timestamp: a.ts,
    step: a.step,
    type: a.type,
    prompt: a.prompt,
    response: a.response,
    action: a.action,
  };
}

function rowToTeacherComment(c: SupaTeacherCommentRow): TeacherComment {
  return {
    id: c.id,
    submissionId: c.submission_id,
    stage: c.stage,
    createdAt: c.created_at,
    text: c.text,
    readAt: c.read_at,
  };
}

function rowToTombstone(t: SupaTombstoneRow): Tombstone {
  return {
    kind: t.kind,
    id: t.entity_id,
    deletedAt: t.deleted_at,
  };
}

// ── Domain → row (for upsert) ────────────────────────────────────────────

function classToRow(teacherUid: string, c: ClassRoom): SupaClassRow {
  return { id: c.id, teacher_uid: teacherUid, name: c.name, created_at: c.createdAt };
}

function studentsOfClassToRows(c: ClassRoom): SupaStudentRow[] {
  return c.students.map((s) => ({
    class_id: c.id,
    student_no: s.studentNo,
    student_code: s.studentCode,
    created_at: c.createdAt,
  }));
}

function assignmentToRow(teacherUid: string, a: Assignment): SupaAssignmentRow {
  return {
    id: a.id,
    teacher_uid: teacherUid,
    title: a.title,
    prompt: a.prompt,
    task: a.task,
    attachments: a.attachments ?? [],
    criteria: a.criteria ?? null,
    created_at: a.createdAt,
  };
}

function allocationToRows(alloc: AssignmentAllocation): SupaAllocationRow[] {
  return alloc.targets.map((t) =>
    t.type === "class"
      ? {
          assignment_id: alloc.assignmentId,
          target_type: "class" as const,
          class_id: t.classId,
          student_no: null,
        }
      : {
          assignment_id: alloc.assignmentId,
          target_type: "student" as const,
          class_id: t.classId,
          student_no: t.studentNo,
        },
  );
}

function shareLinkToRow(teacherUid: string, s: ShareLink): SupaShareLinkRow {
  return {
    token: s.token,
    teacher_uid: teacherUid,
    assignment_id: s.assignmentId,
    created_at: s.createdAt,
    expires_at: s.expiresAt,
    revoked_at: s.revokedAt,
    spreadsheet_id: s.spreadsheetId ?? null,
  };
}

export function submissionToRow(s: Submission): SupaSubmissionRow {
  return {
    id: s.id,
    assignment_id: s.assignmentId,
    class_id: s.classId,
    student_no: s.studentNo,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
    outline_text: s.outlineText,
    draft_text: s.draftText,
    revise_text: s.reviseText,
    outline_submitted_at: s.outlineSubmittedAt,
    draft_submitted_at: s.draftSubmittedAt,
    revise_submitted_at: s.reviseSubmittedAt,
    outline_approved_at: s.outlineApprovedAt,
    draft_approved_at: s.draftApprovedAt,
    revise_approved_at: s.reviseApprovedAt,
    final_approved_at: s.finalApprovedAt ?? null,
    final_report_published_at: s.finalReportPublishedAt ?? null,
    final_report_snapshot: s.finalReportSnapshot ?? "",
    grasp_data: s.graspData ?? "",
    outline_reject_reason: s.outlineRejectReason ?? "",
    draft_reject_reason: s.draftRejectReason ?? "",
    revise_reject_reason: s.reviseRejectReason ?? "",
    current_step: s.currentStep ?? 1,
  };
}

function feedbackNoteToRow(f: FeedbackNote): SupaFeedbackNoteRow {
  return {
    id: f.id,
    submission_id: f.submissionId,
    stage: f.stage,
    created_at: f.createdAt,
    teacher_text: f.teacherText,
    anchor_text: f.anchorText,
    start_pos: f.start,
    end_pos: f.end,
    resolved_at: f.resolvedAt,
  };
}

function aiLogToRow(a: AiLog): SupaAiLogRow {
  return {
    id: a.id,
    submission_id: a.submissionId,
    stage: a.stage,
    created_at: a.createdAt,
    role: a.role,
    text: a.text,
  };
}

function scoreToRow(s: Score): SupaScoreRow {
  return {
    submission_id: s.submissionId,
    created_at: s.createdAt,
    teacher_summary: s.teacherSummary,
    score: s.score,
    outline_score: s.outlineScore ?? null,
    draft_score: s.draftScore ?? null,
    revise_score: s.reviseScore ?? null,
    is_finalized: s.isFinalized ?? false,
  };
}

function stepTransitionToRow(t: StepTransition): SupaStepTransitionRow {
  return {
    id: t.id,
    submission_id: t.submissionId,
    student_no: t.studentNo,
    from_step: t.fromStep,
    to_step: t.toStep,
    ts: t.timestamp,
    reason: t.reason,
  };
}

function aiInteractionToRow(a: AiInteraction): SupaAiInteractionRow {
  return {
    id: a.id,
    submission_id: a.submissionId,
    ts: a.timestamp,
    step: a.step,
    type: a.type,
    prompt: a.prompt,
    response: a.response,
    action: a.action,
  };
}

function teacherCommentToRow(c: TeacherComment): SupaTeacherCommentRow {
  return {
    id: c.id,
    submission_id: c.submissionId,
    stage: c.stage,
    created_at: c.createdAt,
    text: c.text,
    read_at: c.readAt,
  };
}

function tombstoneToRow(teacherUid: string, t: Tombstone): SupaTombstoneRow {
  return {
    teacher_uid: teacherUid,
    kind: t.kind,
    entity_id: t.id,
    deleted_at: t.deletedAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Sheet→Supabase migration cleanup.
//
// Sheet data accumulated over time can hold two submission rows with
// different `id`s but the same (assignmentId, classId, studentNo) — the
// fingerprint of a past multi-device race that minted a second submission
// for the same student/assignment. Postgres' UNIQUE
// (assignment_id, class_id, student_no) constraint rejects that, so the
// migration would die at the submissions upsert.
//
// Resolution: keep the row with the largest `updatedAt` (latest student
// activity wins) and drop the others. Children (feedbackNotes, aiLogs,
// scores, stepTransitions, aiInteractions, teacherComments) of the dropped
// rows are filtered out so we don't generate FK violations downstream.
// Children attached to the surviving id are kept untouched.
// ─────────────────────────────────────────────────────────────────────────

export function dedupSubmissionsForMigration(
  db: TeacherDb,
): { db: TeacherDb; dedupedCount: number } {
  const byTuple = new Map<string, Submission>();
  for (const s of db.submissions) {
    const key = `${s.assignmentId}::${s.classId}::${s.studentNo}`;
    const existing = byTuple.get(key);
    if (!existing || s.updatedAt > existing.updatedAt) {
      byTuple.set(key, s);
    }
  }
  const dedupedSubmissions = [...byTuple.values()];
  const dedupedCount = db.submissions.length - dedupedSubmissions.length;
  if (dedupedCount === 0) return { db, dedupedCount: 0 };

  const validIds = new Set(dedupedSubmissions.map((s) => s.id));
  return {
    db: {
      ...db,
      submissions: dedupedSubmissions,
      feedbackNotes: db.feedbackNotes.filter((n) => validIds.has(n.submissionId)),
      aiLogs: db.aiLogs.filter((l) => validIds.has(l.submissionId)),
      scores: db.scores.filter((s) => validIds.has(s.submissionId)),
      stepTransitions: db.stepTransitions.filter((t) => validIds.has(t.submissionId)),
      aiInteractions: db.aiInteractions.filter((i) => validIds.has(i.submissionId)),
      teacherComments: db.teacherComments.filter((c) => validIds.has(c.submissionId)),
    },
    dedupedCount,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Read: assemble TeacherDb for a given teacher_uid.
// ─────────────────────────────────────────────────────────────────────────

export async function readTeacherDbForUser(teacherUid: string): Promise<TeacherDb> {
  const db = getSupabaseAdmin();

  // Top-level rows scoped by teacher_uid.
  const [classesRes, assignmentsRes, sharesRes, tombstonesRes] = await Promise.all([
    db.from("classes").select("*").eq("teacher_uid", teacherUid),
    db.from("assignments").select("*").eq("teacher_uid", teacherUid),
    db.from("share_links").select("*").eq("teacher_uid", teacherUid),
    db.from("tombstones").select("*").eq("teacher_uid", teacherUid),
  ]);
  const errs = [classesRes.error, assignmentsRes.error, sharesRes.error, tombstonesRes.error]
    .filter(Boolean);
  if (errs.length > 0) throw new Error(errs.map((e) => e!.message).join("; "));

  const classRows = (classesRes.data ?? []) as SupaClassRow[];
  const assignmentRows = (assignmentsRes.data ?? []) as SupaAssignmentRow[];
  const shareRows = (sharesRes.data ?? []) as SupaShareLinkRow[];
  const tombRows = (tombstonesRes.data ?? []) as SupaTombstoneRow[];

  const classIds = classRows.map((c) => c.id);
  const assignmentIds = assignmentRows.map((a) => a.id);

  // Children scoped by parent IDs. If the teacher has no classes/assignments
  // these IN-empty queries are skipped — Postgres rejects IN () syntactically
  // and supabase-js returns 400 if the array is empty.
  const studentsP = classIds.length
    ? db.from("students").select("*").in("class_id", classIds)
    : Promise.resolve({ data: [] as SupaStudentRow[], error: null });
  const allocationsP = assignmentIds.length
    ? db.from("assignment_allocations").select("*").in("assignment_id", assignmentIds)
    : Promise.resolve({ data: [] as SupaAllocationRow[], error: null });
  const submissionsP = assignmentIds.length
    ? db.from("submissions").select("*").in("assignment_id", assignmentIds)
    : Promise.resolve({ data: [] as SupaSubmissionRow[], error: null });

  const [studentsRes, allocationsRes, submissionsRes] = await Promise.all([
    studentsP,
    allocationsP,
    submissionsP,
  ]);
  const errs2 = [studentsRes.error, allocationsRes.error, submissionsRes.error].filter(Boolean);
  if (errs2.length > 0) throw new Error(errs2.map((e) => e!.message).join("; "));

  const studentRows = (studentsRes.data ?? []) as SupaStudentRow[];
  const allocationRows = (allocationsRes.data ?? []) as SupaAllocationRow[];
  const submissionRows = (submissionsRes.data ?? []) as SupaSubmissionRow[];

  const submissionIds = submissionRows.map((s) => s.id);
  const subChildrenP = submissionIds.length
    ? Promise.all([
        db.from("feedback_notes").select("*").in("submission_id", submissionIds),
        db.from("ai_logs").select("*").in("submission_id", submissionIds),
        db.from("scores").select("*").in("submission_id", submissionIds),
        db.from("step_transitions").select("*").in("submission_id", submissionIds),
        db.from("ai_interactions").select("*").in("submission_id", submissionIds),
        db.from("teacher_comments").select("*").in("submission_id", submissionIds),
      ])
    : Promise.resolve([
        { data: [], error: null },
        { data: [], error: null },
        { data: [], error: null },
        { data: [], error: null },
        { data: [], error: null },
        { data: [], error: null },
      ] as const);

  const [feedbackRes, aiLogsRes, scoresRes, stepRes, aiInterRes, tcommentsRes] = await subChildrenP;
  const errs3 = [
    feedbackRes.error,
    aiLogsRes.error,
    scoresRes.error,
    stepRes.error,
    aiInterRes.error,
    tcommentsRes.error,
  ].filter(Boolean);
  if (errs3.length > 0) throw new Error(errs3.map((e) => e!.message).join("; "));

  // Group students by class_id for the nested ClassRoom shape.
  const studentsByClass = new Map<string, SupaStudentRow[]>();
  for (const s of studentRows) {
    const list = studentsByClass.get(s.class_id) ?? [];
    list.push(s);
    studentsByClass.set(s.class_id, list);
  }

  const classes = classRows.map((c) => rowToClass(c, studentsByClass.get(c.id) ?? []));

  const teacherDb: TeacherDb = {
    version: 5,
    classes,
    assignments: assignmentRows.map(rowToAssignment),
    allocations: allocationsFromRows(allocationRows),
    shares: shareRows.map(rowToShareLink),
    submissions: submissionRows.map(rowToSubmission),
    feedbackNotes: ((feedbackRes.data ?? []) as SupaFeedbackNoteRow[]).map(rowToFeedbackNote),
    aiLogs: ((aiLogsRes.data ?? []) as SupaAiLogRow[]).map(rowToAiLog),
    scores: ((scoresRes.data ?? []) as SupaScoreRow[]).map(rowToScore),
    stepTransitions: ((stepRes.data ?? []) as SupaStepTransitionRow[]).map(rowToStepTransition),
    aiInteractions: ((aiInterRes.data ?? []) as SupaAiInteractionRow[]).map(rowToAiInteraction),
    teacherComments: ((tcommentsRes.data ?? []) as SupaTeacherCommentRow[]).map(rowToTeacherComment),
    tombstones: tombRows.map(rowToTombstone),
  };
  return teacherDb;
}

// ─────────────────────────────────────────────────────────────────────────
// Write: upsert every entity in the TeacherDb owned by `teacherUid`.
//
// We do NOT delete rows that are missing from the incoming db. If a teacher
// uses two devices, each device's last write would otherwise wipe what the
// other added. Explicit deletes are exposed as separate endpoints (Phase 3).
//
// Order matters because of FKs: parents (classes, assignments) before
// children (students, allocations, submissions, ...).
// ─────────────────────────────────────────────────────────────────────────

async function upsertChunked<T>(
  table: string,
  rows: T[],
  conflictColumn: string,
  chunkSize = 500,
): Promise<void> {
  if (rows.length === 0) return;
  const db = getSupabaseAdmin();
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await db.from(table).upsert(chunk as never, { onConflict: conflictColumn });
    if (error) throw new Error(`${table} upsert: ${error.message}`);
  }
}

/**
 * Replace allocation target sets atomically per assignment.
 *
 * A teacher can edit allocation targets (add/remove a class), and unlike
 * other entities allocations have no stable per-target id, so a naive
 * upsert would leave orphan rows for removed targets. We delete-and-insert
 * by assignment_id instead — only the assignments mentioned in the incoming
 * db are touched.
 */
async function replaceAllocations(
  teacherUid: string,
  allocations: AssignmentAllocation[],
  knownAssignmentIds: Set<string>,
): Promise<void> {
  const db = getSupabaseAdmin();
  const assignmentIds = allocations
    .map((a) => a.assignmentId)
    .filter((id) => knownAssignmentIds.has(id));
  if (assignmentIds.length === 0) return;

  // Delete only allocations for assignments the caller actually owns.
  const { error: delErr } = await db
    .from("assignment_allocations")
    .delete()
    .in("assignment_id", assignmentIds);
  if (delErr) throw new Error(`assignment_allocations delete: ${delErr.message}`);

  const rows = allocations
    .filter((a) => knownAssignmentIds.has(a.assignmentId))
    .flatMap(allocationToRows);
  if (rows.length === 0) return;

  // No primary key conflict possible after the delete; plain insert.
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await db.from("assignment_allocations").insert(chunk as never);
    if (error) throw new Error(`assignment_allocations insert: ${error.message}`);
  }
  void teacherUid; // FK chain (assignment → teacher) already enforces ownership
}

/**
 * Replace students of each class in a single delete-and-insert per class.
 *
 * Same reasoning as allocations: students have no stable cross-row id from
 * the client (the client identifies a student by class_id + student_no, and
 * removing a student means the row disappears from the array). We only
 * touch classes that appear in the incoming db.
 */
async function replaceStudentsForClasses(
  classes: ClassRoom[],
  knownClassIds: Set<string>,
): Promise<void> {
  const db = getSupabaseAdmin();
  const targetIds = classes.map((c) => c.id).filter((id) => knownClassIds.has(id));
  if (targetIds.length === 0) return;

  const { error: delErr } = await db.from("students").delete().in("class_id", targetIds);
  if (delErr) throw new Error(`students delete: ${delErr.message}`);

  const rows = classes
    .filter((c) => knownClassIds.has(c.id))
    .flatMap(studentsOfClassToRows);
  if (rows.length === 0) return;

  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await db.from("students").insert(chunk as never);
    if (error) throw new Error(`students insert: ${error.message}`);
  }
}

export async function writeTeacherDbForUser(
  teacherUid: string,
  incoming: TeacherDb,
): Promise<void> {
  // 1) Parents — classes and assignments. After these succeed, child rows
  //    can reference them via FK.
  const classRows = incoming.classes.map((c) => classToRow(teacherUid, c));
  await upsertChunked("classes", classRows, "id");

  const assignmentRows = incoming.assignments.map((a) => assignmentToRow(teacherUid, a));
  await upsertChunked("assignments", assignmentRows, "id");

  const knownClassIds = new Set(incoming.classes.map((c) => c.id));
  const knownAssignmentIds = new Set(incoming.assignments.map((a) => a.id));

  // 2) Students — replace per class. (FK depends on classes upserted above.)
  await replaceStudentsForClasses(incoming.classes, knownClassIds);

  // 3) Allocations — replace per assignment.
  await replaceAllocations(teacherUid, incoming.allocations, knownAssignmentIds);

  // 4) Share links.
  const shareRows = incoming.shares.map((s) => shareLinkToRow(teacherUid, s));
  await upsertChunked("share_links", shareRows, "token");

  // 5) Submissions — id is stable; safe to upsert. Filter out submissions
  //    whose assignmentId/classId are not in the incoming db (defensive: a
  //    bug elsewhere shouldn't let us write a submission with a foreign FK).
  const submissionRows = incoming.submissions
    .filter((s) => knownAssignmentIds.has(s.assignmentId) && knownClassIds.has(s.classId))
    .map(submissionToRow);
  await upsertChunked("submissions", submissionRows, "id");

  const knownSubmissionIds = new Set(submissionRows.map((s) => s.id));
  const subChildOk = (subId: string) => knownSubmissionIds.has(subId);

  // 6) Submission children.
  await upsertChunked(
    "feedback_notes",
    incoming.feedbackNotes.filter((f) => subChildOk(f.submissionId)).map(feedbackNoteToRow),
    "id",
  );
  await upsertChunked(
    "ai_logs",
    incoming.aiLogs.filter((a) => subChildOk(a.submissionId)).map(aiLogToRow),
    "id",
  );
  await upsertChunked(
    "scores",
    incoming.scores.filter((s) => subChildOk(s.submissionId)).map(scoreToRow),
    "submission_id",
  );
  await upsertChunked(
    "step_transitions",
    incoming.stepTransitions
      .filter((t) => subChildOk(t.submissionId))
      .map(stepTransitionToRow),
    "id",
  );
  await upsertChunked(
    "ai_interactions",
    incoming.aiInteractions
      .filter((a) => subChildOk(a.submissionId))
      .map(aiInteractionToRow),
    "id",
  );
  await upsertChunked(
    "teacher_comments",
    incoming.teacherComments
      .filter((c) => subChildOk(c.submissionId))
      .map(teacherCommentToRow),
    "id",
  );

  // 7) Tombstones (kept for compatibility; client may stop writing them).
  const tombRows = incoming.tombstones.map((t) => tombstoneToRow(teacherUid, t));
  await upsertChunked("tombstones", tombRows, "teacher_uid,kind,entity_id");
}

// ─────────────────────────────────────────────────────────────────────────
// Student endpoint helpers — auth + protected submission upsert.
// ─────────────────────────────────────────────────────────────────────────

export type StudentAuthResult =
  | { ok: true; teacherUid: string; assignmentId: string; classId: string }
  | { ok: false; status: number; error: string };

/**
 * Verify (shareToken, studentNo, studentCode) against Supabase. Returns the
 * teacher_uid + assignmentId + classId discovered from the matching share
 * link and student row, or an error response.
 */
export async function authenticateStudent(
  shareToken: string,
  studentNo: string,
  studentCode: string,
): Promise<StudentAuthResult> {
  const db = getSupabaseAdmin();

  const { data: share, error: shareErr } = await db
    .from("share_links")
    .select("token, teacher_uid, assignment_id, expires_at, revoked_at")
    .eq("token", shareToken)
    .maybeSingle();
  if (shareErr) return { ok: false, status: 500, error: shareErr.message };
  if (!share) return { ok: false, status: 403, error: "유효하지 않은 공유 토큰입니다." };
  if (share.revoked_at != null) {
    return { ok: false, status: 403, error: "공유 링크가 해지되었습니다." };
  }
  if (typeof share.expires_at === "number" && share.expires_at < Date.now()) {
    return { ok: false, status: 403, error: "공유 링크가 만료되었습니다." };
  }

  // The student must belong to a class allocated to this assignment. We
  // resolve the (assignmentId, studentNo, studentCode) tuple to a unique
  // class via assignment_allocations + students. If the same studentNo
  // exists in multiple classes for the same teacher, we accept the one
  // that's actually allocated to the assignment.
  const { data: allocs, error: allocErr } = await db
    .from("assignment_allocations")
    .select("class_id, target_type, student_no")
    .eq("assignment_id", share.assignment_id);
  if (allocErr) return { ok: false, status: 500, error: allocErr.message };
  if (!allocs || allocs.length === 0) {
    return { ok: false, status: 403, error: "이 과제에 할당된 학급이 없습니다." };
  }

  const candidateClassIds = new Set<string>();
  for (const a of allocs as SupaAllocationRow[]) {
    if (a.target_type === "class") candidateClassIds.add(a.class_id);
    else if (a.target_type === "student" && a.student_no === studentNo) {
      candidateClassIds.add(a.class_id);
    }
  }
  if (candidateClassIds.size === 0) {
    return { ok: false, status: 403, error: "해당 학번이 이 과제에 할당되어 있지 않습니다." };
  }

  const { data: students, error: stuErr } = await db
    .from("students")
    .select("class_id, student_no, student_code")
    .in("class_id", Array.from(candidateClassIds))
    .eq("student_no", studentNo)
    .eq("student_code", studentCode);
  if (stuErr) return { ok: false, status: 500, error: stuErr.message };
  if (!students || students.length === 0) {
    return { ok: false, status: 403, error: "학번 또는 학생 코드가 일치하지 않습니다." };
  }
  // If multiple classes match (unlikely), pick the first allocated one.
  const matchedClassId = (students[0] as SupaStudentRow).class_id;
  return {
    ok: true,
    teacherUid: share.teacher_uid as string,
    assignmentId: share.assignment_id as string,
    classId: matchedClassId,
  };
}

/**
 * Upsert a single submission while preserving teacher-only fields against a
 * stale student-side payload (mirrors the sheet implementation's three-way
 * merge for outline/draft/revise/finalApproved/rejectReason and finalReport).
 */
export async function upsertStudentSubmission(
  incoming: Submission,
  graspData: string | undefined,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const db = getSupabaseAdmin();

  const { data: existing, error: readErr } = await db
    .from("submissions")
    .select(
      "outline_approved_at, draft_approved_at, revise_approved_at, final_approved_at, final_report_published_at, outline_reject_reason, draft_reject_reason, revise_reject_reason, final_report_snapshot",
    )
    .eq("id", incoming.id)
    .maybeSingle();
  if (readErr) return { ok: false, status: 500, error: readErr.message };

  const merged = submissionToRow(incoming);
  if (existing) {
    // Teacher-only fields: keep DB value.
    merged.outline_approved_at = existing.outline_approved_at as number | null;
    merged.draft_approved_at = existing.draft_approved_at as number | null;
    merged.revise_approved_at = existing.revise_approved_at as number | null;
    merged.final_approved_at = existing.final_approved_at as number | null;
    merged.final_report_published_at = existing.final_report_published_at as number | null;
    merged.outline_reject_reason = (existing.outline_reject_reason as string) ?? "";
    merged.draft_reject_reason = (existing.draft_reject_reason as string) ?? "";
    merged.revise_reject_reason = (existing.revise_reject_reason as string) ?? "";
    // finalReportSnapshot: keep existing unless student explicitly sent a
    // non-empty value (matches sheet behaviour).
    if (!incoming.finalReportSnapshot) {
      merged.final_report_snapshot = (existing.final_report_snapshot as string) ?? "";
    }
  }

  // graspData semantics: undefined means "no change" → keep DB value;
  // a string (even "") means the student saved a new GRASPS payload → write.
  if (graspData === undefined && existing) {
    const { data: gd, error: gdErr } = await db
      .from("submissions")
      .select("grasp_data")
      .eq("id", incoming.id)
      .maybeSingle();
    if (gdErr) return { ok: false, status: 500, error: gdErr.message };
    if (gd) merged.grasp_data = (gd.grasp_data as string) ?? "";
  } else if (graspData !== undefined) {
    merged.grasp_data = graspData;
  }

  const { error: upErr } = await db.from("submissions").upsert(merged as never, { onConflict: "id" });
  if (upErr) return { ok: false, status: 500, error: upErr.message };
  return { ok: true };
}
