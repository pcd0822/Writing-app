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
  type AiInteraction,
  type Score,
  type StepTransition,
  type TeacherComment,
  type TeacherDb,
} from "./types";
import { normalizeDriveAttachmentsInDb } from "./attachments";
import {
  getActiveSpreadsheetId,
  pullDbFromSheet,
  pushDbToSheet,
  setActiveSpreadsheetId,
} from "./spreadsheetSync";

const KEY = "writing-app:teacherDb:v1";

const defaultDb: TeacherDb = {
  version: 5,
  classes: [],
  assignments: [],
  allocations: [],
  shares: [],
  submissions: [],
  feedbackNotes: [],
  aiLogs: [],
  scores: [],
  stepTransitions: [],
  aiInteractions: [],
  teacherComments: [],
};

function assertBrowser() {
  if (typeof window === "undefined") {
    throw new Error("로컬 DB는 브라우저에서만 사용합니다.");
  }
}

function migrateV3RawToV4(parsed: Record<string, unknown>): Record<string, unknown> {
  const submissions = ((parsed.submissions as Submission[]) || []).map((s) => ({
    ...s,
    finalReportPublishedAt: (s as Submission).finalReportPublishedAt ?? null,
    finalReportSnapshot: (s as Submission).finalReportSnapshot ?? "",
  }));
  const scores = ((parsed.scores as Score[]) || []).map((sc) => ({
    ...sc,
    outlineScore: (sc as Score).outlineScore ?? null,
    draftScore: (sc as Score).draftScore ?? null,
    reviseScore: (sc as Score).reviseScore ?? null,
  }));
  return {
    version: 4,
    classes: (parsed.classes as TeacherDb["classes"]) || [],
    assignments: (parsed.assignments as TeacherDb["assignments"]) || [],
    allocations: (parsed.allocations as TeacherDb["allocations"]) || [],
    shares: (parsed.shares as TeacherDb["shares"]) || [],
    submissions,
    feedbackNotes: (parsed.feedbackNotes as TeacherDb["feedbackNotes"]) || [],
    aiLogs: (parsed.aiLogs as TeacherDb["aiLogs"]) || [],
    scores,
  };
}

function migrateToV5(parsed: Record<string, unknown>): TeacherDb {
  const submissions = ((parsed.submissions as Submission[]) || []).map((s) => ({
    ...s,
    graspData: (s as Submission).graspData ?? "",
    outlineRejectReason: (s as Submission).outlineRejectReason ?? "",
    draftRejectReason: (s as Submission).draftRejectReason ?? "",
    reviseRejectReason: (s as Submission).reviseRejectReason ?? "",
    currentStep: (s as Submission).currentStep ?? 1,
    finalReportPublishedAt: (s as Submission).finalReportPublishedAt ?? null,
    finalReportSnapshot: (s as Submission).finalReportSnapshot ?? "",
  }));
  const scores = ((parsed.scores as Score[]) || []).map((sc) => ({
    ...sc,
    outlineScore: (sc as Score).outlineScore ?? null,
    draftScore: (sc as Score).draftScore ?? null,
    reviseScore: (sc as Score).reviseScore ?? null,
    isFinalized: (sc as Score).isFinalized ?? false,
  }));
  return {
    version: 5,
    classes: (parsed.classes as TeacherDb["classes"]) || [],
    assignments: (parsed.assignments as TeacherDb["assignments"]) || [],
    allocations: (parsed.allocations as TeacherDb["allocations"]) || [],
    shares: (parsed.shares as TeacherDb["shares"]) || [],
    submissions,
    feedbackNotes: (parsed.feedbackNotes as TeacherDb["feedbackNotes"]) || [],
    aiLogs: (parsed.aiLogs as TeacherDb["aiLogs"]) || [],
    scores,
    stepTransitions: (parsed.stepTransitions as TeacherDb["stepTransitions"]) || [],
    aiInteractions: (parsed.aiInteractions as TeacherDb["aiInteractions"]) || [],
    teacherComments: (parsed.teacherComments as TeacherDb["teacherComments"]) || [],
  };
}

