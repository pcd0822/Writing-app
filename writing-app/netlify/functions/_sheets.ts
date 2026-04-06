import { getSheetsClient } from "./_googleAuth";

export { getSheetsClient } from "./_googleAuth";

export async function ensureWorkbookStructure(spreadsheetId: string) {
  const sheets = getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
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
  ];

  const toAdd = wanted.filter((t) => !existing.has(t));
  if (toAdd.length === 0) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: toAdd.map((title) => ({
        addSheet: { properties: { title } },
      })),
    },
  });
}
