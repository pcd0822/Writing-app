import { getSheetsClient } from "./_sheets";
import {
  buildChunkSheetValues,
  buildTabularSheetValues,
  isSheetDbV2Meta,
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
  ];

  const res = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges,
  });

  const valueRanges = res.data.valueRanges || [];
  const metaCell = valueRanges[0]?.values?.[0]?.[0] as string | undefined;
  if (!metaCell?.trim()) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(metaCell);
  } catch {
    return null;
  }

  if (!isSheetDbV2Meta(parsed)) {
    const v = TeacherDbSchema.safeParse(parsed);
    return v.success ? v.data : null;
  }

  const slim = TeacherDbSchema.safeParse(parsed);
  if (!slim.success) return null;

  const assignmentText = (valueRanges[1]?.values || []) as string[][];
  const submissionText = (valueRanges[2]?.values || []) as string[][];
  const feedbackText = (valueRanges[3]?.values || []) as string[][];
  const aiLogText = (valueRanges[4]?.values || []) as string[][];
  const scoreText = (valueRanges[5]?.values || []) as string[][];

  return mergeChunksIntoDb(slim.data, {
    assignmentText,
    submissionText,
    feedbackText,
    aiLogText,
    scoreText,
  });
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
