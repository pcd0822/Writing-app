import type { Handler } from "@netlify/functions";
import { handleOptions, json } from "./_utils";
import { getSupabaseAdmin } from "./_supabase";
import { requireTeacher } from "./_firebaseAuth";

// Collaborator-side leave. Sets the caller's accepted row to 'revoked' so
// the partial UNIQUE INDEX is freed and they can accept another invite
// (or return to their own workspace). The owner is unaffected and can
// re-invite later if needed.
//
// No body. We resolve the row from the caller's uid alone — the single
// accepted row invariant guarantees there's at most one.

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const auth = await requireTeacher(event);
  if (!auth.ok) return json(auth.status, { error: auth.error });

  const callerUid = auth.teacher.uid;
  const db = getSupabaseAdmin();
  const now = Date.now();

  const { data: row, error: fetchErr } = await db
    .from("teacher_collaborators")
    .select("id")
    .eq("collaborator_uid", callerUid)
    .eq("status", "accepted")
    .maybeSingle();
  if (fetchErr) return json(500, { error: fetchErr.message });
  if (!row) return json(404, { error: "참여 중인 워크스페이스가 없습니다." });

  const { error: upErr } = await db
    .from("teacher_collaborators")
    .update({ status: "revoked", revoked_at: now })
    .eq("id", (row as { id: string }).id);
  if (upErr) return json(500, { error: upErr.message });

  return json(200, { ok: true });
};
