import { getSheetsClient, getSheetIdMap } from "./_sheets";
import {
  buildChunkSheetValues,
  buildSlimDbFromTabular,
  buildTabularSheetValues,
  isSheetDbV2Meta,
  isTabularSlimEmpty,
  MAX_CELL_CHARS,
  mergeChunksIntoDb,
  parseTabularSubmissions,
  toSlimDbForMeta,
  wrapMetaPayload,
} from "./_sheetDbV2";
import type { Submission, TeacherDb } from "../../src/lib/types";
import { TeacherDbSchema } from "../../src/lib/types";

/**
 * Google Sheets 호출이 무한 대기하지 않도록 transport-level timeout. Netlify
 * 무료 플랜의 함수 timeout은 10초이므로 그보다 짧게 설정해서, 시트가 느릴 때
 * lambda 자체가 죽어 502가 나는 대신 우리 핸들러가 catch해 500을 반환하게 한다.
 */
const SHEETS_RPC_TIMEOUT_MS = 9000;
const SHEETS_RPC_OPTS = { timeout: SHEETS_RPC_TIMEOUT_MS } as const;

/**
 * meta!A1을 파싱해 slim DB를 반환. 청크 머지는 호출자가 별도로 mergeChunksIntoDb를
 * 호출해 처리한다(meta 경로에서 tabular submissions union을 끼워넣기 위함).
 */
function tryParseSlimMeta(metaCell: string | undefined): TeacherDb | null {
  if (!metaCell?.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(metaCell);
  } catch {
    return null;
  }

  if (isSheetDbV2Meta(parsed)) {
    const slim = TeacherDbSchema.safeParse(parsed);
    return slim.success ? slim.data : null;
  }

  // 구버전 호환: 메타가 v2 마커 없는 경우 그대로 시도
  const v = TeacherDbSchema.safeParse(parsed);
  return v.success ? v.data : null;
}

/**
 * meta의 submissions와 tabular의 submissions를 id 기준 union. 같은 id가 양쪽에 있으면
 * tabular 우선(partial endpoint가 항상 tabular를 fresh하게 갱신하므로). meta에만
 * 있는 submission은 그대로 두어 풀-DB push로 들어온 데이터를 보존.
 */
function unionSubmissions(
  metaSubs: TeacherDb["submissions"],
  tabularSubs: Submission[],
): TeacherDb["submissions"] {
  const byId = new Map<string, Submission>();
  for (const s of metaSubs) byId.set(s.id, s);
  for (const s of tabularSubs) byId.set(s.id, s);
  return Array.from(byId.values());
}

