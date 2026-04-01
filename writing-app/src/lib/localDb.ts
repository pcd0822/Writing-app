import { nanoid, customAlphabet } from "nanoid";
import {
  TeacherDbSchema,
  type Assignment,
  type AssignmentAllocation,
  type ClassRoom,
  type FeedbackNote,
  type Stage,
  type Submission,
  type ShareLink,
  type AiLog,
  type Score,
  type TeacherDb,
} from "./types";
import { getActiveSpreadsheetId, pushDbToSheet } from "./spreadsheetSync";

const KEY = "writing-app:teacherDb:v1";

const defaultDb: TeacherDb = {
  version: 3,
  classes: [],
  assignments: [],
  allocations: [],
  shares: [],
  submissions: [],
  feedbackNotes: [],
  aiLogs: [],
  scores: [],
};

function assertBrowser() {
  if (typeof window === "undefined") {
    throw new Error("로컬 DB는 브라우저에서만 사용합니다.");
  }
}

export function loadTeacherDb(): TeacherDb {
  assertBrowser();
  const raw = window.localStorage.getItem(KEY);
  if (!raw) return defaultDb;
  try {
    const parsed = JSON.parse(raw);
    const v3 = TeacherDbSchema.safeParse(parsed);
    if (v3.success) return v3.data;

    // v1 -> v2 마이그레이션 (classes만 있던 버전)
    if (parsed && parsed.version === 1 && Array.isArray(parsed.classes)) {
      const v2 = {
        version: 2,
        classes: parsed.classes,
        assignments: [],
        allocations: [],
        shares: [],
      };
      // v2 -> v3로 이어서 마이그레이션
      const migrated: TeacherDb = {
        ...v2,
        version: 3,
        submissions: [],
        feedbackNotes: [],
        aiLogs: [],
        scores: [],
      };
      saveTeacherDb(migrated);
      return migrated;
    }

    // v2 -> v3 마이그레이션
    if (parsed && parsed.version === 2) {
      const migrated: TeacherDb = {
        version: 3,
        classes: parsed.classes || [],
        assignments: parsed.assignments || [],
        allocations: parsed.allocations || [],
        shares: parsed.shares || [],
        submissions: [],
        feedbackNotes: [],
        aiLogs: [],
        scores: [],
      };
      saveTeacherDb(migrated);
      return migrated;
    }

    return defaultDb;
  } catch {
    return defaultDb;
  }
}

export function saveTeacherDb(db: TeacherDb) {
  assertBrowser();
  window.localStorage.setItem(KEY, JSON.stringify(db));
  const sid = getActiveSpreadsheetId();
  if (sid) {
    // fire-and-forget: 모든 변경이 시트로 동기화되게 함
    void pushDbToSheet(sid, db).catch(() => {});
  }
}

export function createClassId() {
  return nanoid(10);
}

const studentCodeAlphabet =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const makeStudentCode = customAlphabet(studentCodeAlphabet, 8);

export function generateStudentCode(existingCodes: Set<string>) {
  // 충돌 가능성은 극히 낮지만, 안전하게 재시도.
  for (let i = 0; i < 50; i++) {
    const code = makeStudentCode();
    if (!existingCodes.has(code)) return code;
  }
  // 마지막 수단: nanoid를 잘라서 사용
  return nanoid(8);
}

export function addClass(db: TeacherDb, cls: ClassRoom): TeacherDb {
  return {
    ...db,
    classes: [cls, ...db.classes],
  };
}

export function createAssignmentId() {
  return nanoid(12);
}

export function addAssignment(db: TeacherDb, a: Assignment): TeacherDb {
  return { ...db, assignments: [a, ...db.assignments] };
}

export function setAllocation(
  db: TeacherDb,
  allocation: AssignmentAllocation,
): TeacherDb {
  const rest = db.allocations.filter((x) => x.assignmentId !== allocation.assignmentId);
  return { ...db, allocations: [allocation, ...rest] };
}

export function createShareToken() {
  // 공유 링크를 간소화: 너무 길지 않게(충돌 가능성은 낮음)
  return nanoid(12);
}

