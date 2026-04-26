import { getSheetsClient } from "./_sheets";
import {
  buildChunkSheetValues,
  buildSlimDbFromTabular,
  buildTabularSheetValues,
  isSheetDbV2Meta,
  isTabularSlimEmpty,
  MAX_CELL_CHARS,
  mergeChunksIntoDb,
  toSlimDbForMeta,
  wrapMetaPayload,
} from "./_sheetDbV2";
import type { TeacherDb } from "../../src/lib/types";
import { TeacherDbSchema } from "../../src/lib/types";

const CLEAR_SUFFIX = "!A1:Z50000";

/** v2 저장 시 한 번에 비울 범위(이전 행 잔여 제거) */
export function clearDataRanges(): string[] {
  return [
    `meta${CLEAR_SUFFIX}`,
    `assignment_text${CLEAR_SUFFIX}`,
    `submission_text${CLEAR_SUFFIX}`,
    `feedback_text${CLEAR_SUFFIX}`,
    `ai_log_text${CLEAR_SUFFIX}`,
    `score_text${CLEAR_SUFFIX}`,
    `extra_text${CLEAR_SUFFIX}`,
    `classes${CLEAR_SUFFIX}`,
    `students${CLEAR_SUFFIX}`,
    `assignments${CLEAR_SUFFIX}`,
    `assignment_targets${CLEAR_SUFFIX}`,
    `shares${CLEAR_SUFFIX}`,
    `submissions${CLEAR_SUFFIX}`,
    `feedback_notes${CLEAR_SUFFIX}`,
    `ai_logs${CLEAR_SUFFIX}`,
    `scores${CLEAR_SUFFIX}`,
  ];
}

function tryParseMeta(
  metaCell: string | undefined,
  chunks: {
    assignmentText: string[][];
    submissionText: string[][];
    feedbackText: string[][];
    aiLogText: string[][];
    scoreText: string[][];
    extraText: string[][];
  },
): TeacherDb | null {
  if (!metaCell?.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(metaCell);
  } catch {
    return null;
  }

  if (isSheetDbV2Meta(parsed)) {
    const slim = TeacherDbSchema.safeParse(parsed);
    if (!slim.success) return null;
    return mergeChunksIntoDb(slim.data, chunks);
  }

  // 구버전 호환: 메타가 v2 마커 없는 경우 그대로 시도
  const v = TeacherDbSchema.safeParse(parsed);
  return v.success ? v.data : null;
}

