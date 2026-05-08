import type { Handler } from "@netlify/functions";
import { z } from "zod";
import type { Submission, TeacherDb } from "../../src/lib/types";
import { handleOptions, json, parseJsonBody } from "./_utils";
import { getSupabaseAdmin } from "./_supabase";
import { readTeacherDbForUser } from "./_supabaseDb";

// Student-facing endpoint that mirrors the data shape the share landing
// page (and the student write page's polling loop) used to pull straight
// out of the teacher's spreadsheet. The teacher's full DB is loaded with
// the service_role key, then filtered down to:
//
//   * the assignment named by this share token,
//   * the classes that assignment is allocated to,
//   * those classes' student rows (studentNo + studentCode pairs — same
//     exposure surface as the sheet path; the share token itself is the
//     gate, and a student must also know their own code to authenticate),
//   * everyone's submission *metadata* (id, timestamps, currentStep) so
//     the teacher can see "submitted but not approved" states roll in,
//   * **only the calling student's own text bodies** (outline/draft/revise/
//     graspData/finalReportSnapshot). All other students' bodies are
//     blanked so a leaked client cache cannot reveal another student's
//     writing.
//
// If studentNo/studentCode aren't supplied (the very first hit before the
// landing page collects credentials), every body comes back blank — which
// is fine because that page only needs the student list and the assignment
// summary at that point.
//
// Token validation is done here too: revoked or expired share links are
// rejected so an old URL can't keep pulling fresh data.

const BodySchema = z.object({
  shareToken: z.string().min(8),
  studentNo: z.string().min(1).optional(),
  studentCode: z.string().min(1).optional(),
});

function blankBodies(s: Submission): Submission {
  return {
    ...s,
    outlineText: "",
    draftText: "",
    reviseText: "",
    graspData: "",
    finalReportSnapshot: "",
  };
}

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const parsed = parseJsonBody(event, BodySchema);
  if (!parsed.ok) return json(400, { error: parsed.error });

  const { shareToken, studentNo, studentCode } = parsed.data;
  const db = getSupabaseAdmin();

  // 1) Validate share token + capture teacher_uid and assignment scope.
  const { data: share, error: shareErr } = await db
    .from("share_links")
    .select("token, teacher_uid, assignment_id, expires_at, revoked_at, spreadsheet_id, created_at")
    .eq("token", shareToken)
    .maybeSingle();
  if (shareErr) return json(500, { error: shareErr.message });
  if (!share) return json(404, { error: "유효하지 않은 공유 토큰입니다." });
  if (share.revoked_at != null) {
    return json(403, { error: "공유 링크가 해지되었습니다." });
  }
  if (typeof share.expires_at === "number" && share.expires_at < Date.now()) {
    return json(403, { error: "공유 링크가 만료되었습니다." });
  }

  // 2) Load the teacher's full DB. Filtering happens in memory so the same
  //    matching logic the sheet path used (mergeTeacherDbForStudentView)
  //    keeps working unchanged on the client.
  let full: TeacherDb;
  try {
    full = await readTeacherDbForUser(share.teacher_uid as string);
  } catch (e) {
    return json(500, { error: (e as Error).message || "share-bootstrap read failed" });
  }

  const assignmentId = share.assignment_id as string;

  // Identify the calling student's submission, if credentials match. We
  // accept silent failure here (no match → all bodies blanked) so an
  // attacker probing valid student codes can't distinguish the failure
  // mode by reading the response shape — they always get the same masked
  // payload.
  let myStudentClassId: string | null = null;
  if (studentNo && studentCode) {
    for (const c of full.classes) {
      const found = c.students.find(
        (s) => s.studentNo === studentNo && s.studentCode === studentCode,
      );
      if (found) {
        myStudentClassId = c.id;
        break;
      }
    }
  }
  const mySubmission = full.submissions.find(
    (s) =>
      s.assignmentId === assignmentId &&
      s.classId === myStudentClassId &&
      s.studentNo === studentNo,
  );
  const mySubmissionId = mySubmission?.id ?? null;

  // 3) Narrow each TeacherDb collection to what the student is allowed to
  //    see. The shape stays a TeacherDb so the client-side merge code is
  //    untouched.
  const allocations = full.allocations.filter((a) => a.assignmentId === assignmentId);
  const allocClassIds = new Set(allocations.flatMap((a) => a.targets.map((t) => t.classId)));

  const filtered: TeacherDb = {
    version: 5,
    classes: full.classes.filter((c) => allocClassIds.has(c.id)),
    assignments: full.assignments.filter((a) => a.id === assignmentId),
    allocations,
    shares: full.shares.filter((s) => s.token === shareToken),
    submissions: full.submissions
      .filter((s) => s.assignmentId === assignmentId)
      .map((s) => (s.id === mySubmissionId ? s : blankBodies(s))),
    feedbackNotes: mySubmissionId
      ? full.feedbackNotes.filter((f) => f.submissionId === mySubmissionId)
      : [],
    aiLogs: mySubmissionId ? full.aiLogs.filter((l) => l.submissionId === mySubmissionId) : [],
    scores: mySubmissionId ? full.scores.filter((s) => s.submissionId === mySubmissionId) : [],
    stepTransitions: mySubmissionId
      ? full.stepTransitions.filter((t) => t.submissionId === mySubmissionId)
      : [],
    aiInteractions: mySubmissionId
      ? full.aiInteractions.filter((i) => i.submissionId === mySubmissionId)
      : [],
    teacherComments: mySubmissionId
      ? full.teacherComments.filter((c) => c.submissionId === mySubmissionId)
      : [],
    tombstones: [],
  };

  return json(200, { db: filtered });
};