export async function readTeacherDbFromSpreadsheet(
  spreadsheetId: string,
): Promise<TeacherDb | null> {
  const sheets = getSheetsClient();
  const ranges = [
    // meta는 단일 셀(50k자 한도)을 넘어 학급/과제/제출이 늘어나면 push가 통째로
    // 실패하던 문제를 해결하기 위해 meta!A 컬럼 여러 행으로 청크 분할 저장한다.
    // 읽을 때는 모든 행을 순서대로 이어붙여 단일 JSON 문자열로 복원.
    "meta!A:A",
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

  const res = await sheets.spreadsheets.values.batchGet(
    {
      spreadsheetId,
      ranges,
    },
    SHEETS_RPC_OPTS,
  );

  const valueRanges = res.data.valueRanges || [];
  // meta!A 컬럼의 모든 행을 순서대로 이어붙여 단일 JSON 문자열로 복원.
  // 옛 단일 셀 저장 방식과도 호환(행이 1개면 결과는 그 셀과 동일).
  const metaRows = (valueRanges[0]?.values || []) as string[][];
  const metaCell = metaRows.map((row) => String(row[0] ?? "")).join("") || undefined;

  const chunks = {
    assignmentText: (valueRanges[1]?.values || []) as string[][],
    submissionText: (valueRanges[2]?.values || []) as string[][],
    feedbackText: (valueRanges[3]?.values || []) as string[][],
    aiLogText: (valueRanges[4]?.values || []) as string[][],
    scoreText: (valueRanges[5]?.values || []) as string[][],
    extraText: (valueRanges[6]?.values || []) as string[][],
  };

  // submissions 표 시트는 meta 경로에서도 사용한다.
  // partial update endpoint(`db-set-submission`)는 meta!A1을 안 건드리고 이 시트와
  // 청크만 갱신하므로, meta만 보면 다른 디바이스에서 partial로 추가된 submission이
  // 누락된다. 따라서 meta 경로에서도 이 시트를 함께 union한다.
  const tabularSubmissions = parseTabularSubmissions(
    (valueRanges[12]?.values || []) as string[][],
  );

  // 1) 빠른 경로: meta!A1에서 slim 추출 + tabular submissions union → 청크 머지
  const slimFromMeta = tryParseSlimMeta(metaCell);
  if (slimFromMeta) {
    const mergedSlim: TeacherDb = {
      ...slimFromMeta,
      submissions: unionSubmissions(slimFromMeta.submissions, tabularSubmissions),
    };
    return mergeChunksIntoDb(mergedSlim, chunks);
  }

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
      metaParsed: metaCell?.trim() ? !!tryParseSlimMeta(metaCell) : false,
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

/**
 * 한 시트의 (clear + write)를 한 쌍의 updateCells request로 변환.
 *  - 첫 request: 시트 전체 영역의 userEnteredValue를 비움(rows 미지정 → 빈 셀로 설정)
 *  - 두 번째 request: 새 데이터 작성
 *
 * 같은 spreadsheets.batchUpdate 안에 들어가므로 atomic — 부분 실패가 발생할 수 없다.
 * (이전엔 batchClear 후 별도 batchUpdate를 await했고, 둘 사이에서 lambda timeout이
 * 발생하면 시트가 비워진 채로 새 데이터가 안 들어가 데이터 손실이 났다.)
 */
function buildSheetWriteRequests(
  sheetId: number,
  values: string[][],
): unknown[] {
  const reqs: unknown[] = [
    {
      updateCells: {
        range: { sheetId, startRowIndex: 0, startColumnIndex: 0 },
        fields: "userEnteredValue",
      },
    },
  ];
  if (values.length > 0 && values[0]!.length > 0) {
    reqs.push({
      updateCells: {
        start: { sheetId, rowIndex: 0, columnIndex: 0 },
        rows: values.map((row) => ({
          values: row.map((cell) => ({
            userEnteredValue: { stringValue: String(cell ?? "") },
          })),
        })),
        fields: "userEnteredValue",
      },
    });
  }
  return reqs;
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

  // meta JSON을 단일 셀(50k자 한도) 대신 meta!A 컬럼의 여러 행에 청크로 저장.
  // 학급·과제·제출이 늘어나도 push가 통째로 실패하지 않도록 한다(이전엔 한도 초과
  // 시 throw → 코얼레싱 push 전체 실패 → 교사 승인이 시트에 도달하지 못해 학생
  // 화면이 영영 다음 단계로 못 넘어가는 사고가 있었음).
  const metaValues: string[][] = [];
  if (metaStr.length === 0) {
    metaValues.push([""]);
  } else {
    for (let i = 0; i < metaStr.length; i += MAX_CELL_CHARS) {
      metaValues.push([metaStr.slice(i, i + MAX_CELL_CHARS)]);
    }
  }

  const chunks = buildChunkSheetValues(validated);
  const tab = buildTabularSheetValues(validated);

  const idMap = await getSheetIdMap(spreadsheetId);

  const sheetData: { title: string; values: string[][] }[] = [
    { title: "meta", values: metaValues },
    { title: "assignment_text", values: chunks.assignment_text },
    { title: "submission_text", values: chunks.submission_text },
    { title: "feedback_text", values: chunks.feedback_text },
    { title: "ai_log_text", values: chunks.ai_log_text },
    { title: "score_text", values: chunks.score_text },
    { title: "extra_text", values: chunks.extra_text },
    { title: "classes", values: tab.classes },
    { title: "students", values: tab.students },
    { title: "assignments", values: tab.assignments },
    { title: "assignment_targets", values: tab.assignment_targets },
    { title: "shares", values: tab.shares },
    { title: "submissions", values: tab.submissions },
    { title: "feedback_notes", values: tab.feedback_notes },
    { title: "ai_logs", values: tab.ai_logs },
    { title: "scores", values: tab.scores },
  ];

  const requests: unknown[] = [];
  const missing: string[] = [];
  for (const { title, values } of sheetData) {
    const id = idMap.get(title);
    if (id == null) {
      missing.push(title);
      continue;
    }
    requests.push(...buildSheetWriteRequests(id, values));
  }

  if (missing.length > 0) {
    throw new Error(
      `시트 ID 매핑 누락: ${missing.join(", ")}. 잠시 후 다시 시도하면 자동 복구됩니다.`,
    );
  }

  await sheets.spreadsheets.batchUpdate(
    {
      spreadsheetId,
      requestBody: { requests: requests as never },
    },
    SHEETS_RPC_OPTS,
  );
}
