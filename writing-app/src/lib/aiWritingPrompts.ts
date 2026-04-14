/**
 * aiWritingPrompts.ts
 * AI 협력 글쓰기 프롬프트 모음 — GRASP 맥락 기반
 */

import type { Grasp } from "./types";

function graspContext(grasp: Grasp | null): string {
  if (!grasp) return "";
  const productLabels: Record<string, string> = {
    proposal: "제안서", report: "보고서", column: "칼럼", essay: "에세이", other: "기타",
  };
  return [
    `[GRASP 맥락]`,
    `- 목표: ${grasp.goal || "(미설정)"}`,
    `- 역할: ${grasp.role || "(미설정)"}`,
    `- 독자: ${grasp.audience || "(미설정)"}`,
    `- 상황: ${grasp.situation || "(미설정)"}`,
    `- 결과물: ${productLabels[grasp.product] ?? grasp.product}`,
    `- 평가 기준: ${grasp.standards.join(", ") || "(미설정)"}`,
  ].join("\n");
}

const COMMON_RULES = `
[필수 지침]
- 학생이 직접 사고하도록 유도하는 질문 형태로 응답할 것.
- 완성된 문장을 그대로 주지 말고, 사고의 방향을 제시할 것.
- GRASP에서 설정한 독자와 목표에 부합하는 피드백을 제공할 것.
- 응답은 2~3문장으로 간결하게.
- 한국어로 응답.
`.trim();

