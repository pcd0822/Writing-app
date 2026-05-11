import type { Handler } from "@netlify/functions";
import { z } from "zod";
import { handleOptions, json, parseJsonBody } from "./_utils";
import { readStudentScopedDb } from "./_supabaseDb";

// Student-facing endpoint. The previous implementation loaded the teacher's
// full TeacherDb via readTeacherDbForUser and filtered it in memory. With 30
// students hitting the share landing simultaneously that meant 30× the
// entire DB read, which saturated the Supabase pool and showed up as 502/
// 504 from the Netlify gateway.
//
// readStudentScopedDb (in _supabaseDb.ts) now does the narrow query path —
// just the assignment named by the token, its allocated classes' students,
// submissions for that assignment, and the calling student's own submission
// children. Response shape (a TeacherDb) is unchanged, so client merge code
// keeps working.
//
// If studentNo/studentCode are missing or wrong, every submission body is
// blanked and no child rows are returned. An attacker probing valid student
// codes therefore can't distinguish wrong-code from no-code by inspecting
// the response shape.

const BodySchema = z.object({
  shareToken: z.string().min(8),
  studentNo: z.string().min(1).optional(),
  studentCode: z.string().min(1).optional(),
});

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const parsed = parseJsonBody(event, BodySchema);
  if (!parsed.ok) return json(400, { error: parsed.error });

  const { shareToken, studentNo, studentCode } = parsed.data;

  try {
    const result = await readStudentScopedDb({ shareToken, studentNo, studentCode });
    if (!result.ok) return json(result.status, { error: result.error });
    return json(200, { db: result.db });
  } catch (e) {
    return json(500, { error: (e as Error).message || "share-bootstrap read failed" });
  }
};
