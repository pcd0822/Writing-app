import type { Handler } from "@netlify/functions";
import { z } from "zod";
import { handleOptions, json, parseJsonBody } from "./_utils";
import { getSupabaseAdmin } from "./_supabase";
import { requireTeacher } from "./_firebaseAuth";

// Owner-only. Revokes a pending or accepted invitation. The row stays in
// the table (status='revoked') so re-invites get a fresh id/token and
// audit history is preserved.
//
// Caller must own the row (owner_uid == caller). A collaborator wanting to
// step away should call supabase-collaborator-leave instead.

const BodySchema = z.object({ id: z.string().min(1) });

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const auth = await requireTeacher(event);
  if (!auth.ok) return json(auth.status, { error: auth.error });

  const parsed = parseJsonBody(event, BodySchema);
  if (!parsed.ok) return json(400, { error: parsed.error });

  const callerUid = auth.teacher.uid;
  const db = getSupabaseAdmin();
  const now = Date.now();

  const { data: row, error: fetchErr } = await db
    .from("teacher_collaborators")
    .select("id, owner_uid, status")
    .eq("id", parsed.data.id)
    .maybeSingle();
  if (fetchErr) return json(500, { error: fetchErr.message });
  if (!row) return json(404, { error: "해당 초대를 찾을 수 없습니다." });
  if ((row as { owner_uid: string }).owner_uid !== callerUid) {
    return json(403, { error: "본인이 보낸 초대만 해지할 수 있습니다." });
  }
  if ((row as { status: string }).status === "revoked") {
    return json(200, { ok: true, alreadyRevoked: true });
  }

  const { error: upErr } = await db
    .from("teacher_collaborators")
    .update({ status: "revoked", revoked_at: now, invite_token: null })
    .eq("id", parsed.data.id);
  if (upErr) return json(500, { error: upErr.message });

  return json(200, { ok: true });
};
