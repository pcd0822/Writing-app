import type { Handler } from "@netlify/functions";
import { z } from "zod";
import { ensureWorkbookStructure } from "./_sheets";
import { readTeacherDbFromSpreadsheet } from "./_sheetDbReadWrite";
import { handleOptions, json, parseJsonBody } from "./_utils";

const BodySchema = z.object({
  spreadsheetId: z.string().min(10),
});

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const parsed = parseJsonBody(event, BodySchema);
  if (!parsed.ok) return json(400, { error: parsed.error });

  try {
    const spreadsheetId = parsed.data.spreadsheetId;
    await ensureWorkbookStructure(spreadsheetId);
    const db = await readTeacherDbFromSpreadsheet(spreadsheetId);
    return json(200, { db });
  } catch (e) {
    const err = e as Error & { diag?: unknown };
    if (err.message === "EMPTY_DB") {
      // 시트는 읽었으나 복원할 데이터가 없음 — 진단 정보를 포함해 200으로 돌려줌
      return json(200, { db: null, diag: err.diag ?? null });
    }
    return json(500, { error: err.message || "db-get failed" });
  }
};
