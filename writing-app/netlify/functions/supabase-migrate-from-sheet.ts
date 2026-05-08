import type { Handler } from "@netlify/functions";
import { z } from "zod";
import { ensureWorkbookStructure } from "./_sheets";
import { readTeacherDbFromSpreadsheet } from "./_sheetDbReadWrite";
import { writeTeacherDbForUser } from "./_supabaseDb";
import { handleOptions, json, parseJsonBody } from "./_utils";
import { requireTeacher } from "./_firebaseAuth";

// One-shot migration: read a teacher's full DB out of Google Sheets and
// upsert it into Supabase under the verified Firebase UID. Idempotent —
// safe to re-run if a partial failure leaves things in a mixed state.
//
// Request:  POST  Authorization: Bearer <Firebase ID token>
//                 body: { spreadsheetId }
// Response: 200   { ok: true, counts: {...} }      — migrated successfully
//           200   { ok: true, counts: null, diag } — sheet had no data
//           4xx/5xx { error }
//
// The teacher_uid we write under is taken from the verified token, so a
// teacher cannot accidentally migrate a sheet they don't own into another
// teacher's account: the destination is always *their own* uid.

const BodySchema = z.object({
  spreadsheetId: z.string().min(10),
});

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const auth = await requireTeacher(event);
  if (!auth.ok) return json(auth.status, { error: auth.error });

  const parsed = parseJsonBody(event, BodySchema);
  if (!parsed.ok) return json(400, { error: parsed.error });

  try {
    await ensureWorkbookStructure(parsed.data.spreadsheetId);
    const db = await readTeacherDbFromSpreadsheet(parsed.data.spreadsheetId);
    if (!db) {
      // Sheet readable but produced no recoverable data (e.g. brand new
      // workbook). Same outcome as the EMPTY_DB catch below.
      return json(200, { ok: true, counts: null });
    }

    await writeTeacherDbForUser(auth.teacher.uid, db);

    return json(200, {
      ok: true,
      counts: {
        classes: db.classes.length,
        students: db.classes.reduce((n, c) => n + c.students.length, 0),
        assignments: db.assignments.length,
        allocations: db.allocations.length,
        shares: db.shares.length,
        submissions: db.submissions.length,
        feedbackNotes: db.feedbackNotes.length,
        aiLogs: db.aiLogs.length,
        scores: db.scores.length,
        stepTransitions: db.stepTransitions.length,
        aiInteractions: db.aiInteractions.length,
        teacherComments: db.teacherComments.length,
        tombstones: db.tombstones.length,
      },
    });
  } catch (e) {
    const err = e as Error & { diag?: unknown };
    // Sheet exists but yielded no recoverable data — treat as a no-op
    // success so the caller can show "이 시트에 옮길 데이터가 없습니다".
    if (err.message === "EMPTY_DB") {
      return json(200, { ok: true, counts: null, diag: err.diag ?? null });
    }
    return json(500, {
      error: err.message || "supabase-migrate-from-sheet failed",
    });
  }
};
