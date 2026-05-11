import type { Handler } from "@netlify/functions";
import { z } from "zod";
import { ensureWorkbookStructure } from "./_sheets";
import { writeTeacherDbToSpreadsheet } from "./_sheetDbReadWrite";
import { readTeacherDbForUser } from "./_supabaseDb";
import { handleOptions, json, parseJsonBody } from "./_utils";
import { requireTeacher } from "./_firebaseAuth";
import { resolveDataOwnerUid } from "./_collaborators";

// Reverse of supabase-migrate-from-sheet: dump the teacher's current
// Supabase DB into the named spreadsheet. This is the "manual sheet
// backup" the teacher chose over continuous mirroring — they hit the
// button when they want a fresh sheet snapshot to read offline,
// share with another teacher, or feed into another spreadsheet-driven
// workflow.
//
// Idempotent: writeTeacherDbToSpreadsheet rewrites the workbook from
// scratch, so re-running just refreshes the sheet to match Supabase.

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
    const ownerUid = await resolveDataOwnerUid(auth.teacher.uid);
    const db = await readTeacherDbForUser(ownerUid);
    const isEmpty =
      db.classes.length === 0 &&
      db.assignments.length === 0 &&
      db.shares.length === 0 &&
      db.submissions.length === 0;
    if (isEmpty) {
      // 빈 Supabase로 시트를 통째로 덮어쓰면 기존 시트 데이터까지 날아간다.
      // 명시적으로 막고 caller가 알 수 있게 200 + counts:null로 알린다.
      return json(200, { ok: true, counts: null });
    }

    await ensureWorkbookStructure(parsed.data.spreadsheetId);
    await writeTeacherDbToSpreadsheet(parsed.data.spreadsheetId, db);

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
    return json(500, {
      error: (e as Error).message || "supabase-export-to-sheet failed",
    });
  }
};
