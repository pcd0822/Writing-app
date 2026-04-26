/**
 * 스프레드시트 저장 v2: meta!A1 한 셀(5만자 제한)을 피하기 위해
 * 긴 텍스트는 청크 시트에, 메타·표 시트에는 구조화된 행으로 기록합니다.
 */
import type { TeacherDb } from "../../src/lib/types";
import { prepareDbForSheetPush } from "../../src/lib/attachments";

export const SHEET_DB_VERSION = 2;
/** 구글 시트 셀당 최대 문자 수(여유 두고 49900) */
export const MAX_CELL_CHARS = 49_900;

export function chunkText(s: string): string[] {
  if (!s) return [];
  const parts: string[] = [];
  for (let i = 0; i < s.length; i += MAX_CELL_CHARS) {
    parts.push(s.slice(i, i + MAX_CELL_CHARS));
  }
  return parts;
}

export function concatChunks(parts: string[]): string {
  return parts.join("");
}

function sliceChunkRows(rows: string[][], headerFirstValues: string[]) {
  if (
    rows.length > 0 &&
    headerFirstValues.every((v, i) => rows[0]![i] === v)
  ) {
    return rows.slice(1);
  }
  return rows;
}

function parseKeyFieldChunks(rows: string[][], header: string[]): Map<string, string> {
  const data = sliceChunkRows(rows, header);
  const byKey = new Map<string, { idx: number; text: string }[]>();
  for (const row of data) {
    const id = String(row[0] ?? "");
    const field = String(row[1] ?? "");
    const partIdx = parseInt(String(row[2] ?? "0"), 10);
    const content = String(row[3] ?? "");
    if (!id) continue;
    const key = `${id}\t${field}`;
    let list = byKey.get(key);
    if (!list) {
      list = [];
      byKey.set(key, list);
    }
    list.push({ idx: Number.isFinite(partIdx) ? partIdx : 0, text: content });
  }
  const out = new Map<string, string>();
  for (const [key, list] of byKey) {
    list.sort((a, b) => a.idx - b.idx);
    out.set(key, concatChunks(list.map((x) => x.text)));
  }
  return out;
}

function parseScoreTextRows(rows: string[][]): Map<string, string> {
  const data = sliceChunkRows(rows, ["submissionId", "partIndex", "content"]);
  const bySub = new Map<string, { idx: number; text: string }[]>();
  for (const row of data) {
    const subId = String(row[0] ?? "");
    const partIdx = parseInt(String(row[1] ?? "0"), 10);
    const content = String(row[2] ?? "");
    if (!subId) continue;
    let list = bySub.get(subId);
    if (!list) {
      list = [];
      bySub.set(subId, list);
    }
    list.push({ idx: Number.isFinite(partIdx) ? partIdx : 0, text: content });
  }
  const out = new Map<string, string>();
  for (const [subId, list] of bySub) {
    list.sort((a, b) => a.idx - b.idx);
    out.set(subId, concatChunks(list.map((x) => x.text)));
  }
  return out;
}

function parseAiLogTextRows(rows: string[][]): Map<string, string> {
  const data = sliceChunkRows(rows, ["logId", "partIndex", "content"]);
  const byLog = new Map<string, { idx: number; text: string }[]>();
  for (const row of data) {
    const logId = String(row[0] ?? "");
    const partIdx = parseInt(String(row[1] ?? "0"), 10);
    const content = String(row[2] ?? "");
    if (!logId) continue;
    let list = byLog.get(logId);
    if (!list) {
      list = [];
      byLog.set(logId, list);
    }
    list.push({ idx: Number.isFinite(partIdx) ? partIdx : 0, text: content });
  }
  const out = new Map<string, string>();
  for (const [logId, list] of byLog) {
    list.sort((a, b) => a.idx - b.idx);
    out.set(logId, concatChunks(list.map((x) => x.text)));
  }
  return out;
}

