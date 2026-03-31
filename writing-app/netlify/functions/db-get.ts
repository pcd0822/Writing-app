import type { Handler } from "@netlify/functions";
import { z } from "zod";
import { ensureWorkbookStructure, getSheetsClient } from "./_sheets";
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
    const sheets = getSheetsClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "meta!A1",
    });
    const cell = res.data.values?.[0]?.[0] as string | undefined;
    if (!cell) return json(200, { db: null });
    const db = JSON.parse(cell);
    return json(200, { db });
  } catch (e) {
    return json(500, { error: (e as Error).message || "db-get failed" });
  }
};

