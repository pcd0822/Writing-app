import type { Handler } from "@netlify/functions";
import { z } from "zod";
import { TeacherDbSchema } from "../../src/lib/types";
import { handleOptions, json, parseJsonBody } from "./_utils";
import { writeTeacherDbForUser } from "./_supabaseDb";
import { requireTeacher } from "./_firebaseAuth";
import { resolveDataOwnerUid } from "./_collaborators";

// Supabase counterpart of db-set.ts.
//
// Auth: Authorization: Bearer <Firebase ID token>. The uid we write rows
// against comes from the verified token, never the body. A wrong/forged
// uid is therefore impossible — the client owns no key that could be
// substituted.
//
// Note: this endpoint upserts every entity in the incoming TeacherDb but
// does NOT delete rows that are missing from it. Multi-device coalescing
// pushes used to delete entities by absence; under Supabase we expose
// explicit delete endpoints in Phase 3 so two devices don't wipe each
// other's recent additions.

const BodySchema = z.object({
  db: z.unknown(),
});

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const auth = await requireTeacher(event);
  if (!auth.ok) return json(auth.status, { error: auth.error });

  const parsed = parseJsonBody(event, BodySchema);
  if (!parsed.ok) return json(400, { error: parsed.error });

  const dbParsed = TeacherDbSchema.safeParse(parsed.data.db);
  if (!dbParsed.success) {
    return json(400, { error: "db 형식이 올바르지 않습니다." });
  }

  try {
    const ownerUid = await resolveDataOwnerUid(auth.teacher.uid);
    await writeTeacherDbForUser(ownerUid, dbParsed.data);
    return json(200, { ok: true });
  } catch (e) {
    return json(500, { error: (e as Error).message || "supabase-db-set failed" });
  }
};