/** API에서 받은 values (빈 시트는 undefined) */
export function mergeChunksIntoDb(
  slim: TeacherDb,
  chunks: {
    assignmentText: string[][];
    submissionText: string[][];
    feedbackText: string[][];
    aiLogText: string[][];
    scoreText: string[][];
    extraText?: string[][];
  },
): TeacherDb {
  const assignParts = parseKeyFieldChunks(chunks.assignmentText, [
    "assignmentId",
    "field",
    "partIndex",
    "content",
  ]);
  const subParts = parseKeyFieldChunks(chunks.submissionText, [
    "submissionId",
    "field",
    "partIndex",
    "content",
  ]);
  const fbParts = parseKeyFieldChunks(chunks.feedbackText, [
    "noteId",
    "field",
    "partIndex",
    "content",
  ]);
  const aiParts = parseAiLogTextRows(chunks.aiLogText);
  const scoreParts = parseScoreTextRows(chunks.scoreText);

  // extra_text: aiInteraction prompt/response, teacherComment text, graspData 등
  const extraParts = chunks.extraText
    ? parseKeyFieldChunks(chunks.extraText, ["id", "field", "partIndex", "content"])
    : new Map<string, string>();

  const assignments = slim.assignments.map((a) => ({
    ...a,
    prompt: assignParts.get(`${a.id}\tprompt`) ?? "",
    task: assignParts.get(`${a.id}\ttask`) ?? "",
  }));

  const submissions = slim.submissions.map((s) => ({
    ...s,
    outlineText: subParts.get(`${s.id}\toutline`) ?? "",
    draftText: subParts.get(`${s.id}\tdraft`) ?? "",
    reviseText: subParts.get(`${s.id}\trevise`) ?? "",
    finalReportSnapshot: subParts.get(`${s.id}\tfinalSnapshot`) ?? "",
    graspData: extraParts.get(`sub:${s.id}\tgraspData`) ?? s.graspData ?? "",
  }));

  const feedbackNotes = slim.feedbackNotes.map((n) => ({
    ...n,
    teacherText: fbParts.get(`${n.id}\tteacherText`) ?? "",
    anchorText: fbParts.get(`${n.id}\tanchorText`) ?? "",
  }));

  const aiLogs = slim.aiLogs.map((l) => ({
    ...l,
    text: aiParts.get(l.id) ?? "",
  }));

  const scores = slim.scores.map((sc) => ({
    ...sc,
    teacherSummary: scoreParts.get(sc.submissionId) ?? sc.teacherSummary ?? "",
  }));

  const aiInteractions = (slim.aiInteractions || []).map((i) => ({
    ...i,
    prompt: extraParts.get(`ai:${i.id}\tprompt`) ?? i.prompt ?? "",
    response: extraParts.get(`ai:${i.id}\tresponse`) ?? i.response ?? "",
  }));

  const teacherComments = (slim.teacherComments || []).map((c) => ({
    ...c,
    text: extraParts.get(`tc:${c.id}\ttext`) ?? c.text ?? "",
  }));

  const { sheetDbVersion: _v, ...rest } = slim as TeacherDb & {
    sheetDbVersion?: number;
  };
  void _v;
  return {
    ...rest,
    assignments,
    submissions,
    feedbackNotes,
    aiLogs,
    scores,
    aiInteractions,
    teacherComments,
  };
}

/** 긴 필드는 비운 TeacherDb (meta JSON용) */
export function toSlimDbForMeta(db: TeacherDb): TeacherDb {
  const prepared = prepareDbForSheetPush(db);
  return {
    ...prepared,
    assignments: prepared.assignments.map((a) => ({
      ...a,
      prompt: "",
      task: "",
    })),
    submissions: prepared.submissions.map((s) => ({
      ...s,
      outlineText: "",
      draftText: "",
      reviseText: "",
      finalReportSnapshot: "",
      graspData: "", // chunk로 분리
    })),
    feedbackNotes: prepared.feedbackNotes.map((n) => ({
      ...n,
      teacherText: "",
      anchorText: "",
    })),
    aiLogs: prepared.aiLogs.map((l) => ({
      ...l,
      text: "",
    })),
    scores: prepared.scores.map((sc) => ({
      ...sc,
      teacherSummary: "",
    })),
    aiInteractions: (prepared.aiInteractions || []).map((i) => ({
      ...i,
      prompt: "", // chunk로 분리
      response: "", // chunk로 분리
    })),
    teacherComments: (prepared.teacherComments || []).map((c) => ({
      ...c,
      text: "", // chunk로 분리
    })),
  };
}

