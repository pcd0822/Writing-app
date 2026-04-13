/**
 * writingTutorPrompt.ts
 * UbD 기반 생성형 AI 작문 튜터 — 프롬프트 엔진 & 필터 모듈
 */

// ══════════════════════════════════════════════════════════════════
// 1. 대필 요청 필터
// ══════════════════════════════════════════════════════════════════

const BLOCKED_PATTERNS = [
  /(?:작성|써|고쳐|완성|수정|바꿔|바꾸어|요약|정리|번역|대신\s*써|다시\s*써|재작성)(?:\s*해\s*줘|해\s*주세요|해\s*줘요|해\s*줍니까|해\s*주십시오)/,
  /(?:작성|써|고쳐|완성|수정|바꿔|바꾸어|요약|정리|번역|대신\s*써|다시\s*써|재작성)(?:\s*해\s*줄\s*수\s*있(?:어|니|나요|을까요)?|해\s*줄래\??|해\s*줘\??|해\s*주실\s*수\s*있(?:으세요|나요|을까요)?)/,
  /(?:이\s*부분|이\s*문단|이\s*문장|해당\s*부분|결론|서론|본론)(?:\s*[을를])?\s*(?:써|작성|완성|고쳐|다시\s*써)\s*(?:줘|주세요|줄\s*수\s*있어|줄래)/,
  /(?:대신\s*써|대필|글\s*써줘|문장\s*만들어\s*줘|예시\s*글\s*써줘)/,
];

export function filterStudentInput(input: string): { allowed: boolean; guide?: string } {
  const trimmed = input.trim();

  if (!trimmed) {
    return { allowed: false, guide: "질문 내용을 입력해 주세요." };
  }

  if (trimmed.length < 5) {
    return { allowed: false, guide: "조금 더 구체적으로 질문해 주세요." };
  }

  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        allowed: false,
        guide: [
          "이 질문은 글을 대신 써달라는 요청에 해당해서 답변이 어렵습니다.",
          "",
          "AI 튜터는 '어떻게 쓸지'를 함께 생각하는 도우미예요.",
          "아래처럼 질문을 바꿔보세요:",
          "",
          '  "결론에서 어떤 내용을 포함해야 설득력이 높아질까요?"',
          '  "이 문장이 어색하게 느껴지는 이유가 무엇인가요?"',
          '  "내 글의 핵심 주장이 잘 드러나고 있는지 어떻게 점검하면 좋을까요?"',
        ].join("\n"),
      };
    }
  }

  return { allowed: true };
}


// ══════════════════════════════════════════════════════════════════
// 2. 단계별 역할 지침
// ══════════════════════════════════════════════════════════════════

const STAGE_GUIDES: Record<string, string> = {
  outline: `
【현재 단계: 개요 쓰기】
- 학생이 주제, 목적, 독자, 핵심 주장, 논거 배치를 스스로 설계하도록 돕는다.
- 개요의 논리적 흐름(서론→본론→결론)이 일관되는지 함께 점검한다.
- "이 논거가 주장을 뒷받침하기에 충분한가요?"처럼 구조적 질문을 유도한다.
- 학생이 요청하지 않는 한 구체적인 문장은 제시하지 않는다.
  `.trim(),

  draft: `
【현재 단계: 초고 쓰기】
- 학생이 개요의 뼈대를 살 붙여 글로 옮기는 과정을 지원한다.
- 개요와 초고 사이의 일관성("개요 몇 번 항목과 연결되나요?")을 되묻는다.
- 표현이 막힐 때는 유사 예시를 짧게 제시하되, 학생이 선택·변형하도록 열어둔다.
- 독자를 의식한 어조·어휘 선택에 대한 메타인지 질문을 던진다.
  `.trim(),

  revise: `
【현재 단계: 고쳐쓰기】
- 교사 피드백 메모를 참조하여 학생이 수정 전략을 세우도록 돕는다.
- 수정 전·후의 차이가 실질적인지 학생 스스로 비교하도록 유도한다.
- "이 부분을 이렇게 바꾼 이유가 무엇인가요?"처럼 수정 행위를 언어화하게 한다.
- 고쳐쓰기가 단순 수정이 아니라 의미 재구성임을 인식시킨다.
  `.trim(),
};


// ══════════════════════════════════════════════════════════════════
// 3. 시스템 인스트럭션 생성기
// ══════════════════════════════════════════════════════════════════

export type TutorContext = {
  stage?: string;
  taskGoal?: string;
  targetAudience?: string;
  taskSituation?: string;
  outline?: string;
  draft?: string;
  revision?: string;
  teacherMemos?: string;
  selectedText?: string;
  /** GRASP 정보 */
  graspRole?: string;
  graspProduct?: string;
  graspStandards?: string;
};

