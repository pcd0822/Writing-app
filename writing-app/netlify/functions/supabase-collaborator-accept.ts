import type { Handler } from "@netlify/functions";
import { z } from "zod";
import { handleOptions, json, parseJsonBody } from "./_utils";
import { getSupabaseAdmin } from "./_supabase";
import { requireTeacher } from "./_firebaseAuth";
import type { CollaboratorRow } from "./_collaborators";

// Accept an invitation. Two paths:
//   { token }  — link-based. The token alone identifies a pending row.
//                The accepting caller becomes collaborator_uid; their email
//                is stamped onto the row for audit.
//   { byEmail: true } — email-based. The caller's verified email is
//                matched against pending rows. Used by the auto-accept call
//                the client makes after teacher login.
//
// Invariants:
//   * Caller cannot become collaborator_uid of their own pending row
//     (owner != collaborator). The DB CHECK plus a server-side guard here.
//   * A teacher can have at most one accepted row (DB-enforced UNIQUE
//     INDEX). If they already collaborate elsewhere, return 409 with a
//     clear message so the client can offer "leave current first".

const BodySchema = z.union([
  z.object({ token: z.string().min(8) }),
  z.object({ byEmail: z.literal(true) }),
]);

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const auth = await requireTeacher(event);
  if (!auth.ok) return json(auth.status, { error: auth.error });

  const parsed = parseJsonBody(event, BodySchema);
  if (!parsed.ok) return json(400, { error: parsed.error });

  const callerUid = auth.teacher.uid;
  const callerEmail = auth.teacher.email?.toLowerCase() ?? null;
  const db = getSupabaseAdmin();
  const now = Date.now();

  // 1) Find the candidate pending row.
  let candidate: CollaboratorRow | null = null;
  if ("token" in parsed.data) {
    const { data, error } = await db
      .from("teacher_collaborators")
      .select("*")
      .eq("invite_token", parsed.data.token)
      .maybeSingle();
    if (error) return json(500, { error: error.message });
    candidate = (data as CollaboratorRow | null) ?? null;
  } else {
    if (!callerEmail) {
      return json(400, {
        error: "이메일 클레임이 토큰에 없습니다. Google 계정으로 다시 로그인해주세요.",
      });
    }
    const { data, error } = await db
      .from("teacher_collaborators")
      .select("*")
      .eq("collaborator_email", callerEmail)
      .eq("status", "pending")
      .is("collaborator_uid", null)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) return json(500, { error: error.message });
    candidate = ((data ?? [])[0] as CollaboratorRow | undefined) ?? null;
  }

  if (!candidate) {
    return json(404, { error: "유효한 초대를 찾을 수 없습니다." });
  }
  if (candidate.status === "revoked") {
    return json(403, { error: "이 초대는 해지되었습니다." });
  }
  if (candidate.status === "accepted") {
    // Already accepted — idempotent success only when the same caller is
    // the one who accepted. Otherwise treat as taken.
    if (candidate.collaborator_uid === callerUid) {
      return json(200, { ok: true, invite: candidate, alreadyAccepted: true });
    }
    return json(409, { error: "이 초대는 이미 다른 계정에서 수락되었습니다." });
  }
  if (typeof candidate.expires_at === "number" && candidate.expires_at < now) {
    return json(410, { error: "초대가 만료되었습니다." });
  }
  if (candidate.owner_uid === callerUid) {
    return json(400, { error: "본인이 보낸 초대는 수락할 수 없습니다." });
  }

  // 2) Email-bound link: if the row carries an email, only that email can
  //    accept (defence-in-depth against leaked tokens).
  if (
    candidate.collaborator_email &&
    callerEmail &&
    candidate.collaborator_email !== callerEmail
  ) {
    return json(403, {
      error: "이 초대는 다른 이메일에 부여되었습니다.",
    });
  }

  // 3) Single-workspace check. The partial UNIQUE INDEX already enforces
  //    this at the DB level, but a clean 409 is friendlier than a unique
  //    violation surfacing through the message string.
  const { data: existing, error: existErr } = await db
    .from("teacher_collaborators")
    .select("id, owner_uid")
    .eq("collaborator_uid", callerUid)
    .eq("status", "accepted")
    .maybeSingle();
  if (existErr) return json(500, { error: existErr.message });
  if (existing) {
    return json(409, {
      error:
        "이미 다른 워크스페이스의 공동 교사로 참여 중입니다. 먼저 그 워크스페이스를 떠나주세요.",
      currentMembership: existing,
    });
  }

  // 4) Accept. Stamp uid + email + accepted_at.
  const { data: updated, error: upErr } = await db
    .from("teacher_collaborators")
    .update({
      collaborator_uid: callerUid,
      collaborator_email: candidate.collaborator_email ?? callerEmail,
      status: "accepted",
      accepted_at: now,
    })
    .eq("id", candidate.id)
    .eq("status", "pending")
    .select("*")
    .single();
  if (upErr) {
    const code = (upErr as { code?: string }).code;
    if (code === "23505") {
      return json(409, {
        error: "이미 다른 워크스페이스의 공동 교사로 참여 중입니다.",
      });
    }
    return json(500, { error: upErr.message });
  }

  return json(200, { ok: true, invite: updated });
};