export const AI_PROMPTS = {
  /** "이어서 써줘" — 선택한 부분 이후의 방향 제안 */
  continueWriting: (
    grasp: Grasp | null,
    currentText: string,
    selectedText: string,
  ) => `
${graspContext(grasp)}

[현재 글 전체]
${currentText.slice(0, 2000)}

[학생이 선택한 구간]
"${selectedText}"

[요청] 위 선택 구간 이후에 어떤 내용이 이어지면 좋을지 2~3가지 방향을 짧게 제안해주세요.
각 방향은 질문 형태로 제시하여 학생이 스스로 선택할 수 있게 하세요.
완성된 문장을 직접 써주지 마세요.

${COMMON_RULES}
`.trim(),

  /** "다른 표현으로" — 대안 표현 방향 제시 */
  alternativeExpression: (
    selectedText: string,
    grasp: Grasp | null,
  ) => `
${graspContext(grasp)}

[학생이 선택한 문장/문단]
"${selectedText}"

[요청] 위 표현을 다른 방식으로 전달할 수 있는 접근법을 2~3가지 제시해주세요.
독자(${grasp?.audience || "일반"})에게 더 효과적일 수 있는 방향을 질문으로 안내하세요.
직접 문장을 다시 써주지 말고, "~하면 어떨까요?" 형태로 사고를 유도하세요.

${COMMON_RULES}
`.trim(),

  /** "논거 보강해줘" — 근거/사례 방향 제안 */
  strengthenArgument: (
    selectedText: string,
    grasp: Grasp | null,
  ) => `
${graspContext(grasp)}

[학생이 선택한 주장/논거]
"${selectedText}"

[요청] 위 주장을 보강할 수 있는 근거나 사례의 방향을 제안해주세요.
어떤 종류의 근거(통계, 사례, 전문가 인용 등)가 독자를 설득하는 데 효과적일지
학생이 생각해볼 수 있는 질문을 던져주세요.

${COMMON_RULES}
`.trim(),

  /** "독자 관점에서 봐줘" — GRASP Audience 기반 독자 반응 예측 */
  audiencePerspective: (
    currentText: string,
    grasp: Grasp | null,
  ) => `
${graspContext(grasp)}

[학생의 현재 글]
${currentText.slice(0, 2000)}

[요청] 독자(${grasp?.audience || "일반 독자"})의 관점에서 이 글을 읽었을 때
가장 궁금해하거나 의문을 가질 부분이 무엇일지 2~3가지 질문으로 제시해주세요.
"독자라면 ~라고 물을 수 있지 않을까요?" 형태로 안내하세요.

${COMMON_RULES}
`.trim(),

  /** "구조 점검" — 전체 글의 논리적 흐름 검토 */
  structureCheck: (
    fullText: string,
    grasp: Grasp | null,
    outline: string,
  ) => `
${graspContext(grasp)}

[학생의 개요]
${outline.slice(0, 1000)}

[학생의 현재 글]
${fullText.slice(0, 2000)}

[요청] 개요에서 계획한 구조와 현재 글의 흐름을 비교했을 때,
논리적 연결이 약하거나 빠진 부분이 있는지 점검해주세요.
"개요에서 ~를 계획했는데, 현재 글에서 이 부분이 어떻게 전개되고 있나요?" 형태로
학생이 스스로 점검할 수 있는 질문을 2~3개 제시하세요.

${COMMON_RULES}
`.trim(),

  /** 고쳐쓰기 — 미해결 피드백 요약 */
  revisionFeedbackSummary: (
    feedbackItems: { anchorText: string; teacherText: string }[],
    grasp: Grasp | null,
  ) => `
${graspContext(grasp)}

[미해결 교사 피드백 목록]
${feedbackItems.map((f, i) => `${i + 1}. 구간: "${f.anchorText.slice(0, 200)}"\n   피드백: ${f.teacherText}`).join("\n")}

[요청] 위 미해결 피드백들을 학생이 수정 전략을 세울 수 있도록 요약하고,
각 피드백에 대해 "이 피드백을 반영하면 글이 어떻게 달라질까요?" 또는
"이 피드백이 논거의 타당성과 어떻게 연결될까요?" 같은 수정 전략 질문을 하나씩 제시해주세요.
학생이 어디서부터 수정을 시작하면 좋을지 우선순위도 짧게 안내하세요.

${COMMON_RULES}
`.trim(),

  /** 고쳐쓰기 — 수정 전후 비교 점검 질문 */
  revisionCompare: (
    feedbackText: string,
    anchorText: string,
    draftText: string,
    reviseText: string,
    grasp: Grasp | null,
  ) => `
${graspContext(grasp)}

[교사 피드백]
${feedbackText}

[피드백 대상 구간 (초고)]
"${anchorText.slice(0, 500)}"

[초고 전문 (수정 전)]
${draftText.slice(0, 1500)}

[고쳐쓰기 전문 (수정 후)]
${reviseText.slice(0, 1500)}

[요청] 학생이 위 교사 피드백을 반영하여 글을 수정했습니다.
수정 전 문장과 비교하여 어떤 점이 달라졌는지 학생이 스스로 점검할 수 있는 질문을 1~2개 제시해주세요.
"수정 전에는 ~였는데, 지금은 어떻게 바뀌었나요?" 또는
"이 수정이 독자에게 어떤 효과를 줄 수 있을까요?" 형태로 질문하세요.
피드백이 충분히 반영되었다면 격려와 함께 다음으로 넘어가도 좋다고 안내하세요.

${COMMON_RULES}
`.trim(),

  /** AI 튜터 트리거 — 단계 간 연결성 피드백 */
  tutorFeedback: (
    currentStep: string,
    previousStepContent: string,
    currentStepContent: string,
    grasp: Grasp | null,
  ) => `
${graspContext(grasp)}

[이전 단계 내용]
${previousStepContent.slice(0, 1500)}

[현재 단계(${currentStep}) 내용]
${currentStepContent.slice(0, 1500)}

[요청] 이전 단계에서 작성한 내용과 현재 단계의 내용 사이의 연결성을 점검하는
짧은 피드백을 제공해주세요. 학생이 단계 간 흐름을 인식할 수 있도록
"이전 단계에서 ~를 설정했는데, 지금 ~가 충분히 반영되고 있나요?" 형태로
질문을 2~3개 제시하세요.

${COMMON_RULES}
`.trim(),
};

/** AI 프롬프트 타입 키 */
export type AiPromptType = keyof typeof AI_PROMPTS;
