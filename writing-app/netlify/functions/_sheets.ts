import { getSheetsClient } from "./_googleAuth";

export { getSheetsClient } from "./_googleAuth";

/**
 * 워밍업된 Lambda 인스턴스에서 동일 스프레드시트에 대해 ensureWorkbookStructure를
 * 다시 호출할 필요가 없도록 process-local 캐시. 시트 추가는 멱등적이고 외부에서
 * 시트가 삭제되어도 다음 콜드 스타트에서 다시 검증되므로 안전.
 */
const ensuredWorkbooks = new Set<string>();

export async function ensureWorkbookStructure(spreadsheetId: string) {
  if (ensuredWorkbooks.has(spreadsheetId)) return;

  const sheets = getSheetsClient();
  const meta = await sheets.spreadsheets.get(
    { spreadsheetId },
    { timeout: 8500 },
  );
  const existing = new Set((meta.data.sheets || []).map((s) => s.properties?.title));

  const wanted = [
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
  ];

  const toAdd = wanted.filter((t) => !existing.has(t));
  if (toAdd.length === 0) {
    ensuredWorkbooks.add(spreadsheetId);
    return;
  }

  await sheets.spreadsheets.batchUpdate(
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
  ensuredWorkbooks.add(spreadsheetId);
}
