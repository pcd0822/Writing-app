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
    return json(500, { error: (e as Error).message || "db-get failed" });
  }
};
