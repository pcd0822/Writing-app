import type { Handler } from "@netlify/functions";
import { handleOptions, json } from "./_utils";
import { readTeacherDbForUser } from "./_supabaseDb";
import { requireTeacher } from "./_firebaseAuth";
import { resolveDataOwnerUid } from "./_collaborators";

// Supabase counterpart of db-get.ts. Same response shape: { db: TeacherDb }.
//
// Auth: Authorization: Bearer <Firebase ID token>. The teacher's uid is
// taken from the verified `sub` claim — never from the request body — so
// callers cannot read another teacher's data by guessing their uid.

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const auth = await requireTeacher(event);
  if (!auth.ok) return json(auth.status, { error: auth.error });

  try {
    // 협업자가 호출하면 owner의 uid로 라우팅. 본인 데이터만 있는 교사는
    // resolveDataOwnerUid가 자기 uid를 그대로 돌려준다.
    const ownerUid = await resolveDataOwnerUid(auth.teacher.uid);
    const db = await readTeacherDbForUser(ownerUid);
    // Match db-get's "no data yet" semantics: if the teacher has nothing,
    // return db: null so the client falls back to a fresh local DB.
    const isEmpty =
      db.classes.length === 0 &&
      db.assignments.length === 0 &&
      db.shares.length === 0 &&
      db.submissions.length === 0;
    if (isEmpty) return json(200, { db: null });
    return json(200, { db });
  } catch (e) {
    return json(500, { error: (e as Error).message || "supabase-db-get failed" });
  }
};
