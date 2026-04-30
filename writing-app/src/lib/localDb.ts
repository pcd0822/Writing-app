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
  type Tombstone,
} from "./types";
import { normalizeDriveAttachmentsInDb } from "./attachments";
import {
  getActiveSpreadsheetId,
  pullDbFromSheet,
  pullDbFromSheetWithRetry,
  pushDbToSheetCoalesced,
  pushSubmissionPartialCoalesced,
  setActiveSpreadsheetId,
} from "./spreadsheetSync";

const KEY = "writing-app:teacherDb:v1";

/**
 * 같은 디바이스를 다른 학생이 사용하게 되는 케이스를 격리하기 위한 마커.
 * share landing onEnter에서 인증 성공한 학생을 기록해두고, 다음에 다른 학생이
 * 인증되면 localStorage(teacherDb)를 비워서 직전 학생의 작성물이 노출되지 않게 한다.
 */
const LAST_STUDENT_KEY = "writing-app:lastStudentAuth";

/**
 * 직전에 같은 디바이스로 인증한 학생과 동일한지 비교. 학번만 같고 코드가 다르면
 * 다른 학생으로 간주(같은 학번이 여러 학급에 존재할 수 있고, 학생 코드는 유일).
 */
export function isSameStudentAsLast(studentNo: string, studentCode: string): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = window.localStorage.getItem(LAST_STUDENT_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { studentNo?: string; studentCode?: string };
    return parsed.studentNo === studentNo && parsed.studentCode === studentCode;
  } catch {
    return false;
  }
}

/** 인증 성공 시 마지막 학생을 기록. 다음 진입에서 비교 기준으로 사용. */
export function rememberLastStudent(studentNo: string, studentCode: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      LAST_STUDENT_KEY,
      JSON.stringify({ studentNo, studentCode }),
    );
  } catch {
    /* sessionStorage·private mode 등에서는 격리 강도 낮아지지만 기능은 동작 */
  }
}

/**
 * 학생용 작성 데이터(teacherDb)만 비운다. 글꼴 너비·튜터 패널 위치 같은 UI 위젯
 * 설정은 보존. 시트 pull로 이어지는 흐름에서 사용해야 학생 B가 빈 화면을 보지 않는다.
 */
