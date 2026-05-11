import type { Handler } from "@netlify/functions";
import { z } from "zod";
import { handleOptions, json, parseJsonBody } from "./_utils";
import { getSupabaseAdmin } from "./_supabase";
import { requireTeacher } from "./_firebaseAuth";

// Revoke every active share for an assignment in a single UPDATE.
// Replaces the old "revokeAllSharesForAssignment locally → push entire
// TeacherDb" path. Same motivation as supabase-share-create — full-DB
// upsert during peak student traffic was producing 502/504.
//
// Auth: Authorization: Bearer <Firebase ID token>. teacher_uid comes from
// the verified `sub` claim. The UPDATE is guarded by teacher_uid so a
// caller can never revoke another teacher's share even by guessing IDs.
//
// Semantics: matches revokeAllSharesForAssignment in src/lib/localDb.ts —
// all share rows for the given assignment with revoked_at IS NULL get
// stamped with the same revoked_at timestamp.

const BodySchema = z.object({
  assignmentId: z.string().min(1),
});

type RevokedRow = {
  token: string;
  assignment_id: string;
  revoked_at: number;
};

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const auth = await requireTeacher(event);
  if (!auth.ok) return json(auth.status, { error: auth.error });

  const parsed = parseJsonBody(event, BodySchema);
  if (!parsed.ok) return json(400, { error: parsed.error });

  const { assignmentId } = parsed.data;
  const teacherUid = auth.teacher.uid;
  const db = getSupabaseAdmin();

  try {
    const now = Date.now();
    const { data, error } = await db
      .from("share_links")
      .update({ revoked_at: now })
      .eq("assignment_id", assignmentId)
      .eq("teacher_uid", teacherUid)
      .is("revoked_at", null)
      .select("token, assignment_id, revoked_at");
    if (error) return json(500, { error: error.message });

    const rows = (data ?? []) as RevokedRow[];
    return json(200, {
      ok: true,
      revokedAt: now,
      revokedTokens: rows.map((r) => r.token),
    });
  } catch (e) {
    return json(500, { error: (e as Error).message || "supabase-share-revoke failed" });
  }
};