export function wrapMetaPayload(slim: TeacherDb & { sheetDbVersion?: number }) {
  return {
    ...slim,
    sheetDbVersion: SHEET_DB_VERSION,
  };
}

export function isSheetDbV2Meta(parsed: unknown): parsed is { sheetDbVersion: number } {
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    "sheetDbVersion" in parsed &&
    (parsed as { sheetDbVersion: number }).sheetDbVersion === SHEET_DB_VERSION
  );
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}

function rowsAfterHeader(rows: string[][]): string[][] {
  if (rows.length === 0) return [];
  // 첫 행이 헤더(첫 칸이 'id'/'classId'/'token'/'submissionId'/'assignmentId' 등)면 스킵
  const first = String(rows[0]?.[0] ?? "").toLowerCase();
  const looksLikeHeader = ["id", "classid", "token", "submissionid", "assignmentid", "noteid", "logid"].includes(first);
  return looksLikeHeader ? rows.slice(1) : rows;
}

/**
 * meta!A1이 비어 있을 때, 표 시트(classes/students/assignments/...)에서 slim DB를 재구성합니다.
 * 청크 시트 결합은 이후 mergeChunksIntoDb가 처리합니다.
 */
export function buildSlimDbFromTabular(tab: {
  classes: string[][];
  students: string[][];
  assignments: string[][];
  assignment_targets: string[][];
  shares: string[][];
  submissions: string[][];
  feedback_notes: string[][];
  ai_logs: string[][];
  scores: string[][];
}): TeacherDb {
  // classes (id, name, createdAt) + students (classId, studentNo, studentCode)
  const studentsByClass = new Map<string, { studentNo: string; studentCode: string }[]>();
  for (const row of rowsAfterHeader(tab.students)) {
    const classId = String(row[0] ?? "");
    const studentNo = String(row[1] ?? "");
    const studentCode = String(row[2] ?? "");
    if (!classId || !studentNo) continue;
    let list = studentsByClass.get(classId);
    if (!list) {
      list = [];
      studentsByClass.set(classId, list);
    }
    list.push({ studentNo, studentCode });
  }
  const classes = rowsAfterHeader(tab.classes)
    .map((row) => {
      const id = String(row[0] ?? "");
      const name = String(row[1] ?? "");
      const createdAt = num(row[2]) ?? Date.now();
      if (!id || !name) return null;
      return {
        id,
        name,
        createdAt,
        students: studentsByClass.get(id) || [],
      };
    })
    .filter((x): x is NonNullable<typeof x> => !!x);

  // assignments (id, title, createdAt) — prompt/task는 비워두고 청크에서 채움
  const assignments = rowsAfterHeader(tab.assignments)
    .map((row) => {
      const id = String(row[0] ?? "");
      const title = String(row[1] ?? "");
      const createdAt = num(row[2]) ?? Date.now();
      if (!id || !title) return null;
      return {
        id,
        title,
        prompt: "",
        task: "",
        attachments: [],
        createdAt,
      };
    })
    .filter((x): x is NonNullable<typeof x> => !!x);

  // assignment_targets (assignmentId, targetType, classId, studentNo)
  const targetsByAssignment = new Map<string, ({ type: "class"; classId: string } | { type: "student"; classId: string; studentNo: string })[]>();
  for (const row of rowsAfterHeader(tab.assignment_targets)) {
    const assignmentId = String(row[0] ?? "");
    const targetType = String(row[1] ?? "");
    const classId = String(row[2] ?? "");
    const studentNo = String(row[3] ?? "");
    if (!assignmentId || !classId) continue;
    let list = targetsByAssignment.get(assignmentId);
    if (!list) {
      list = [];
      targetsByAssignment.set(assignmentId, list);
    }
    if (targetType === "class") {
      list.push({ type: "class", classId });
    } else if (targetType === "student" && studentNo) {
      list.push({ type: "student", classId, studentNo });
    }
  }
  const allocations = Array.from(targetsByAssignment.entries()).map(([assignmentId, targets]) => ({
    assignmentId,
    targets,
  }));

  // shares (token, assignmentId, createdAt, expiresAt, revokedAt, spreadsheetId)
  const shares = rowsAfterHeader(tab.shares)
    .map((row) => {
      const token = String(row[0] ?? "");
      const assignmentId = String(row[1] ?? "");
      const createdAt = num(row[2]) ?? Date.now();
      const expiresAt = num(row[3]) ?? Date.now() + 7 * 24 * 60 * 60 * 1000;
      const revokedAt = num(row[4]);
      const spreadsheetId = String(row[5] ?? "");
      if (!token || !assignmentId) return null;
      return {
        token,
        assignmentId,
        createdAt,
        expiresAt,
        revokedAt,
        ...(spreadsheetId ? { spreadsheetId } : {}),
      };
    })
    .filter((x): x is NonNullable<typeof x> => !!x);

  // submissions (id, assignmentId, classId, studentNo, createdAt, updatedAt, ...timestamps)
  const submissions = rowsAfterHeader(tab.submissions)
    .map((row) => {
      const id = String(row[0] ?? "");
      const assignmentId = String(row[1] ?? "");
      const classId = String(row[2] ?? "");
      const studentNo = String(row[3] ?? "");
      if (!id || !assignmentId || !classId || !studentNo) return null;
      return {
        id,
        assignmentId,
        classId,
        studentNo,
        createdAt: num(row[4]) ?? Date.now(),
        updatedAt: num(row[5]) ?? Date.now(),
        outlineText: "",
        draftText: "",
        reviseText: "",
        outlineSubmittedAt: num(row[6]),
        draftSubmittedAt: num(row[7]),
        reviseSubmittedAt: num(row[8]),
        outlineApprovedAt: num(row[9]),
        draftApprovedAt: num(row[10]),
        reviseApprovedAt: num(row[11]),
        finalApprovedAt: num(row[12]),
        finalReportPublishedAt: num(row[13]),
        finalReportSnapshot: "",
        graspData: "",
        outlineRejectReason: "",
        draftRejectReason: "",
        reviseRejectReason: "",
        currentStep: 1,
      };
    })
    .filter((x): x is NonNullable<typeof x> => !!x);

  // feedback_notes (id, submissionId, stage, createdAt, start, end, resolvedAt)
  const feedbackNotes = rowsAfterHeader(tab.feedback_notes)
    .map((row) => {
      const id = String(row[0] ?? "");
      const submissionId = String(row[1] ?? "");
      const stage = String(row[2] ?? "");
      if (!id || !submissionId) return null;
      if (stage !== "outline" && stage !== "draft" && stage !== "revise") return null;
      return {
        id,
        submissionId,
        stage: stage as "outline" | "draft" | "revise",
        createdAt: num(row[3]) ?? Date.now(),
        start: num(row[4]) ?? 0,
        end: num(row[5]) ?? 0,
        resolvedAt: num(row[6]),
        teacherText: "",
        anchorText: "",
      };
    })
    .filter((x): x is NonNullable<typeof x> => !!x);

  // ai_logs (id, submissionId, stage, createdAt, role)
  const aiLogs = rowsAfterHeader(tab.ai_logs)
    .map((row) => {
      const id = String(row[0] ?? "");
      const submissionId = String(row[1] ?? "");
      const stage = String(row[2] ?? "");
      const role = String(row[4] ?? "");
      if (!id || !submissionId) return null;
      if (stage !== "outline" && stage !== "draft" && stage !== "revise") return null;
      if (role !== "student" && role !== "assistant") return null;
      return {
        id,
        submissionId,
        stage: stage as "outline" | "draft" | "revise",
        createdAt: num(row[3]) ?? Date.now(),
        role: role as "student" | "assistant",
        text: "",
      };
    })
    .filter((x): x is NonNullable<typeof x> => !!x);

  // scores (submissionId, createdAt, score, outlineScore, draftScore, reviseScore)
  const scores = rowsAfterHeader(tab.scores)
    .map((row) => {
      const submissionId = String(row[0] ?? "");
      if (!submissionId) return null;
      return {
        submissionId,
        createdAt: num(row[1]) ?? Date.now(),
        score: num(row[2]),
        outlineScore: num(row[3]),
        draftScore: num(row[4]),
        reviseScore: num(row[5]),
        teacherSummary: "",
        isFinalized: false,
      };
    })
    .filter((x): x is NonNullable<typeof x> => !!x);

  return {
    version: 5,
    classes,
    assignments,
    allocations,
    shares,
    submissions,
    feedbackNotes,
    aiLogs,
    scores,
    stepTransitions: [],
    aiInteractions: [],
    teacherComments: [],
  };
}