export function createShareLink(
  db: TeacherDb,
  input: { assignmentId: string; expiresAt: number },
): { db: TeacherDb; share: ShareLink } {
  const share: ShareLink = {
    token: createShareToken(),
    assignmentId: input.assignmentId,
    createdAt: Date.now(),
    expiresAt: input.expiresAt,
    revokedAt: null,
  };
  return { db: { ...db, shares: [share, ...db.shares] }, share };
}

export function revokeShareLink(db: TeacherDb, token: string): TeacherDb {
  const now = Date.now();
  return {
    ...db,
    shares: db.shares.map((s) =>
      s.token === token ? { ...s, revokedAt: now } : s,
    ),
  };
}

export function findShare(db: TeacherDb, token: string) {
  return db.shares.find((s) => s.token === token) || null;
}

export function isShareActive(share: ShareLink) {
  if (share.revokedAt) return false;
  return Date.now() < share.expiresAt;
}

export function createSubmissionId() {
  return nanoid(14);
}

export function getOrCreateSubmission(params: {
  assignmentId: string;
  classId: string;
  studentNo: string;
}): { db: TeacherDb; submission: Submission } {
  const db = loadTeacherDb();
  const existing =
    db.submissions.find(
      (s) =>
        s.assignmentId === params.assignmentId &&
        s.classId === params.classId &&
        s.studentNo === params.studentNo,
    ) || null;
  if (existing) return { db, submission: existing };

  const now = Date.now();
  const submission: Submission = {
    id: createSubmissionId(),
    assignmentId: params.assignmentId,
    classId: params.classId,
    studentNo: params.studentNo,
    createdAt: now,
    updatedAt: now,
    outlineText: "",
    draftText: "",
    reviseText: "",
    outlineSubmittedAt: null,
    draftSubmittedAt: null,
    reviseSubmittedAt: null,
    outlineApprovedAt: null,
    draftApprovedAt: null,
    reviseApprovedAt: null,
    finalApprovedAt: null,
  };
  const next = { ...db, submissions: [submission, ...db.submissions] };
  saveTeacherDb(next);
  return { db: next, submission };
}

export function updateSubmission(
  submissionId: string,
  patch: Partial<Submission>,
): Submission {
  const db = loadTeacherDb();
  const idx = db.submissions.findIndex((s) => s.id === submissionId);
  if (idx < 0) throw new Error("submission not found");
  const updated = {
    ...db.submissions[idx]!,
    ...patch,
    updatedAt: Date.now(),
  };
  const nextSubmissions = [...db.submissions];
  nextSubmissions[idx] = updated;
  saveTeacherDb({ ...db, submissions: nextSubmissions });
  return updated;
}

export function createFeedbackNoteId() {
  return nanoid(12);
}

export function addFeedbackNote(note: FeedbackNote): FeedbackNote {
  const db = loadTeacherDb();
  const next = { ...db, feedbackNotes: [note, ...db.feedbackNotes] };
  saveTeacherDb(next);
  return note;
}

export function resolveFeedbackNote(noteId: string) {
  const db = loadTeacherDb();
  const now = Date.now();
  const next = {
    ...db,
    feedbackNotes: db.feedbackNotes.map((n) =>
      n.id === noteId ? { ...n, resolvedAt: now } : n,
    ),
  };
  saveTeacherDb(next);
}

export function addAiLog(log: AiLog) {
  const db = loadTeacherDb();
  saveTeacherDb({ ...db, aiLogs: [log, ...db.aiLogs] });
}

export function upsertScore(score: Score) {
  const db = loadTeacherDb();
  const rest = db.scores.filter((s) => s.submissionId !== score.submissionId);
  saveTeacherDb({ ...db, scores: [score, ...rest] });
}

export function getCurrentStage(submission: Submission): Stage {
  if (!submission.outlineApprovedAt) return "outline";
  if (!submission.draftApprovedAt) return "draft";
  if (!submission.reviseApprovedAt) return "revise";
  return "revise";
}

