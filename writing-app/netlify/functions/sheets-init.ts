import type { Handler } from "@netlify/functions";
import { z } from "zod";
import { ensureWorkbookStructure } from "./_sheets";
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
    await ensureWorkbookStructure(parsed.data.spreadsheetId);
    return json(200, { ok: true });
  } catch (e) {
    return json(500, { error: (e as Error).message || "init failed" });
  }
};