export function isTabularSlimEmpty(slim: TeacherDb): boolean {
  return (
    (slim.classes?.length || 0) === 0 &&
    (slim.assignments?.length || 0) === 0 &&
    (slim.submissions?.length || 0) === 0
  );
}

function pushChunks4(id: string, field: string, text: string, out: string[][]) {
  const parts = chunkText(text);
  parts.forEach((content, partIndex) => {
    out.push([id, field, String(partIndex), content]);
  });
}

/** 청크 시트용 행 (헤더 포함) */
export function buildChunkSheetValues(db: TeacherDb): {
  assignment_text: string[][];
  submission_text: string[][];
  feedback_text: string[][];
  ai_log_text: string[][];
  score_text: string[][];
  extra_text: string[][];
} {
  const assignment_text: string[][] = [
    ["assignmentId", "field", "partIndex", "content"],
  ];
  const submission_text: string[][] = [
    ["submissionId", "field", "partIndex", "content"],
  ];
  const feedback_text: string[][] = [
    ["noteId", "field", "partIndex", "content"],
  ];
  const ai_log_text: string[][] = [["logId", "partIndex", "content"]];
  const score_text: string[][] = [["submissionId", "partIndex", "content"]];
  const extra_text: string[][] = [["id", "field", "partIndex", "content"]];

  for (const a of db.assignments) {
    pushChunks4(a.id, "prompt", a.prompt, assignment_text);
    pushChunks4(a.id, "task", a.task, assignment_text);
  }
  for (const s of db.submissions) {
    pushChunks4(s.id, "outline", s.outlineText, submission_text);
    pushChunks4(s.id, "draft", s.draftText, submission_text);
    pushChunks4(s.id, "revise", s.reviseText, submission_text);
    pushChunks4(s.id, "finalSnapshot", s.finalReportSnapshot ?? "", submission_text);
    // graspData를 extra_text 청크로 저장
    if (s.graspData) {
      pushChunks4(`sub:${s.id}`, "graspData", s.graspData, extra_text);
    }
  }
  for (const n of db.feedbackNotes) {
    pushChunks4(n.id, "teacherText", n.teacherText, feedback_text);
    pushChunks4(n.id, "anchorText", n.anchorText, feedback_text);
  }
  for (const l of db.aiLogs) {
    const parts = chunkText(l.text);
    parts.forEach((content, partIndex) => {
      ai_log_text.push([l.id, String(partIndex), content]);
    });
  }
  for (const sc of db.scores) {
    const parts = chunkText(sc.teacherSummary ?? "");
    parts.forEach((content, partIndex) => {
      score_text.push([sc.submissionId, String(partIndex), content]);
    });
  }
  // aiInteractions의 prompt/response를 extra_text 청크로 저장
  for (const i of (db.aiInteractions || [])) {
    if (i.prompt) pushChunks4(`ai:${i.id}`, "prompt", i.prompt, extra_text);
    if (i.response) pushChunks4(`ai:${i.id}`, "response", i.response, extra_text);
  }
  // teacherComments의 text를 extra_text 청크로 저장
  for (const c of (db.teacherComments || [])) {
    if (c.text) pushChunks4(`tc:${c.id}`, "text", c.text, extra_text);
  }

  return {
    assignment_text,
    submission_text,
    feedback_text,
    ai_log_text,
    score_text,
    extra_text,
  };
}

