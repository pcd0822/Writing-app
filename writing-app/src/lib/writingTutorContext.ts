/**
 * writingTutorContext.ts
 * 작문 프로그램 DB/상태 → AI 튜터 맥락 변환 헬퍼
 */

import type { TutorContext } from "./writingTutorPrompt";
import type { Assignment, FeedbackNote, Grasp, Submission } from "./types";

/**
 * submission·assignment 객체를 AI 튜터용 맥락으로 변환한다.
 */
export function buildTutorContext({
  submission,
  assignment,
  feedbackNotes,
  grasp,
  selectedText = "",
}: {
  submission: Submission;
  assignment: Assignment;
  feedbackNotes?: FeedbackNote[];
  grasp?: Grasp | null;
  selectedText?: string;
}): TutorContext {
  let stage = "outline";
  if (submission.outlineApprovedAt && !submission.draftApprovedAt) stage = "draft";
  else if (submission.draftApprovedAt) stage = "revise";

  const memos = feedbackNotes ?? [];
  const teacherMemos = memos.length
    ? memos
        .filter((m) => !m.resolvedAt)
        .map((m, i) => {
          const quote = m.anchorText ? `"${m.anchorText}" → ` : "";
          return `${i + 1}. ${quote}${m.teacherText}`;
        })
        .join("\n")
    : "";

  const productLabels: Record<string, string> = {
    proposal: "제안서",
    report: "보고서",
    column: "칼럼",
    essay: "에세이",
    other: "기타",
  };

  return {
    stage,
    taskGoal: grasp?.goal ?? assignment.prompt ?? "",
    targetAudience: grasp?.audience ?? "",
    taskSituation: grasp?.situation ?? "",
    graspRole: grasp?.role ?? "",
    graspProduct: grasp ? productLabels[grasp.product] ?? grasp.product : "",
    graspStandards: grasp?.standards?.join(", ") ?? "",
    outline: submission.outlineText ?? "",
    draft: submission.draftText ?? "",
    revision: submission.reviseText ?? "",
    teacherMemos,
    selectedText,
  };
}

/**
 * 대화 기록에 새 메시지를 추가하고 최대 턴 수를 제한한다.
 */
export function appendMessage(
  history: { role: string; content: string }[],
  role: string,
  content: string,
  maxTurns = 20,
) {
  const updated = [...history, { role, content }];
  const maxItems = maxTurns * 2;
  return updated.length > maxItems ? updated.slice(updated.length - maxItems) : updated;
}