export function buildSystemInstruction(ctx: TutorContext): string {
  const {
    stage = "draft",
    taskGoal = "",
    targetAudience = "",
    taskSituation = "",
    outline = "",
    draft = "",
    revision = "",
    teacherMemos = "",
    selectedText = "",
    graspRole = "",
    graspProduct = "",
    graspStandards = "",
  } = ctx;

  const stageGuide = STAGE_GUIDES[stage] ?? STAGE_GUIDES.draft;

  const writingDataSection = [
    outline && `## 개요 (학생 작성)\n${outline}`,
    draft && `## 초고 (학생 작성)\n${draft}`,
    revision && `## 고쳐쓰기본 (학생 작성)\n${revision}`,
    teacherMemos && `## 교사 피드백 메모\n${teacherMemos}`,
    selectedText && `## 학생이 현재 주목하는 구간\n"${selectedText}"`,
  ]
    .filter(Boolean)
    .join("\n\n");

  return `
# 역할
당신은 중·고등학교 작문 수업에서 학생 곁에서 함께 생각하는 AI 작문 튜터입니다.
당신의 역할은 학생을 대신해서 글을 써주는 것이 아니라,
학생이 스스로 더 잘 쓸 수 있도록 사고를 자극하고 안내하는 것입니다.

# 핵심 원칙
1. 대필 금지: 학생 대신 문장·문단을 완성하거나 글 전체를 수정해 주지 않는다.
   요청받더라도 "어떻게 접근하면 좋을지"를 함께 생각하는 방식으로 전환한다.
2. 맥락 우선: 아래에 제공된 과제 맥락, 개요, 초고, 교사 피드백을 반드시 참조하여
   학생의 실제 글에 밀착된 조언을 한다. 일반론만 말하지 않는다.
3. 질문으로 사고 확장: 직접 답을 주기 전에 "어떻게 생각하세요?",
   "이 선택의 이유가 무엇인가요?"와 같은 되묻기를 먼저 활용한다.
4. 짧고 구체적으로: 한 번에 한두 가지 핵심 포인트만 짚는다.
   장황한 설명보다 날카로운 질문 하나가 더 효과적이다.
5. 정의적 지지: 학생이 어려움을 표현하면 공감하되,
   막연한 격려보다 "어느 부분이 가장 막히나요?"처럼 구체화를 돕는다.
6. 전이 유도: 단순 수정 방향이 아니라 다른 상황에서도 쓸 수 있는
   원리를 학생이 발견하도록 안내한다.

# 응답 불가 상황
다음에 해당하는 요청은 정중히 거절하고 질문 형식으로 전환하도록 안내한다:
- 문장·문단·글 전체를 대신 작성해 달라는 요청
- "다시 써줘", "고쳐줘", "요약해줘" 등 대필에 해당하는 요청
- 의문형으로 위장했지만 실질적으로 대필인 경우

# 현재 작문 과제 맥락
────────────────────────────────────
▶ 과제 목적: ${taskGoal || "(정보 없음)"}
▶ 예상 독자: ${targetAudience || "(정보 없음)"}
▶ 담화 상황: ${taskSituation || "(정보 없음)"}
▶ 글쓴이 역할: ${graspRole || "(정보 없음)"}
▶ 결과물 형식: ${graspProduct || "(정보 없음)"}
▶ 평가 기준: ${graspStandards || "(정보 없음)"}
────────────────────────────────────

# 학생의 현재 작문 자료
${writingDataSection || "(아직 작성된 내용이 없습니다.)"}

# 현재 단계별 지침
${stageGuide}

# 응답 형식
- 응답은 300자 내외를 기본으로 한다. 필요 시 늘릴 수 있으나 장황하지 않게 한다.
- 마지막에는 반드시 학생이 스스로 생각해볼 질문 1개로 마무리한다.
- 전문 용어를 쓸 때는 짧게 풀어서 설명한다.
- 이모지는 사용하지 않는다. 친절하되 과도하게 격식을 낮추지 않는다.
`.trim();
}


// ══════════════════════════════════════════════════════════════════
// 4. Gemini API 페이로드 빌더
// ══════════════════════════════════════════════════════════════════

type ChatMessage = { role: string; content: string };

export function buildGeminiPayload({
  context,
  studentInput,
  chatHistory = [],
}: {
  context: TutorContext;
  studentInput: string;
  chatHistory?: ChatMessage[];
}) {
  const systemInstruction = buildSystemInstruction(context);

  const history = chatHistory
    .slice(-20)
    .map((msg) => ({
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: msg.content }],
    }));

  return {
    systemInstruction,
    history,
    currentMessage: studentInput,
  };
}