export function clearStudentLocalDb() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

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
  tombstones: [],
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
    tombstones: (parsed.tombstones as TeacherDb["tombstones"]) || [],
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
  options?: {
    spreadsheetId?: string | null;
    skipRemotePush?: boolean;
    /**
     * 학생 path는 자기 submission/관련 청크만 변경하므로 push 직전 풀-DB pull-merge가
     * 거의 무의미하고 quota를 두 배로 쓴다. true면 pre-pull을 건너뛴다.
     */
    studentPush?: boolean;
  },
) {
  assertBrowser();
  const normalized = normalizeDriveAttachmentsInDb(db);
  window.localStorage.setItem(KEY, JSON.stringify(normalized));
  if (options?.skipRemotePush) return;
  const pushId =
    (options?.spreadsheetId && String(options.spreadsheetId).trim()) ||
    getActiveSpreadsheetId();
  if (pushId) {
    pushDbToSheetCoalesced(pushId, normalized, {
      skipPullMerge: options?.studentPush === true,
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
  const tombstone: Tombstone = { kind: "class", id: classId, deletedAt: Date.now() };
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
    tombstones: addTombstone(db.tombstones, tombstone),
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
  const tombstone: Tombstone = {
    kind: "assignment",
    id: assignmentId,
    deletedAt: Date.now(),
  };
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
    tombstones: addTombstone(db.tombstones, tombstone),
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

/**
 * 두 교사가 같은 시트에 공유 토큰을 만들 때 한쪽이 다른 쪽의 토큰을 덮어쓰지
 * 않도록 토큰 기준 union으로 합친다. revoke 상태는 둘 중 먼저 폐기된 쪽을 우선.
 */
export function mergeShares(a: ShareLink[], b: ShareLink[]): ShareLink[] {
  const byToken = new Map<string, ShareLink>();
  for (const s of a) byToken.set(s.token, s);
  for (const s of b) {
    const cur = byToken.get(s.token);
    if (!cur) {
      byToken.set(s.token, s);
      continue;
    }
    const curRev = cur.revokedAt ?? null;
    const newRev = s.revokedAt ?? null;
    let revokedAt: number | null;
    if (curRev != null && newRev != null) revokedAt = Math.min(curRev, newRev);
    else revokedAt = curRev ?? newRev;
    // 만료 시각은 둘 중 더 늦은(=더 관대한) 값을 채택해 학생 접근을 끊지 않는다.
    const expiresAt = Math.max(cur.expiresAt, s.expiresAt);
    byToken.set(s.token, {
      ...cur,
      ...s,
      revokedAt,
      expiresAt,
      // createdAt은 더 빠른 쪽 유지(원본 생성 시각이 의미 있음)
      createdAt: Math.min(cur.createdAt, s.createdAt),
    });
  }
  return Array.from(byToken.values()).sort((x, y) => y.createdAt - x.createdAt);
}

/**
 * 원격 시트의 shares만 로컬 DB에 합쳐 반환. 다른 필드는 로컬 그대로 유지하므로
 * 사용자의 진행 중 작업이나 미푸시 변경을 잃지 않는다.
 */
export function mergeRemoteSharesIntoLocalDb(
  local: TeacherDb,
  remote: TeacherDb,
): TeacherDb {
  return { ...local, shares: mergeShares(local.shares, remote.shares) };
}

// ── 전체 DB 양방향 머지 ────────────────────────────────────────
//
// 두 교사가 같은 시트를 공유 사용할 때, 각자 자기 로컬 DB를 시트에 push하면
// 한쪽이 다른 쪽의 변경(과제·학급·제출 등)을 통째로 덮어쓴다. 이를 막기 위해
// push/pull 시점마다 두 DB를 id 기반 union으로 머지한다.
//
// 우선순위 규칙:
//  - 한쪽에만 있는 항목은 그대로 보존(union)
//  - 충돌(같은 id) 시 기본은 local 우선(사용자가 방금 한 변경을 보존)
//  - submissions: updatedAt 더 큰 쪽
//  - feedbackNote/teacherComment: resolvedAt/readAt이 있는 쪽 우선
//  - score: createdAt 더 큰 쪽
//  - share: 별도 mergeShares 규칙(만료 늦은 쪽·폐기 빠른 쪽)
//  - allocation/class students: targets/students 배열 내 union
//
// 삭제는 union 모델에서 "되살아남" 위험이 있다. 다행히 삭제는 즉시 push하므로
// 다른 디바이스가 다음 동기화에서 그 결과를 받는다.

function mergeBy<T>(
  local: T[],
  remote: T[],
  keyFn: (x: T) => string,
  pickConflict: (l: T, r: T) => T = (l) => l,
): T[] {
  const map = new Map<string, T>();
  for (const x of remote) map.set(keyFn(x), x);
  for (const x of local) {
    const k = keyFn(x);
    const r = map.get(k);
    map.set(k, r ? pickConflict(x, r) : x);
  }
  return Array.from(map.values());
}

function mergeById<T extends { id: string }>(
  local: T[],
  remote: T[],
  pickConflict: (l: T, r: T) => T = (l) => l,
): T[] {
  return mergeBy(local, remote, (x) => x.id, pickConflict);
}

function mergeClasses(local: ClassRoom[], remote: ClassRoom[]): ClassRoom[] {
  const map = new Map<string, ClassRoom>();
  for (const c of remote) map.set(c.id, c);
  for (const c of local) {
    const r = map.get(c.id);
    if (!r) {
      map.set(c.id, c);
      continue;
    }
    const seen = new Set<string>();
    const students: ClassRoom["students"] = [];
    for (const s of [...c.students, ...r.students]) {
      if (seen.has(s.studentNo)) continue;
      seen.add(s.studentNo);
      students.push(s);
    }
    map.set(c.id, {
      id: c.id,
      name: c.name || r.name,
      createdAt: Math.min(c.createdAt, r.createdAt),
      students,
    });
  }
  return Array.from(map.values()).sort((a, b) => b.createdAt - a.createdAt);
}

function mergeAllocations(
  local: AssignmentAllocation[],
  remote: AssignmentAllocation[],
): AssignmentAllocation[] {
  const map = new Map<string, AssignmentAllocation>();
  for (const a of remote) map.set(a.assignmentId, a);
  for (const a of local) {
    const r = map.get(a.assignmentId);
    if (!r) {
      map.set(a.assignmentId, a);
      continue;
    }
    const seen = new Set<string>();
    const targets: AssignmentAllocation["targets"] = [];
    for (const t of [...a.targets, ...r.targets]) {
      const key =
        t.type === "class" ? `c:${t.classId}` : `s:${t.classId}:${t.studentNo}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push(t);
    }
    map.set(a.assignmentId, { assignmentId: a.assignmentId, targets });
  }
  return Array.from(map.values());
}

// ── Tombstone helpers ─────────────────────────────────────────

/** 동일 (kind,id) 마커가 있으면 더 이른 deletedAt 보존, 없으면 추가. */
function addTombstone(existing: Tombstone[] | undefined, t: Tombstone): Tombstone[] {
  const arr = existing ?? [];
  const idx = arr.findIndex((x) => x.kind === t.kind && x.id === t.id);
  if (idx < 0) return [...arr, t];
  const cur = arr[idx]!;
  if (cur.deletedAt <= t.deletedAt) return arr;
  const next = [...arr];
  next[idx] = t;
  return next;
}

function mergeTombstones(a: Tombstone[], b: Tombstone[]): Tombstone[] {
  const map = new Map<string, Tombstone>();
  for (const t of a) map.set(`${t.kind}:${t.id}`, t);
  for (const t of b) {
    const key = `${t.kind}:${t.id}`;
    const cur = map.get(key);
    if (!cur || t.deletedAt < cur.deletedAt) map.set(key, t);
  }
  return Array.from(map.values());
}

/**
 * tombstones에 마킹된 엔티티(class·assignment)를 결과 db에서 cascade로 제거.
 * union 머지 직후 호출해서 다른 디바이스의 stale 데이터로 부활하지 않도록 한다.
 */
function applyTombstones(db: TeacherDb): TeacherDb {
  const tombs = db.tombstones || [];
  const classDeleted = new Set(
    tombs.filter((t) => t.kind === "class").map((t) => t.id),
  );
  const assignmentDeleted = new Set(
    tombs.filter((t) => t.kind === "assignment").map((t) => t.id),
  );
  if (classDeleted.size === 0 && assignmentDeleted.size === 0) return db;

  const classes = db.classes.filter((c) => !classDeleted.has(c.id));
  const assignments = db.assignments.filter((a) => !assignmentDeleted.has(a.id));
  const allocations = db.allocations
    .filter((a) => !assignmentDeleted.has(a.assignmentId))
    .map((a) => ({
      ...a,
      targets: a.targets.filter((t) => !classDeleted.has(t.classId)),
    }));
  const shares = db.shares.filter((s) => !assignmentDeleted.has(s.assignmentId));
  const removedSubmissionIds = new Set(
    db.submissions
      .filter(
        (s) =>
          assignmentDeleted.has(s.assignmentId) || classDeleted.has(s.classId),
      )
      .map((s) => s.id),
  );
  const submissions = db.submissions.filter(
    (s) =>
      !assignmentDeleted.has(s.assignmentId) && !classDeleted.has(s.classId),
  );
  const feedbackNotes = db.feedbackNotes.filter(
    (n) => !removedSubmissionIds.has(n.submissionId),
  );
  const aiLogs = db.aiLogs.filter((l) => !removedSubmissionIds.has(l.submissionId));
  const scores = db.scores.filter((s) => !removedSubmissionIds.has(s.submissionId));
  const stepTransitions = db.stepTransitions.filter(
    (t) => !removedSubmissionIds.has(t.submissionId),
  );
  const aiInteractions = db.aiInteractions.filter(
    (i) => !removedSubmissionIds.has(i.submissionId),
  );
  const teacherComments = db.teacherComments.filter(
    (c) => !removedSubmissionIds.has(c.submissionId),
  );

  return {
    ...db,
    classes,
    assignments,
    allocations,
    shares,
    submissions,
    feedbackNotes,
    aiLogs,
    scores,
    stepTransitions,
    aiInteractions,
    teacherComments,
  };
}

export function mergeTeacherDbs(local: TeacherDb, remote: TeacherDb): TeacherDb {
  const merged: TeacherDb = {
    version: local.version,
    classes: mergeClasses(local.classes, remote.classes),
    // 과제는 updatedAt이 없어 비교 불가 → local 우선(사용자의 최근 입력 보존).
    assignments: mergeById(local.assignments, remote.assignments),
    allocations: mergeAllocations(local.allocations, remote.allocations),
    shares: mergeShares(local.shares, remote.shares),
    submissions: mergeById(local.submissions, remote.submissions, (l, r) =>
      l.updatedAt >= r.updatedAt ? l : r,
    ),
    feedbackNotes: mergeById(local.feedbackNotes, remote.feedbackNotes, (l, r) => {
      if (l.resolvedAt != null && r.resolvedAt == null) return l;
      if (r.resolvedAt != null && l.resolvedAt == null) return r;
      return l;
    }),
    aiLogs: mergeById(local.aiLogs, remote.aiLogs),
    scores: mergeBy(
      local.scores,
      remote.scores,
      (s) => s.submissionId,
      (l, r) => (l.createdAt >= r.createdAt ? l : r),
    ),
    stepTransitions: mergeById(local.stepTransitions, remote.stepTransitions),
    aiInteractions: mergeById(local.aiInteractions, remote.aiInteractions),
    teacherComments: mergeById(local.teacherComments, remote.teacherComments, (l, r) => {
      if (l.readAt != null && r.readAt == null) return l;
      if (r.readAt != null && l.readAt == null) return r;
      return l;
    }),
    tombstones: mergeTombstones(local.tombstones || [], remote.tombstones || []),
  };
  // tombstone에 매칭되는 엔티티를 cascade로 제거 → 부활 방지.
  return applyTombstones(merged);
}

/** 시트에서 최신 shares만 가져와 로컬에 머지(다른 교사의 활성 공유 인지용). */
export async function mergeRemoteSharesFromSheet(
  spreadsheetId?: string | null,
): Promise<TeacherDb | null> {
  const sid = spreadsheetId?.trim() || getActiveSpreadsheetId();
  if (!sid) return null;
  try {
    // 시트 lag로 share가 일시적으로 빈 결과로 보이는 경우를 막기 위해 retry.
    const result = await pullDbFromSheetWithRetry(sid, {
      attempts: 3,
      delayMs: 800,
    });
    if (!result.db) return null;
    const local = loadTeacherDb();
    const merged = mergeRemoteSharesIntoLocalDb(local, result.db as TeacherDb);
    saveTeacherDb(merged, { skipRemotePush: true });
    return merged;
  } catch (err) {
    console.warn("[Writing app] mergeRemoteSharesFromSheet failed:", err);
    return null;
  }
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

/**
 * 키 입력 자동저장용 — localStorage만 갱신하고 시트 push는 하지 않는다.
 * 학생이 명시적으로 "저장하기/제출하기"를 누를 때만 시트로 보낸다.
 */
export function updateSubmissionLocalOnly(
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
  saveTeacherDb({ ...db, submissions: nextSubmissions }, { skipRemotePush: true });
  return updated;
}

/**
 * 학생 명시 저장/제출용 — pre-pull merge 없이 localStorage 업데이트 후 시트 push 큐잉.
 * 키 입력당 한 번씩 발생하던 read 호출을 0회로 만들기 위한 핵심 path.
 */
export function updateSubmissionAndPushStudent(
  submissionId: string,
  patch: Partial<Submission>,
  options?: { spreadsheetId?: string | null },
): Submission {
  const sid = options?.spreadsheetId?.trim() || getActiveSpreadsheetId();
  if (sid) setActiveSpreadsheetId(sid);
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
  saveTeacherDb(
    { ...db, submissions: nextSubmissions },
    { spreadsheetId: sid, studentPush: true },
  );
  return updated;
}

/**
 * 시트의 submission 객체로 localStorage 항목을 통째 교체한다. 자동 sync에서 시트가
 * 더 최신일 때(다른 디바이스에서 작업한 결과 반영) 사용. updateSubmissionLocalOnly와
 * 달리 updatedAt을 Date.now()로 덮지 않고 시트 값을 그대로 보존하여 다음 mount 시
 * 비교 결과가 일관되게 유지된다.
 */
export function replaceSubmissionFromRemote(
  remoteSubmission: Submission,
): Submission {
  const db = loadTeacherDb();
  const idx = db.submissions.findIndex((s) => s.id === remoteSubmission.id);
  if (idx < 0) {
    saveTeacherDb(
      { ...db, submissions: [remoteSubmission, ...db.submissions] },
      { skipRemotePush: true },
    );
    return remoteSubmission;
  }
  const next = [...db.submissions];
  next[idx] = remoteSubmission;
  saveTeacherDb({ ...db, submissions: next }, { skipRemotePush: true });
  return remoteSubmission;
}

/**
 * 학생 partial endpoint(`db-set-submission`) 전용 path. 풀-DB push 대신 학생 자기
 * submission만 전송한다.
 *  - 시트 페이로드: 학생 1명분 → 9초 timeout 위험 사실상 0
 *  - 동시성: 다른 학생 행을 안 건드림 → race-free
 *
 * 인증 데이터(shareToken/studentNo/studentCode)는 share landing 단계에서 검증된
 * 값을 호출자가 전달한다. 서버에서도 students/shares 시트와 다시 대조한다.
 */
export function updateSubmissionAndPushPartial(
  submissionId: string,
  patch: Partial<Submission>,
  auth: {
    spreadsheetId: string;
    shareToken: string;
    studentNo: string;
    studentCode: string;
  },
): Submission {
  setActiveSpreadsheetId(auth.spreadsheetId);
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
  // localStorage는 정상적으로 갱신하되 풀-DB push는 막는다(partial endpoint가 대신 처리).
  saveTeacherDb(
    { ...db, submissions: nextSubmissions },
    { skipRemotePush: true },
  );
  pushSubmissionPartialCoalesced({
    spreadsheetId: auth.spreadsheetId,
    shareToken: auth.shareToken,
    studentNo: auth.studentNo,
    studentCode: auth.studentCode,
    submission: updated,
    // graspData는 patch에 들어 있을 때만 보낸다(없으면 undefined → 서버는 청크 그대로 둠).
    graspData: patch.graspData,
  });
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
  saveTeacherDb(next, { spreadsheetId: options?.spreadsheetId, studentPush: true });
}

/**
 * AI 로그 추가는 학생 path 전용. 같은 학생이 동시에 여러 디바이스에서 작업하지
 * 않으므로 push 직전 풀-DB pull은 quota만 소모할 뿐 의미가 없어 제거했다.
 * 호출자 시그니처(`await addAiLog(...)`)와 호환을 위해 async로 유지.
 */
export async function addAiLog(
  log: AiLog,
  options?: { spreadsheetId?: string | null },
) {
  const sid = options?.spreadsheetId?.trim() || getActiveSpreadsheetId();
  if (sid) setActiveSpreadsheetId(sid);
  const db = loadTeacherDb();
  saveTeacherDb(
    { ...db, aiLogs: [log, ...db.aiLogs] },
    { spreadsheetId: sid, studentPush: true },
  );
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
    { spreadsheetId: options?.spreadsheetId, studentPush: true },
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
    { spreadsheetId: options?.spreadsheetId, studentPush: true },
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
  saveTeacherDb(next, { spreadsheetId: options?.spreadsheetId, studentPush: true });
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
  saveTeacherDb(next, { spreadsheetId: options?.spreadsheetId, studentPush: true });
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

