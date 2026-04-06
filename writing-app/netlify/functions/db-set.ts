import type { Handler } from "@netlify/functions";
import { z } from "zod";
import { ensureWorkbookStructure } from "./_sheets";
import { writeTeacherDbToSpreadsheet } from "./_sheetDbReadWrite";
import { TeacherDbSchema } from "../../src/lib/types";
import { handleOptions, json, parseJsonBody } from "./_utils";

const BodySchema = z.object({
  spreadsheetId: z.string().min(10),
  db: z.unknown(),
});

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const parsed = parseJsonBody(event, BodySchema);
  if (!parsed.ok) return json(400, { error: parsed.error });

  const dbParsed = TeacherDbSchema.safeParse(parsed.data.db);
  if (!dbParsed.success) {
    return json(400, { error: "db 형식이 올바르지 않습니다." });
  }

  try {
    const spreadsheetId = parsed.data.spreadsheetId;
    await ensureWorkbookStructure(spreadsheetId);
    await writeTeacherDbToSpreadsheet(spreadsheetId, dbParsed.data);
    return json(200, { ok: true });
  } catch (e) {
    return json(500, { error: (e as Error).message || "db-set failed" });
  }
};
