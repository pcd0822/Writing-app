"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { nanoid } from "nanoid";
import styles from "./AiCollaborationPanel.module.css";
import { Button } from "@/components/ui/Button";
import { callFunction } from "@/lib/netlifyClient";
import { addAiLog, addAiInteraction, updateAiInteractionAction } from "@/lib/localDb";
import { AI_PROMPTS } from "@/lib/aiWritingPrompts";
import { filterStudentInput, buildGeminiPayload } from "@/lib/writingTutorPrompt";
import { buildTutorContext, appendMessage } from "@/lib/writingTutorContext";
import type {
  AiInteraction,
  Assignment,
  FeedbackNote,
  Grasp,
  Stage,
  Submission,
} from "@/lib/types";

type ToolType = "continue" | "rephrase" | "argument" | "audience" | "structure";

const TOOL_LABELS: Record<ToolType, string> = {
  continue: "이어서 써줘",
  rephrase: "다른 표현으로",
  argument: "논거 보강해줘",
  audience: "독자 관점에서 봐줘",
  structure: "구조 점검",
};

type Msg = {
  id: string;
  role: "student" | "assistant" | "tool";
  text: string;
  toolType?: ToolType;
  interactionId?: string;
  action?: AiInteraction["action"];
};

type Props = {
  submissionId: string;
  stage: Stage;
  selectedText: string;
  currentText: string;
  outlineText: string;
  grasp: Grasp | null;
  spreadsheetId?: string;
  submission?: Submission;
  assignment?: Assignment;
  feedbackNotes?: FeedbackNote[];
  onBump: () => void;
};