export function loadTeacherDb(): TeacherDb {
  assertBrowser();
  const raw = window.localStorage.getItem(KEY);
  if (!raw) return defaultDb;
  try {
    let parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed) return defaultDb;

    // v1 -> v2
    if (parsed.version === 1 && Array.isArray(parsed.classes)) {
      parsed = {
        version: 2,
        classes: parsed.classes,
        assignments: [],
        allocations: [],
        shares: [],
      };
    }

    // v2 -> v4
    if (parsed.version === 2) {
      parsed = {
        version: 4,
        classes: (parsed.classes as ClassRoom[]) || [],
        assignments: (parsed.assignments as TeacherDb["assignments"]) || [],
        allocations: (parsed.allocations as TeacherDb["allocations"]) || [],
        shares: (parsed.shares as TeacherDb["shares"]) || [],
        submissions: [],
        feedbackNotes: [],
        aiLogs: [],
        scores: [],
      };
    }

    // v3 -> v4
    if (parsed.version === 3) {
      parsed = migrateV3RawToV4(parsed);
    }

    // v4 -> v5
    if (parsed.version === 4) {
      parsed = migrateToV5(parsed);
    }

    const result = TeacherDbSchema.safeParse(parsed);
    if (result.success) {
      // 마이그레이션이 발생했으면 저장
      if (raw && JSON.parse(raw).version !== 5) {
        saveTeacherDb(result.data);
      }
      return result.data;
    }

    // 직접 v5 변환 시도
    const fallback = migrateToV5(parsed);
    saveTeacherDb(fallback);
    return fallback;
  } catch {
    return defaultDb;
  }
}

