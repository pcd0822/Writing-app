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
