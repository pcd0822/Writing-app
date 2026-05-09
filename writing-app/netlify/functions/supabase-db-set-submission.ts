import type { Handler } from "@netlify/functions";
import { z } from "zod";
import { SubmissionSchema } from "../../src/lib/types";
import { handleOptions, json, parseJsonBody } from "./_utils";
import { authenticateStudent, upsertStudentSubmission } from "./_supabaseDb";

// Supabase counterpart of db-set-submission.ts.
//
// Auth: identical contract to the sheet version — (shareToken, studentNo,
// studentCode) is verified against Supabase tables (share_links, students,
// assignment_allocations) and the matching teacher_uid is discovered from
// the share_link row. The student never names the teacher_uid.
//
// Concurrency: one row per submission, upserted by id. Two students each
// editing their own submission cannot collide because their ids differ.
// The same student double-clicking save lands as two upserts on the same
// row; Postgres serialises them at row level, so the later updated_at wins.
// Teacher-only fields (approval timestamps, reject reasons, finalReport
// snapshot) are read from the existing row before upsert so a stale
// student-side payload cannot blank them out.

const BodySchema = z.object({
  shareToken: z.string().min(8),
  studentNo: z.string().min(1),
  studentCode: z.string().min(1),
  submission: SubmissionSchema,
  graspData: z.string().optional(),
  // 학생이 "수정하기 → 저장/제출"로 승인된 단계를 다시 손볼 때, 서버 보호 로직이
  // 옛 approvedAt을 되돌리지 않도록 명시적 해제 신호를 보낸다. 비어있거나 누락이면
  // 보호가 그대로 적용 — 즉 stale payload가 우연히 승인을 지울 수 없다.
  clearApprovedStages: z.array(z.enum(["outline", "draft", "revise"])).optional(),
});

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const parsed = parseJsonBody(event, BodySchema);
  if (!parsed.ok) return json(400, { error: parsed.error });

  const { shareToken, studentNo, studentCode, submission, graspData, clearApprovedStages } =
    parsed.data;

  // The student-supplied submission.studentNo must match the credentials.
  // Without this guard, a student with a valid (studentNo, code) could
  // upsert another student's submission row by passing that student's id.
  if (submission.studentNo !== studentNo) {
    return json(403, { error: "submission의 학번이 인증 학번과 다릅니다." });
  }

  const auth = await authenticateStudent(shareToken, studentNo, studentCode);
  if (!auth.ok) return json(auth.status, { error: auth.error });

  // The submission's assignment_id and class_id must agree with what the
  // share_token + student row resolve to. Without this, a student in class
  // A can't slip a write into class B by sending submission.classId = B.
  if (submission.assignmentId !== auth.assignmentId) {
    return json(403, { error: "submission의 assignmentId가 공유 링크와 일치하지 않습니다." });
  }
  if (submission.classId !== auth.classId) {
    return json(403, { error: "submission의 classId가 인증된 학급과 일치하지 않습니다." });
  }

  try {
    const result = await upsertStudentSubmission(submission, graspData, clearApprovedStages);
    if (!result.ok) return json(result.status, { error: result.error });
    return json(200, { ok: true });
  } catch (e) {
    return json(500, { error: (e as Error).message || "supabase-db-set-submission failed" });
  }
};