export function saveTeacherDb(
  db: TeacherDb,
  options?: { spreadsheetId?: string | null; skipRemotePush?: boolean },
) {
  assertBrowser();
  const normalized = normalizeDriveAttachmentsInDb(db);
  window.localStorage.setItem(KEY, JSON.stringify(normalized));
  if (options?.skipRemotePush) return;
  const pushId =
    (options?.spreadsheetId && String(options.spreadsheetId).trim()) ||
    getActiveSpreadsheetId();
  if (pushId) {
    void pushDbToSheet(pushId, normalized).catch((err) => {
      console.error("[Writing app] pushDbToSheet failed:", err);
    });
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

export function deleteClass(db: TeacherDb, classId: string): TeacherDb {
  const removedSubmissionIds = new Set(
    db.submissions.filter((s) => s.classId === classId).map((s) => s.id),
  );
  const allocations = db.allocations.map((a) => ({
    ...a,
    targets: a.targets.filter((t) => t.classId !== classId),
  }));
  return {
    ...db,
    classes: db.classes.filter((c) => c.id !== classId),
    allocations,
    submissions: db.submissions.filter((s) => s.classId !== classId),
    feedbackNotes: db.feedbackNotes.filter((n) => !removedSubmissionIds.has(n.submissionId)),
    aiLogs: db.aiLogs.filter((l) => !removedSubmissionIds.has(l.submissionId)),
    scores: db.scores.filter((s) => !removedSubmissionIds.has(s.submissionId)),
    stepTransitions: db.stepTransitions.filter((t) => !removedSubmissionIds.has(t.submissionId)),
    aiInteractions: db.aiInteractions.filter((i) => !removedSubmissionIds.has(i.submissionId)),
    teacherComments: db.teacherComments.filter((c) => !removedSubmissionIds.has(c.submissionId)),
  };
}

export function createAssignmentId() {
  return nanoid(12);
}

export function addAssignment(db: TeacherDb, a: Assignment): TeacherDb {
  return { ...db, assignments: [a, ...db.assignments] };
}

export function deleteAssignment(db: TeacherDb, assignmentId: string): TeacherDb {
  const removedSubmissionIds = new Set(
    db.submissions.filter((s) => s.assignmentId === assignmentId).map((s) => s.id),
  );
  return {
    ...db,
    assignments: db.assignments.filter((a) => a.id !== assignmentId),
    allocations: db.allocations.filter((a) => a.assignmentId !== assignmentId),
    shares: db.shares.filter((s) => s.assignmentId !== assignmentId),
    submissions: db.submissions.filter((s) => s.assignmentId !== assignmentId),
    feedbackNotes: db.feedbackNotes.filter((n) => !removedSubmissionIds.has(n.submissionId)),
    aiLogs: db.aiLogs.filter((l) => !removedSubmissionIds.has(l.submissionId)),
    scores: db.scores.filter((s) => !removedSubmissionIds.has(s.submissionId)),
    stepTransitions: db.stepTransitions.filter((t) => !removedSubmissionIds.has(t.submissionId)),
    aiInteractions: db.aiInteractions.filter((i) => !removedSubmissionIds.has(i.submissionId)),
    teacherComments: db.teacherComments.filter((c) => !removedSubmissionIds.has(c.submissionId)),
  };
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
  input: { assignmentId: string; expiresAt: number; spreadsheetId?: string },
): { db: TeacherDb; share: ShareLink } {
  const share: ShareLink = {
    token: createShareToken(),
    assignmentId: input.assignmentId,
    createdAt: Date.now(),
    expiresAt: input.expiresAt,
    revokedAt: null,
    ...(input.spreadsheetId ? { spreadsheetId: input.spreadsheetId } : {}),
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

/** 해당 과제에 남아 있는 다른 공유까지 모두 폐기해, 유효 링크가 없도록 함 */
export function revokeAllSharesForAssignment(
  db: TeacherDb,
  assignmentId: string,
): TeacherDb {
  const now = Date.now();
  return {
    ...db,
    shares: db.shares.map((s) =>
      s.assignmentId === assignmentId && s.revokedAt == null
        ? { ...s, revokedAt: now }
        : s,
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
    finalReportPublishedAt: null,
    finalReportSnapshot: "",
    graspData: "",
    outlineRejectReason: "",
    draftRejectReason: "",
    reviseRejectReason: "",
    currentStep: 1,
  };
  const next = { ...db, submissions: [submission, ...db.submissions] };
  saveTeacherDb(next);
  return { db: next, submission };
}

export function updateSubmission(
  submissionId: string,
  patch: Partial<Submission>,
  options?: { spreadsheetId?: string | null },
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
  saveTeacherDb({ ...db, submissions: nextSubmissions }, {
    spreadsheetId: options?.spreadsheetId,
  });
  return updated;
}

/**
 * 학생 기기 로컬 DB와 시트(교사) DB를 병합합니다.
 * - 클래스/과제/배당/공유는 remote(시트) 기준
 * - 제출 글 본문·제출 시각은 local(학생) 우선
 * - 승인·최종리포트·점수·피드백 메모·AI 로그는 remote와 local을 id 기준으로 합침
 */
export function mergeTeacherDbForStudentView(local: TeacherDb, remote: TeacherDb): TeacherDb {
  const localById = new Map(local.submissions.map((s) => [s.id, s]));
  const remoteSubIds = new Set(remote.submissions.map((s) => s.id));

  const mergedSubmissions: Submission[] = remote.submissions.map((rs) => {
    const ls = localById.get(rs.id);
    if (!ls) return rs;
    return {
      ...rs,
      outlineText: ls.outlineText,
      draftText: ls.draftText,
      reviseText: ls.reviseText,
      outlineSubmittedAt: ls.outlineSubmittedAt ?? rs.outlineSubmittedAt,
      draftSubmittedAt: ls.draftSubmittedAt ?? rs.draftSubmittedAt,
      reviseSubmittedAt: ls.reviseSubmittedAt ?? rs.reviseSubmittedAt,
      // 학생이 작성한 GRASPS·진행 단계는 local에 값이 있으면 보존 (remote 푸시 지연 시 사라지지 않도록)
      graspData: ls.graspData || rs.graspData,
      currentStep: ls.currentStep ?? rs.currentStep,
      updatedAt: Math.max(ls.updatedAt, rs.updatedAt),
    };
  });
  for (const ls of local.submissions) {
    if (!remoteSubIds.has(ls.id)) mergedSubmissions.push(ls);
  }

  const noteMap = new Map(local.feedbackNotes.map((n) => [n.id, n]));
  for (const n of remote.feedbackNotes) noteMap.set(n.id, n);
  const feedbackNotes = [...noteMap.values()].sort((a, b) => a.createdAt - b.createdAt);

  const scoreMap = new Map(local.scores.map((s) => [s.submissionId, s]));
  for (const s of remote.scores) scoreMap.set(s.submissionId, s);
  const scores = [...scoreMap.values()];

  const logMap = new Map(local.aiLogs.map((l) => [l.id, l]));
  for (const l of remote.aiLogs) logMap.set(l.id, l);
  const aiLogs = [...logMap.values()].sort((a, b) => b.createdAt - a.createdAt);

  const transMap = new Map(local.stepTransitions.map((t) => [t.id, t]));
  for (const t of remote.stepTransitions) transMap.set(t.id, t);
  const stepTransitions = [...transMap.values()].sort((a, b) => a.timestamp - b.timestamp);

  const interMap = new Map(local.aiInteractions.map((i) => [i.id, i]));
  for (const i of remote.aiInteractions) interMap.set(i.id, i);
  const aiInteractions = [...interMap.values()].sort((a, b) => a.timestamp - b.timestamp);

  const commentMap = new Map(local.teacherComments.map((c) => [c.id, c]));
  for (const c of remote.teacherComments) commentMap.set(c.id, c);
  const teacherComments = [...commentMap.values()].sort((a, b) => a.createdAt - b.createdAt);

  return {
    ...remote,
    submissions: mergedSubmissions,
    feedbackNotes,
    scores,
    aiLogs,
    stepTransitions,
    aiInteractions,
    teacherComments,
  };
}

/** 시트에서 최신 DB를 가져와 학생 화면 기준으로 병합 후 저장 */
export async function mergeStudentViewFromRemote(
  spreadsheetId?: string | null,
): Promise<void> {
  const sid = spreadsheetId?.trim() || getActiveSpreadsheetId();
  if (!sid) return;
  try {
    const remote = await pullDbFromSheet(sid);
    if (!remote) return;
    const merged = mergeTeacherDbForStudentView(loadTeacherDb(), remote as TeacherDb);
    saveTeacherDb(merged, { spreadsheetId: sid });
  } catch {
    /* 네트워크 실패 시 로컬 유지 */
  }
}

/** 저장 전 원격과 병합해 교사 승인 등이 로컬 저장으로 덮어씌워지지 않게 함 */
export async function updateSubmissionWithRemoteMerge(
  submissionId: string,
  patch: Partial<Submission>,
  options?: { spreadsheetId?: string | null },
): Promise<Submission> {
  const sid = options?.spreadsheetId?.trim() || getActiveSpreadsheetId();
  if (sid) setActiveSpreadsheetId(sid);
  await mergeStudentViewFromRemote(sid);
  return updateSubmission(submissionId, patch, { spreadsheetId: sid });
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

export function resolveFeedbackNote(
  noteId: string,
  options?: { spreadsheetId?: string | null },
) {
  const db = loadTeacherDb();
  const now = Date.now();
  const next = {
    ...db,
    feedbackNotes: db.feedbackNotes.map((n) =>
      n.id === noteId ? { ...n, resolvedAt: now } : n,
    ),
  };
  saveTeacherDb(next, { spreadsheetId: options?.spreadsheetId });
}

export async function addAiLog(
  log: AiLog,
  options?: { spreadsheetId?: string | null },
) {
  const sid = options?.spreadsheetId?.trim() || getActiveSpreadsheetId();
  if (sid) setActiveSpreadsheetId(sid);
  await mergeStudentViewFromRemote(sid);
  const db = loadTeacherDb();
  saveTeacherDb({ ...db, aiLogs: [log, ...db.aiLogs] }, { spreadsheetId: sid });
}

export function upsertScore(score: Score) {
  const db = loadTeacherDb();
  const rest = db.scores.filter((s) => s.submissionId !== score.submissionId);
  saveTeacherDb({ ...db, scores: [score, ...rest] });
}

export function updateAssignmentById(
  assignmentId: string,
  patch: Partial<Pick<Assignment, "title" | "prompt" | "task" | "attachments">>,
): void {
  const db = loadTeacherDb();
  const idx = db.assignments.findIndex((a) => a.id === assignmentId);
  if (idx < 0) throw new Error("assignment not found");
  const prev = db.assignments[idx]!;
  /** Partial 병합 시 undefined가 덮어쓰면 JSON 직렬화에서 키가 빠져 첨부 등이 초기화됨 */
  const nextA: Assignment = {
    ...prev,
    title: patch.title !== undefined ? patch.title : prev.title,
    prompt: patch.prompt !== undefined ? patch.prompt : prev.prompt,
    task: patch.task !== undefined ? patch.task : prev.task,
    attachments:
      patch.attachments !== undefined ? patch.attachments : prev.attachments ?? [],
  };
  const assignments = [...db.assignments];
  assignments[idx] = nextA;
  saveTeacherDb({ ...db, assignments });
}

export function getCurrentStage(submission: Submission): Stage {
  if (!submission.outlineApprovedAt) return "outline";
  if (!submission.draftApprovedAt) return "draft";
  if (!submission.reviseApprovedAt) return "revise";
  return "revise";
}

// ── Step Transition CRUD ────────────────────────────────────────

export function addStepTransition(
  transition: StepTransition,
  options?: { spreadsheetId?: string | null },
) {
  const db = loadTeacherDb();
  saveTeacherDb(
    { ...db, stepTransitions: [...db.stepTransitions, transition] },
    { spreadsheetId: options?.spreadsheetId },
  );
}

// ── AI Interaction CRUD ─────────────────────────────────────────

export function addAiInteraction(
  interaction: AiInteraction,
  options?: { spreadsheetId?: string | null },
) {
  const db = loadTeacherDb();
  saveTeacherDb(
    { ...db, aiInteractions: [...db.aiInteractions, interaction] },
    { spreadsheetId: options?.spreadsheetId },
  );
}

export function updateAiInteractionAction(
  interactionId: string,
  action: AiInteraction["action"],
  options?: { spreadsheetId?: string | null },
) {
  const db = loadTeacherDb();
  const next = {
    ...db,
    aiInteractions: db.aiInteractions.map((i) =>
      i.id === interactionId ? { ...i, action } : i,
    ),
  };
  saveTeacherDb(next, { spreadsheetId: options?.spreadsheetId });
}

// ── Teacher Comment CRUD ────────────────────────────────────────

export function addTeacherComment(
  comment: TeacherComment,
  options?: { spreadsheetId?: string | null },
) {
  const db = loadTeacherDb();
  saveTeacherDb(
    { ...db, teacherComments: [comment, ...db.teacherComments] },
    { spreadsheetId: options?.spreadsheetId },
  );
}

export function markCommentRead(
  commentId: string,
  options?: { spreadsheetId?: string | null },
) {
  const db = loadTeacherDb();
  const next = {
    ...db,
    teacherComments: db.teacherComments.map((c) =>
      c.id === commentId ? { ...c, readAt: Date.now() } : c,
    ),
  };
  saveTeacherDb(next, { spreadsheetId: options?.spreadsheetId });
}

// ── GRASP helpers ───────────────────────────────────────────────

export function getGraspData(submission: Submission) {
  if (!submission.graspData) return null;
  try {
    return JSON.parse(submission.graspData) as import("./types").Grasp;
  } catch {
    return null;
  }
}

export function stageToStep(stage: Stage): number {
  if (stage === "outline") return 1;
  if (stage === "draft") return 2;
  return 3;
}

export function stepToStage(step: number): Stage {
  if (step <= 1) return "outline";
  if (step === 2) return "draft";
  return "revise";
}

