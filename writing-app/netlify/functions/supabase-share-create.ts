import type { Handler } from "@netlify/functions";
import { randomBytes } from "crypto";
import { z } from "zod";
import { handleOptions, json, parseJsonBody } from "./_utils";
import { getSupabaseAdmin } from "./_supabase";
import { requireTeacher } from "./_firebaseAuth";

// Create a single share_links row for an assignment the calling teacher
// owns. Replaces the old "createShareLink locally → push entire TeacherDb"
// path that ran writeTeacherDbForUser (15 sequential upserts) just to add
// one row. With 30 students hitting share-bootstrap at the same moment,
// that long write competed for the same Supabase connection pool and
// surfaced as `assignments upsert: upstream connect error` / 502 / 504.
// Here we touch share_links only.
//
// Auth: Authorization: Bearer <Firebase ID token>. teacher_uid is taken
// from the verified `sub` claim, never the request body.
//
// Idempotency: if an active (revoked_at IS NULL AND expires_at > now)
// share already exists for the assignment, we return that one instead of
// inserting a duplicate. Mirrors the client's existing "이미 활성 공유가
// 존재합니다" guard so two devices opening the share modal don't both
// mint new tokens.

const BodySchema = z.object({
  assignmentId: z.string().min(1),
  expiresAt: z.number().int().positive(),
  spreadsheetId: z.string().optional(),
});

// 12 base64url chars ≈ 72 bits entropy — same shape as the existing
// nanoid(12) tokens the client used to mint, and within ShareLinkSchema's
// min(10) validation.
function generateShareToken(): string {
  return randomBytes(9).toString("base64url");
}

type ShareRow = {
  token: string;
  teacher_uid: string;
  assignment_id: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  spreadsheet_id: string | null;
};

function rowToShare(row: ShareRow) {
  const out: {
    token: string;
    assignmentId: string;
    createdAt: number;
    expiresAt: number;
    revokedAt: number | null;
    spreadsheetId?: string;
  } = {
    token: row.token,
    assignmentId: row.assignment_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
  if (row.spreadsheet_id) out.spreadsheetId = row.spreadsheet_id;
  return out;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const auth = await requireTeacher(event);
  if (!auth.ok) return json(auth.status, { error: auth.error });

  const parsed = parseJsonBody(event, BodySchema);
  if (!parsed.ok) return json(400, { error: parsed.error });

  const { assignmentId, expiresAt, spreadsheetId } = parsed.data;
  const teacherUid = auth.teacher.uid;
  const db = getSupabaseAdmin();

  try {
    // 1) Verify the assignment belongs to this teacher. share_links has a
    //    FK to assignments(id), so a bad assignmentId would 23503 below
    //    anyway — but checking ownership separately gives a clean 403 and
    //    blocks tokens being minted for assignments owned by other
    //    teachers (which the FK alone wouldn't catch).
    const { data: assignment, error: aErr } = await db
      .from("assignments")
      .select("id")
      .eq("id", assignmentId)
      .eq("teacher_uid", teacherUid)
      .maybeSingle();
    if (aErr) return json(500, { error: aErr.message });
    if (!assignment) return json(403, { error: "이 과제는 다른 교사 소유입니다." });

    // 2) Reuse an existing active share if one is still valid. Two teacher
    //    devices opening the share modal in quick succession would
    //    otherwise both mint tokens; reusing here matches the client-side
    //    "이미 활성 공유 링크가 존재합니다" guard without the heavy
    //    pre-pull merge that path used to do.
    const now = Date.now();
    const { data: existing, error: existErr } = await db
      .from("share_links")
      .select("*")
      .eq("assignment_id", assignmentId)
      .eq("teacher_uid", teacherUid)
      .is("revoked_at", null)
      .gt("expires_at", now)
      .order("created_at", { ascending: false })
      .limit(1);
    if (existErr) return json(500, { error: existErr.message });
    if (existing && existing.length > 0) {
      return json(200, {
        ok: true,
        reused: true,
        share: rowToShare(existing[0] as ShareRow),
      });
    }

    // 3) Insert. token is generated server-side so clients can't pick or
    //    predict it. createdAt is server time so two devices' clock skew
    //    can't push a future-dated share that orders ahead of others.
    const row: ShareRow = {
      token: generateShareToken(),
      teacher_uid: teacherUid,
      assignment_id: assignmentId,
      created_at: now,
      expires_at: expiresAt,
      revoked_at: null,
      spreadsheet_id: spreadsheetId ?? null,
    };
    const { data: inserted, error: insErr } = await db
      .from("share_links")
      .insert(row as never)
      .select("*")
      .single();
    if (insErr) return json(500, { error: insErr.message });

    return json(200, {
      ok: true,
      reused: false,
      share: rowToShare(inserted as ShareRow),
    });
  } catch (e) {
    return json(500, { error: (e as Error).message || "supabase-share-create failed" });
  }
};
