import { getSupabaseAdmin } from "./_supabase";

// ─────────────────────────────────────────────────────────────────────────
// Co-teacher resolution.
//
// Data ownership stays partitioned by teacher_uid in every existing table
// (classes/assignments/share_links/...). Collaboration is layered on top by
// resolveDataOwnerUid: if the caller has an ACCEPTED row in
// teacher_collaborators, every data endpoint acts as if the caller were the
// owner_uid named in that row.
//
// Why a layer instead of repartitioning: keeps the 502-storm hot path
// (share-bootstrap / writeTeacherDbForUser) and all student auth code
// untouched. Rolling back the feature = empty the table.
//
// Single-workspace invariant (DB-enforced via partial UNIQUE index): a
// caller has at most one accepted row, so the lookup is unambiguous.
// ─────────────────────────────────────────────────────────────────────────

export type CollaboratorRow = {
  id: string;
  owner_uid: string;
  collaborator_uid: string | null;
  collaborator_email: string | null;
  invite_token: string | null;
  status: "pending" | "accepted" | "revoked";
  created_at: number;
  accepted_at: number | null;
  revoked_at: number | null;
  expires_at: number | null;
};

/**
 * Returns the data-owner uid for a given caller. If the caller has accepted
 * an invitation, returns the inviter's uid. Otherwise returns the caller's
 * own uid (they are operating on their own workspace).
 *
 * NOT cached — collaborator state changes mid-session (accept/leave/revoke)
 * and a stale cache would silently route writes to the wrong workspace.
 */
export async function resolveDataOwnerUid(callerUid: string): Promise<string> {
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("teacher_collaborators")
    .select("owner_uid")
    .eq("collaborator_uid", callerUid)
    .eq("status", "accepted")
    .maybeSingle();
  if (error) {
    // Treat as "no collaboration" rather than blocking the request entirely
    // — the failure surface for ordinary teachers acting on their own data
    // is then unchanged by this feature. The error is still logged for ops.
    console.warn("[collaborators] resolveDataOwnerUid lookup failed:", error.message);
    return callerUid;
  }
  if (data && typeof (data as { owner_uid?: string }).owner_uid === "string") {
    return (data as { owner_uid: string }).owner_uid;
  }
  return callerUid;
}

/**
 * Convenience: returns whether the caller is acting as the owner of the
 * resolved workspace. Used by owner-only endpoints (invite/revoke/migrate).
 */
export async function isWorkspaceOwner(callerUid: string): Promise<boolean> {
  const ownerUid = await resolveDataOwnerUid(callerUid);
  return ownerUid === callerUid;
}
