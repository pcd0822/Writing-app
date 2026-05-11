import type { Handler } from "@netlify/functions";
import { z } from "zod";
import { handleOptions, json, parseJsonBody } from "./_utils";
import { getSupabaseAdmin } from "./_supabase";
import { requireTeacher } from "./_firebaseAuth";
import { resolveDataOwnerUid } from "./_collaborators";

// Hard-delete a class / assignment / submission / share link, owned by the
// authenticated teacher. Children cascade via FK constraints, so a single
// DELETE wipes the whole subtree (e.g. deleting a class also drops its
// students, submissions, feedback notes, AI logs, …). A tombstone row is
// inserted (where applicable) so any device still holding stale local
// state for the same id can detect the deletion on next sync and prune it.
//
// Ownership is enforced server-side: we only delete rows whose teacher_uid
// matches the verified Firebase uid, regardless of what the client sends.
//
// Request: POST  Authorization: Bearer <Firebase ID token>
//          body: { kind: "class"|"assignment"|"submission"|"shareLink", id }

const BodySchema = z.object({
  kind: z.enum(["class", "assignment", "submission", "shareLink"]),
  id: z.string().min(1),
});

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const auth = await requireTeacher(event);
  if (!auth.ok) return json(auth.status, { error: auth.error });

  const parsed = parseJsonBody(event, BodySchema);
  if (!parsed.ok) return json(400, { error: parsed.error });

  const { kind, id } = parsed.data;
  // 협업자도 owner 데이터를 삭제할 수 있어야 한다(권한 동일 정책). 모든 ownership
  // 매칭이 resolved owner uid로 통일됨. tombstone도 owner uid 파티션.
  const teacherUid = await resolveDataOwnerUid(auth.teacher.uid);
  const db = getSupabaseAdmin();

  try {
    let deletedCount = 0;

    if (kind === "class") {
      const { error, count } = await db
        .from("classes")
        .delete({ count: "exact" })
        .eq("id", id)
        .eq("teacher_uid", teacherUid);
      if (error) throw new Error(error.message);
      deletedCount = count ?? 0;
      if (deletedCount > 0) {
        await db.from("tombstones").upsert(
          {
            teacher_uid: teacherUid,
            kind: "class",
            entity_id: id,
            deleted_at: Date.now(),
          },
          { onConflict: "teacher_uid,kind,entity_id" },
        );
      }
    } else if (kind === "assignment") {
      const { error, count } = await db
        .from("assignments")
        .delete({ count: "exact" })
        .eq("id", id)
        .eq("teacher_uid", teacherUid);
      if (error) throw new Error(error.message);
      deletedCount = count ?? 0;
      if (deletedCount > 0) {
        await db.from("tombstones").upsert(
          {
            teacher_uid: teacherUid,
            kind: "assignment",
            entity_id: id,
            deleted_at: Date.now(),
          },
          { onConflict: "teacher_uid,kind,entity_id" },
        );
      }
    } else if (kind === "submission") {
      // Submission ownership traverses through the assignment. Read first,
      // verify, then delete in one round-trip per check — a single SELECT
      // costs essentially nothing and lets us return a clean 403 instead
      // of silently no-oping (which would confuse the client).
      const { data: sub, error: readErr } = await db
        .from("submissions")
        .select("assignment_id")
        .eq("id", id)
        .maybeSingle();
      if (readErr) throw new Error(readErr.message);
      if (!sub) {
        return json(404, { error: "submission을 찾을 수 없습니다." });
      }
      const { data: assignment, error: aErr } = await db
        .from("assignments")
        .select("teacher_uid")
        .eq("id", sub.assignment_id as string)
        .maybeSingle();
      if (aErr) throw new Error(aErr.message);
      if (!assignment || assignment.teacher_uid !== teacherUid) {
        return json(403, { error: "이 제출물은 다른 교사 소유입니다." });
      }
      const { error: delErr, count } = await db
        .from("submissions")
        .delete({ count: "exact" })
        .eq("id", id);
      if (delErr) throw new Error(delErr.message);
      deletedCount = count ?? 0;
      if (deletedCount > 0) {
        await db.from("tombstones").upsert(
          {
            teacher_uid: teacherUid,
            kind: "submission",
            entity_id: id,
            deleted_at: Date.now(),
          },
          { onConflict: "teacher_uid,kind,entity_id" },
        );
      }
    } else if (kind === "shareLink") {
      // Share links are keyed by token. Treating delete as "revoke and
      // remove" — the client uses revokedAt as a soft state too, but for
      // hard delete we just drop the row.
      const { error, count } = await db
        .from("share_links")
        .delete({ count: "exact" })
        .eq("token", id)
        .eq("teacher_uid", teacherUid);
      if (error) throw new Error(error.message);
      deletedCount = count ?? 0;
    }

    return json(200, { ok: true, deletedCount });
  } catch (e) {
    return json(500, {
      error: (e as Error).message || "supabase-delete failed",
    });
  }
};