/** 사람이 보기 좋은 표 시트 (메타 JSON과 중복되나, 열람용) */
export function buildTabularSheetValues(db: TeacherDb): {
  classes: string[][];
  students: string[][];
  assignments: string[][];
  assignment_targets: string[][];
  shares: string[][];
  submissions: string[][];
  feedback_notes: string[][];
  ai_logs: string[][];
  scores: string[][];
} {
  const prepared = prepareDbForSheetPush(db);

  const classes: string[][] = [["id", "name", "createdAt"]];
  for (const c of prepared.classes) {
    classes.push([c.id, c.name, String(c.createdAt)]);
  }

  const students: string[][] = [["classId", "studentNo", "studentCode"]];
  for (const c of prepared.classes) {
    for (const st of c.students) {
      students.push([c.id, st.studentNo, st.studentCode]);
    }
  }

  const assignments: string[][] = [["id", "title", "createdAt"]];
  for (const a of prepared.assignments) {
    assignments.push([a.id, a.title, String(a.createdAt)]);
  }

  const assignment_targets: string[][] = [
    ["assignmentId", "targetType", "classId", "studentNo"],
  ];
  for (const al of prepared.allocations) {
    for (const t of al.targets) {
      if (t.type === "class") {
        assignment_targets.push([al.assignmentId, "class", t.classId, ""]);
      } else {
        assignment_targets.push([
          al.assignmentId,
          "student",
          t.classId,
          t.studentNo,
        ]);
      }
    }
  }

  const shares: string[][] = [
    ["token", "assignmentId", "createdAt", "expiresAt", "revokedAt", "spreadsheetId"],
  ];
  for (const sh of prepared.shares) {
    shares.push([
      sh.token,
      sh.assignmentId,
      String(sh.createdAt),
      String(sh.expiresAt),
      sh.revokedAt != null ? String(sh.revokedAt) : "",
      sh.spreadsheetId ?? "",
    ]);
  }

  const submissions: string[][] = [
    [
      "id",
      "assignmentId",
      "classId",
      "studentNo",
      "createdAt",
      "updatedAt",
      "outlineSubmittedAt",
      "draftSubmittedAt",
      "reviseSubmittedAt",
      "outlineApprovedAt",
      "draftApprovedAt",
      "reviseApprovedAt",
      "finalApprovedAt",
      "finalReportPublishedAt",
    ],
  ];
  for (const s of prepared.submissions) {
    submissions.push([
      s.id,
      s.assignmentId,
      s.classId,
      s.studentNo,
      String(s.createdAt),
      String(s.updatedAt),
      s.outlineSubmittedAt != null ? String(s.outlineSubmittedAt) : "",
      s.draftSubmittedAt != null ? String(s.draftSubmittedAt) : "",
      s.reviseSubmittedAt != null ? String(s.reviseSubmittedAt) : "",
      s.outlineApprovedAt != null ? String(s.outlineApprovedAt) : "",
      s.draftApprovedAt != null ? String(s.draftApprovedAt) : "",
      s.reviseApprovedAt != null ? String(s.reviseApprovedAt) : "",
      s.finalApprovedAt != null ? String(s.finalApprovedAt) : "",
      s.finalReportPublishedAt != null ? String(s.finalReportPublishedAt) : "",
    ]);
  }

  const feedback_notes: string[][] = [
    ["id", "submissionId", "stage", "createdAt", "start", "end", "resolvedAt"],
  ];
  for (const n of prepared.feedbackNotes) {
    feedback_notes.push([
      n.id,
      n.submissionId,
      n.stage,
      String(n.createdAt),
      String(n.start),
      String(n.end),
      n.resolvedAt != null ? String(n.resolvedAt) : "",
    ]);
  }

  const ai_logs: string[][] = [
    ["id", "submissionId", "stage", "createdAt", "role"],
  ];
  for (const l of prepared.aiLogs) {
    ai_logs.push([
      l.id,
      l.submissionId,
      l.stage,
      String(l.createdAt),
      l.role,
    ]);
  }

  const scores: string[][] = [
    [
      "submissionId",
      "createdAt",
      "score",
      "outlineScore",
      "draftScore",
      "reviseScore",
    ],
  ];
  for (const sc of prepared.scores) {
    scores.push([
      sc.submissionId,
      String(sc.createdAt),
      sc.score != null ? String(sc.score) : "",
      sc.outlineScore != null ? String(sc.outlineScore) : "",
      sc.draftScore != null ? String(sc.draftScore) : "",
      sc.reviseScore != null ? String(sc.reviseScore) : "",
    ]);
  }

  return {
    classes,
    students,
    assignments,
    assignment_targets,
    shares,
    submissions,
    feedback_notes,
    ai_logs,
    scores,
  };
}
