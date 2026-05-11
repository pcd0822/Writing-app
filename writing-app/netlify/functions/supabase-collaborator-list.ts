import type { Handler } from "@netlify/functions";
import { handleOptions, json } from "./_utils";
import { getSupabaseAdmin } from "./_supabase";
import { requireTeacher } from "./_firebaseAuth";

// Lists the caller's collaborator state. Always returns three buckets so
// the client can render the management UI in one round-trip:
//
//   asOwner:    rows where caller is owner_uid — the people this caller has
//               invited (pending) or granted (accepted). Includes revoked
//               rows from the past 30 days so the UI can show recent audit.
//   asMember:   the row (at most one) where caller is collaborator_uid and
//               status='accepted'. Null when the caller is operating on
//               their own data.
//   incoming:   pending rows matching caller's email but not yet accepted.
//               The UI can surface "you have a pending invite from X" here.
//
// No body. Auth: Authorization: Bearer <Firebase ID token>.

const AUDIT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const auth = await requireTeacher(event);
  if (!auth.ok) return json(auth.status, { error: auth.error });

  const callerUid = auth.teacher.uid;
  const callerEmail = auth.teacher.email?.toLowerCase() ?? null;
  const db = getSupabaseAdmin();
  const auditSince = Date.now() - AUDIT_WINDOW_MS;

  // Three queries in parallel — small rows, no joins.
  const [asOwnerRes, asMemberRes, incomingRes] = await Promise.all([
    db
      .from("teacher_collaborators")
      .select("*")
      .eq("owner_uid", callerUid)
      .or(`status.neq.revoked,revoked_at.gte.${auditSince}`)
      .order("created_at", { ascending: false }),
    db
      .from("teacher_collaborators")
      .select("*")
      .eq("collaborator_uid", callerUid)
      .eq("status", "accepted")
      .maybeSingle(),
    callerEmail
      ? db
          .from("teacher_collaborators")
          .select("*")
          .eq("collaborator_email", callerEmail)
          .eq("status", "pending")
          .is("collaborator_uid", null)
      : Promise.resolve({ data: [], error: null }),
  ]);

  const errs = [asOwnerRes.error, asMemberRes.error, incomingRes.error].filter(Boolean);
  if (errs.length > 0) {
    return json(500, { error: errs.map((e) => e!.message).join("; ") });
  }

  return json(200, {
    ok: true,
    asOwner: asOwnerRes.data ?? [],
    asMember: asMemberRes.data ?? null,
    incoming: incomingRes.data ?? [],
  });
};
