import type { Handler } from "@netlify/functions";
import { randomBytes } from "crypto";
import { z } from "zod";
import { handleOptions, json, parseJsonBody } from "./_utils";
import { getSupabaseAdmin } from "./_supabase";
import { requireTeacher } from "./_firebaseAuth";
import { resolveDataOwnerUid } from "./_collaborators";

// Owner-only. Creates a teacher_collaborators row in 'pending' state.
//
// Modes (exactly one of email / link is required):
//   email: the row is matched and auto-accepted when a teacher with that
//          email logs in.
//   link : the row is matched explicitly when the recipient opens
//          /teacher/invite/<token>.
//
// expiresAt is optional. If provided, accept-time checks reject expired
// rows. The token is server-generated (24 bytes ≈ 192 bits entropy) so
// clients can't predict or pick it.

const BodySchema = z
  .object({
    email: z.string().email().optional(),
    mode: z.enum(["email", "link"]),
    expiresAt: z.number().int().positive().optional(),
  })
  .refine(
    (v) => (v.mode === "email" ? !!v.email : true),
    { message: "email 모드는 email 필드가 필요합니다." },
  );

function generateInviteToken(): string {
  return randomBytes(24).toString("base64url");
}

function generateRowId(): string {
  return randomBytes(9).toString("base64url");
}

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const auth = await requireTeacher(event);
  if (!auth.ok) return json(auth.status, { error: auth.error });

  const parsed = parseJsonBody(event, BodySchema);
  if (!parsed.ok) return json(400, { error: parsed.error });

  const callerUid = auth.teacher.uid;
  // Owner-only. A collaborator can't re-invite others on the owner's behalf.
  const ownerUid = await resolveDataOwnerUid(callerUid);
  if (ownerUid !== callerUid) {
    return json(403, {
      error: "공동 교사 권한 부여는 워크스페이스 소유자만 가능합니다.",
    });
  }

  const db = getSupabaseAdmin();
  const now = Date.now();
  const id = generateRowId();
  const emailNormalised = parsed.data.email?.trim().toLowerCase() ?? null;

  // Block self-invite.
  if (emailNormalised && auth.teacher.email && emailNormalised === auth.teacher.email.toLowerCase()) {
    return json(400, { error: "본인 계정에는 권한을 부여할 수 없습니다." });
  }

  const row = {
    id,
    owner_uid: callerUid,
    collaborator_uid: null as string | null,
    collaborator_email: emailNormalised,
    invite_token: parsed.data.mode === "link" ? generateInviteToken() : null,
    status: "pending" as const,
    created_at: now,
    accepted_at: null as number | null,
    revoked_at: null as number | null,
    expires_at: parsed.data.expiresAt ?? null,
  };

  const { data: inserted, error } = await db
    .from("teacher_collaborators")
    .insert(row as never)
    .select("*")
    .single();
  if (error) {
    // 23505 = unique_violation. Hits when (owner, email) already has a
    // pending row — surface a friendly message rather than the DB string.
    const code = (error as { code?: string }).code;
    if (code === "23505") {
      return json(409, {
        error: "이미 같은 이메일로 보낸 대기 중 초대가 있습니다.",
      });
    }
    return json(500, { error: error.message });
  }

  return json(200, { ok: true, invite: inserted });
};