export function AiCollaborationPanel({
  submissionId,
  stage,
  selectedText,
  currentText,
  outlineText,
  grasp,
  spreadsheetId,
  submission,
  assignment,
  feedbackNotes,
  onBump,
}: Props) {
  const sheetOpts = useMemo(
    () => ({ spreadsheetId: spreadsheetId?.trim() || undefined }),
    [spreadsheetId],
  );

  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [chatHistory, setChatHistory] = useState<{ role: string; content: string }[]>([]);
  const [activeTool, setActiveTool] = useState<ToolType | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const chatRef = useRef<HTMLDivElement | null>(null);

  const header = useMemo(() => {
    return stage === "outline"
      ? "AI 협력 글쓰기(개요)"
      : stage === "draft"
        ? "AI 협력 글쓰기(초고)"
        : "AI 협력 글쓰기(고쳐쓰기)";
  }, [stage]);

  // 선택된 텍스트가 변경되면 프롬프트 입력창에 반영
  useEffect(() => {
    const ref = (selectedText || "").trim();
    if (!ref) return;
    const clipped = ref.length > 600 ? `${ref.slice(0, 600)}...` : ref;
    const next = `[선택한 구간]\n${clipped}\n\n`;
    setInput((prev) => {
      // 이미 선택 구간이 있으면 교체
      const cleaned = prev.replace(/\[선택한 구간\]\n[\s\S]*?\n\n/g, "");
      return `${next}${cleaned.trim() ? cleaned : ""}`;
    });
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [selectedText]);

  // 스크롤 to bottom
  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [msgs]);

  const stageToStep = (s: Stage): number => {
    if (s === "outline") return 1;
    if (s === "draft") return 2;
    return 3;
  };

  const needsSelection = (tool: ToolType) =>
    tool === "continue" || tool === "rephrase" || tool === "argument";

  // 도구 실행
  async function runTool(tool: ToolType) {
    setError(null);
    setActiveTool(tool);
    setIsSending(true);

    if (needsSelection(tool) && !selectedText.trim()) {
      setError("텍스트를 드래그로 선택한 후 사용하세요.");
      setIsSending(false);
      setActiveTool(null);
      return;
    }

    let prompt = "";
    switch (tool) {
      case "continue":
        prompt = AI_PROMPTS.continueWriting(grasp, currentText, selectedText);
        break;
      case "rephrase":
        prompt = AI_PROMPTS.alternativeExpression(selectedText, grasp);
        break;
      case "argument":
        prompt = AI_PROMPTS.strengthenArgument(selectedText, grasp);
        break;
      case "audience":
        prompt = AI_PROMPTS.audiencePerspective(currentText, grasp);
        break;
      case "structure":
        prompt = AI_PROMPTS.structureCheck(currentText, grasp, outlineText);
        break;
    }

    try {
      const res = await callFunction<{ text: string }>("gemini-chat", { prompt });
      const responseText = (res.text || "").trim() || "응답을 생성하지 못했습니다.";

      const interactionId = nanoid(12);
      const interaction: AiInteraction = {
        id: interactionId,
        submissionId,
        timestamp: Date.now(),
        step: stageToStep(stage),
        type: tool,
        prompt: prompt.slice(0, 500),
        response: responseText.slice(0, 2000),
        action: "rejected",
      };
      addAiInteraction(interaction, sheetOpts);

      const toolMsg: Msg = {
        id: nanoid(10),
        role: "tool",
        text: responseText,
        toolType: tool,
        interactionId,
        action: "rejected",
      };
      setMsgs((m) => [...m, toolMsg]);
      onBump();
    } catch (e) {
      setError((e as Error).message || "AI 요청 실패");
    } finally {
      setIsSending(false);
      setActiveTool(null);
    }
  }

  // 자유 질문 전송
  async function onSend() {
    setError(null);
    const q = input.trim();
    if (!q) return;

    const filterResult = filterStudentInput(q);
    if (!filterResult.allowed) {
      setError(filterResult.guide || "질문 형식으로 바꿔서 입력해주세요.");
      return;
    }

    const studentMsg: Msg = { id: nanoid(10), role: "student", text: q };
    setMsgs((m) => [...m, studentMsg]);
    await addAiLog(
      {
        id: nanoid(12),
        submissionId,
        stage,
        createdAt: Date.now(),
        role: "student",
        text: q,
      },
      sheetOpts,
    );

    setInput("");
    setIsSending(true);
    try {
      let responseText: string;

      if (submission && assignment) {
        const context = buildTutorContext({
          submission,
          assignment,
          feedbackNotes,
          grasp,
          selectedText: selectedText || "",
        });
        const payload = buildGeminiPayload({
          context,
          studentInput: q,
          chatHistory,
        });

        const res = await callFunction<{ text: string }>("gemini-chat", {
          prompt: payload.currentMessage,
          systemInstruction: payload.systemInstruction,
          history: payload.history,
        });
        responseText = (res.text || "").trim() || "답변을 생성하지 못했습니다.";

        const updated = appendMessage(
          appendMessage(chatHistory, "user", q),
          "assistant",
          responseText,
        );
        setChatHistory(updated);
      } else {
        const prompt = [
          "너는 학생의 작문을 돕는 튜터다.",
          "절대 학생 대신 글을 완성해주지 말고, 질문에 대한 피드백/가이드만 제공한다.",
          "가능하면 3~6개의 체크리스트/질문으로 되묻게 한다.",
          "",
          `학생 상태: ${stage}`,
          "",
          `학생 질문: ${q}`,
        ].join("\n");

        const res = await callFunction<{ text: string }>("gemini-chat", { prompt });
        responseText = (res.text || "").trim() || "답변을 생성하지 못했습니다.";
      }

      const assistantMsg: Msg = {
        id: nanoid(10),
        role: "assistant",
        text: responseText,
      };
      setMsgs((m) => [...m, assistantMsg]);
      await addAiLog(
        {
          id: nanoid(12),
          submissionId,
          stage,
          createdAt: Date.now(),
          role: "assistant",
          text: responseText,
        },
        sheetOpts,
      );
    } catch (e) {
      setError((e as Error).message || "전송 실패");
    } finally {
      setIsSending(false);
    }
  }

  function handleAction(msgId: string, interactionId: string, action: AiInteraction["action"]) {
    updateAiInteractionAction(interactionId, action, sheetOpts);
    setMsgs((prev) =>
      prev.map((m) => (m.id === msgId ? { ...m, action } : m)),
    );
    onBump();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <div className={styles.title}>{header}</div>
        <div className={styles.sub}>
          도구를 사용하거나 직접 질문하세요. 텍스트를 선택하면 맥락이 포함됩니다.
        </div>
      </div>

      {/* 도구 버튼 영역 */}
      <div className={styles.tools}>
        {(Object.keys(TOOL_LABELS) as ToolType[]).map((tool) => (
          <button
            key={tool}
            type="button"
            className={[
              styles.toolBtn,
              activeTool === tool ? styles.toolBtnActive : "",
            ].join(" ")}
            onClick={() => runTool(tool)}
            disabled={isSending}
            title={
              needsSelection(tool) && !selectedText.trim()
                ? "먼저 텍스트를 선택하세요"
                : undefined
            }
          >
            {TOOL_LABELS[tool]}
          </button>
        ))}
      </div>

      {/* 선택된 텍스트 표시 */}
      {selectedText.trim() ? (
        <div className={styles.selectedRef}>
          선택됨: {selectedText.length > 150 ? `${selectedText.slice(0, 150)}...` : selectedText}
        </div>
      ) : null}

      {/* 통합 대화 영역 */}
      <div className={styles.chat} ref={chatRef}>
        {msgs.length === 0 ? (
          <div className={styles.empty}>
            <div style={{ marginBottom: 8 }}>
              <b>도구 사용:</b> 위 버튼을 눌러 AI의 도움을 받으세요.
              "이어서 써줘", "다른 표현으로", "논거 보강해줘"는 먼저 텍스트를 드래그로 선택해야 합니다.
            </div>
            <div>
              <b>자유 질문:</b> 아래 입력창에 질문을 직접 입력할 수 있어요.
              예) "이 글의 주장이 더 명확해지려면 어떤 근거가 필요할까요?"
            </div>
          </div>
        ) : (
          msgs.map((m) => {
            if (m.role === "student") {
              return (
                <div key={m.id} className={styles.me}>
                  <div className={styles.bubble}>{m.text}</div>
                </div>
              );
            }
            if (m.role === "tool") {
              return (
                <div key={m.id} className={styles.toolResponse}>
                  <div className={styles.toolHeader}>
                    <span className={styles.toolBadge}>
                      {TOOL_LABELS[m.toolType!]}
                    </span>
                    {m.action !== "rejected" ? (
                      <span
                        className={[
                          styles.actionBadge,
                          m.action === "accepted" ? styles.actionAccepted : styles.actionModified,
                        ].join(" ")}
                      >
                        {m.action === "accepted" ? "수용" : "수정 반영"}
                      </span>
                    ) : null}
                  </div>
                  <div className={styles.responseText}>{m.text}</div>
                  {m.action === "rejected" ? (
                    <div className={styles.responseActions}>
                      <button type="button" className={styles.acceptBtn}
                        onClick={() => handleAction(m.id, m.interactionId!, "accepted")}>
                        수용
                      </button>
                      <button type="button" className={styles.modifyBtn}
                        onClick={() => handleAction(m.id, m.interactionId!, "modified")}>
                        수정 반영
                      </button>
                      <button type="button" className={styles.rejectBtn}
                        onClick={() => handleAction(m.id, m.interactionId!, "rejected")}>
                        거부
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            }
            // assistant
            return (
              <div key={m.id} className={styles.ai}>
                <div className={styles.bubble}>{m.text}</div>
              </div>
            );
          })
        )}

        {isSending ? (
          <div className={styles.loading}>AI가 분석하고 있습니다...</div>
        ) : null}
      </div>

      {error ? <div className={styles.error}>{error}</div> : null}

      {/* 입력 영역 */}
      <div className={styles.inputRow}>
        <textarea
          className={styles.input}
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="질문을 입력하세요. 텍스트 선택 후 ? 버튼을 누르면 선택 구간이 자동 포함됩니다."
        />
        <Button onClick={onSend} isLoading={isSending}>
          질문하기
        </Button>
      </div>
    </div>
  );
}