export async function readTeacherDbFromSpreadsheet(
  spreadsheetId: string,
): Promise<TeacherDb | null> {
  const sheets = getSheetsClient();
  const ranges = [
    "meta!A1",
    "assignment_text!A:D",
    "submission_text!A:D",
    "feedback_text!A:D",
    "ai_log_text!A:C",
    "score_text!A:C",
    "extra_text!A:D",
    // tabular fallback용 시트들
    "classes!A:C",
    "students!A:C",
    "assignments!A:C",
    "assignment_targets!A:D",
    "shares!A:F",
    "submissions!A:N",
    "feedback_notes!A:G",
    "ai_logs!A:E",
    "scores!A:F",
  ];

  const res = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges,
  });

  const valueRanges = res.data.valueRanges || [];
  const metaCell = valueRanges[0]?.values?.[0]?.[0] as string | undefined;

  const chunks = {
    assignmentText: (valueRanges[1]?.values || []) as string[][],
    submissionText: (valueRanges[2]?.values || []) as string[][],
    feedbackText: (valueRanges[3]?.values || []) as string[][],
    aiLogText: (valueRanges[4]?.values || []) as string[][],
    scoreText: (valueRanges[5]?.values || []) as string[][],
    extraText: (valueRanges[6]?.values || []) as string[][],
  };

  // 1) 빠른 경로: meta!A1에서 시도
  const fromMeta = tryParseMeta(metaCell, chunks);
  if (fromMeta) return fromMeta;

  // 2) Fallback: tabular 시트에서 재구성 (meta 비었거나 / 깨진 JSON / 구 스키마 등 모든 실패 시)
  const tabularSlim = buildSlimDbFromTabular({
    classes: (valueRanges[7]?.values || []) as string[][],
    students: (valueRanges[8]?.values || []) as string[][],
    assignments: (valueRanges[9]?.values || []) as string[][],
    assignment_targets: (valueRanges[10]?.values || []) as string[][],
    shares: (valueRanges[11]?.values || []) as string[][],
    submissions: (valueRanges[12]?.values || []) as string[][],
    feedback_notes: (valueRanges[13]?.values || []) as string[][],
    ai_logs: (valueRanges[14]?.values || []) as string[][],
    scores: (valueRanges[15]?.values || []) as string[][],
  });

  if (isTabularSlimEmpty(tabularSlim)) {
    console.warn("[Writing app] readTeacherDbFromSpreadsheet: meta 빈/실패 + tabular도 비어있음", {
      spreadsheetId,
      metaCellLen: metaCell?.length || 0,
      classesRows: (valueRanges[7]?.values || []).length,
      studentsRows: (valueRanges[8]?.values || []).length,
      assignmentsRows: (valueRanges[9]?.values || []).length,
    });
    // diag 정보를 던져서 db-get이 응답에 포함하도록 함
    const diag = {
      metaCellLen: metaCell?.length || 0,
      metaParsed: metaCell?.trim() ? !!tryParseMeta(metaCell, chunks) : false,
      tabularRowCounts: {
        classes: (valueRanges[7]?.values || []).length,
        students: (valueRanges[8]?.values || []).length,
        assignments: (valueRanges[9]?.values || []).length,
        submissions: (valueRanges[12]?.values || []).length,
      },
    };
    const err = new Error("EMPTY_DB");
    (err as Error & { diag?: unknown }).diag = diag;
    throw err;
  }

  const recovered = mergeChunksIntoDb(tabularSlim, chunks);

  console.info("[Writing app] readTeacherDbFromSpreadsheet: tabular fallback로 복원", {
    spreadsheetId,
    classes: recovered.classes.length,
    assignments: recovered.assignments.length,
    submissions: recovered.submissions.length,
  });

  // 다음 읽기 빠르게 하기 위해 meta에 write-back (best-effort)
  void writeTeacherDbToSpreadsheet(spreadsheetId, recovered).catch((err) => {
    console.error("[Writing app] meta write-back 실패:", err);
  });

  return recovered;
}

export async function writeTeacherDbToSpreadsheet(
  spreadsheetId: string,
  db: TeacherDb,
): Promise<void> {
  const sheets = getSheetsClient();
  const validated = TeacherDbSchema.parse(db);

  const slim = toSlimDbForMeta(validated);
  const metaPayload = wrapMetaPayload(slim);
  const metaStr = JSON.stringify(metaPayload);
  if (metaStr.length > MAX_CELL_CHARS) {
    throw new Error(
      `메타 JSON이 너무 큽니다(${metaStr.length}자). 구조 데이터(반·과제·배당 등)를 줄이거나 관리자에게 문의하세요. (한도 ${MAX_CELL_CHARS}자)`,
    );
  }

  const chunks = buildChunkSheetValues(validated);
  const tab = buildTabularSheetValues(validated);

  await sheets.spreadsheets.values.batchClear({
    spreadsheetId,
    requestBody: { ranges: clearDataRanges() },
  });

  const data: { range: string; values: string[][] }[] = [
    { range: "meta!A1", values: [[metaStr]] },
    { range: "assignment_text!A1", values: chunks.assignment_text },
    { range: "submission_text!A1", values: chunks.submission_text },
    { range: "feedback_text!A1", values: chunks.feedback_text },
    { range: "ai_log_text!A1", values: chunks.ai_log_text },
    { range: "score_text!A1", values: chunks.score_text },
    { range: "extra_text!A1", values: chunks.extra_text },
    { range: "classes!A1", values: tab.classes },
    { range: "students!A1", values: tab.students },
    { range: "assignments!A1", values: tab.assignments },
    { range: "assignment_targets!A1", values: tab.assignment_targets },
    { range: "shares!A1", values: tab.shares },
    { range: "submissions!A1", values: tab.submissions },
    { range: "feedback_notes!A1", values: tab.feedback_notes },
    { range: "ai_logs!A1", values: tab.ai_logs },
    { range: "scores!A1", values: tab.scores },
  ];

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "RAW",
      data,
    },
  });
}
