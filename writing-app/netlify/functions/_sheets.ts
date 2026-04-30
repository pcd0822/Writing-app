import { getSheetsClient } from "./_googleAuth";

export { getSheetsClient } from "./_googleAuth";

/**
 * 워밍업된 Lambda 인스턴스에서 동일 스프레드시트에 대해 ensureWorkbookStructure를
 * 다시 호출할 필요가 없도록 process-local 캐시. 시트 추가는 멱등적이고 외부에서
 * 시트가 삭제되어도 다음 콜드 스타트에서 다시 검증되므로 안전.
 */
const ensuredWorkbooks = new Set<string>();

/**
 * 시트 title → numeric sheetId 매핑 캐시. spreadsheets.batchUpdate(values 아님)는
 * GridRange에 sheetId(숫자)가 필요해서 매번 spreadsheets.get을 부르지 않도록
 * 워밍 인스턴스에서 재사용.
 */
const sheetIdCache = new Map<string, Map<string, number>>();

const WANTED_SHEETS = [
  "meta",
  "classes",
  "students",
  "assignments",
  "assignment_targets",
  "shares",
  "submissions",
  "feedback_notes",
  "ai_logs",
  "scores",
  /** v2: 긴 텍스트 청크 (셀 5만자 제한 분할) */
  "assignment_text",
  "submission_text",
  "feedback_text",
  "ai_log_text",
  "score_text",
  /** v5: AI 활용 이력·교사 코멘트·GRASP 등 추가 텍스트 */
  "extra_text",
] as const;

function buildIdMap(meta: {
  data: { sheets?: Array<{ properties?: { title?: string | null; sheetId?: number | null } }> };
}): Map<string, number> {
  const map = new Map<string, number>();
  for (const s of meta.data.sheets || []) {
    const title = s.properties?.title;
    const id = s.properties?.sheetId;
    if (title && typeof id === "number") map.set(title, id);
  }
  return map;
}

export async function ensureWorkbookStructure(spreadsheetId: string) {
  if (ensuredWorkbooks.has(spreadsheetId)) return;

  const sheets = getSheetsClient();
  const meta = await sheets.spreadsheets.get(
    { spreadsheetId, fields: "sheets.properties.title,sheets.properties.sheetId" },
    { timeout: 8500 },
  );
  const existing = new Set(
    (meta.data.sheets || []).map((s) => s.properties?.title),
  );

  const toAdd = WANTED_SHEETS.filter((t) => !existing.has(t));
  if (toAdd.length === 0) {
    sheetIdCache.set(spreadsheetId, buildIdMap(meta));
    ensuredWorkbooks.add(spreadsheetId);
    return;
  }

  const addRes = await sheets.spreadsheets.batchUpdate(
    {
      spreadsheetId,
      requestBody: {
        requests: toAdd.map((title) => ({
          addSheet: { properties: { title } },
        })),
      },
    },
    { timeout: 8500 },
  );

  // 새로 추가된 시트의 sheetId를 응답에서 회수
  const idMap = buildIdMap(meta);
  for (const reply of addRes.data.replies || []) {
    const props = reply.addSheet?.properties;
    if (props?.title && typeof props?.sheetId === "number") {
      idMap.set(props.title, props.sheetId);
    }
  }
  sheetIdCache.set(spreadsheetId, idMap);
  ensuredWorkbooks.add(spreadsheetId);
}

/** 캐시된 title→sheetId 매핑. 캐시 미스면 spreadsheets.get으로 1회 fetch. */
export async function getSheetIdMap(
  spreadsheetId: string,
): Promise<Map<string, number>> {
  const cached = sheetIdCache.get(spreadsheetId);
  if (cached) return cached;
  const sheets = getSheetsClient();
  const meta = await sheets.spreadsheets.get(
    { spreadsheetId, fields: "sheets.properties.title,sheets.properties.sheetId" },
    { timeout: 8500 },
  );
  const map = buildIdMap(meta);
  sheetIdCache.set(spreadsheetId, map);
  return map;
}
