"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import styles from "./AiTutor.module.css";
import { Button } from "@/components/ui/Button";
import { callFunction } from "@/lib/netlifyClient";
import { nanoid } from "nanoid";
import { addAiLog } from "@/lib/localDb";
import { filterStudentInput, buildGeminiPayload } from "@/lib/writingTutorPrompt";
import { buildTutorContext, appendMessage } from "@/lib/writingTutorContext";
import type { Assignment, FeedbackNote, Grasp, Stage, Submission } from "@/lib/types";

type Msg = { id: string; role: "student" | "assistant"; text: string };

export function AiTutor({
  submissionId,
  stage,
  contextHint,
  referenceText,
  spreadsheetId,
  submission,
  assignment,
  feedbackNotes,
  grasp,
}: {
  submissionId: string;
  stage: Stage;
  contextHint: string;
  referenceText?: string | null;
  spreadsheetId?: string;
  submission?: Submission;
  assignment?: Assignment;
  feedbackNotes?: FeedbackNote[];
  grasp?: Grasp | null;
}) {
  const sheetOpts = useMemo(
    () => ({ spreadsheetId: spreadsheetId?.trim() || undefined }),
    [spreadsheetId],
  );
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [chatHistory, setChatHistory] = useState<{ role: string; content: string }[]>([]);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const header = useMemo(() => {
    return stage === "outline"
      ? "AI 작문 튜터(개요)"
      : stage === "draft"
        ? "AI 작문 튜터(초고)"
        : "AI 작문 튜터(고쳐쓰기)";
  }, [stage]);

  useEffect(() => {
    const ref = (referenceText || "").trim();
    if (!ref) return;
    const clipped = ref.length > 600 ? `${ref.slice(0, 600)}...` : ref;
    const next = `다음 구간을 참고해서 질문할게요.\n\n[선택한 구간]\n${clipped}\n\n[질문] `;
    setInput((prev) => (prev.trim() ? `${next}${prev}` : next));
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [referenceText]);

  async function onSend() {
    setError(null);
    const q = input.trim();
    if (!q) return;

    // 대필 필터
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
        // 새로운 프롬프트 시스템 사용
        const context = buildTutorContext({
          submission,
          assignment,
          feedbackNotes,
          grasp,
          selectedText: referenceText || "",
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

        // 대화 이력 업데이트
        const updated = appendMessage(
          appendMessage(chatHistory, "user", q),
          "assistant",
          responseText,
        );
        setChatHistory(updated);
      } else {
        // 폴백: 기존 방식
        const prompt = [
          "너는 학생의 작문을 돕는 튜터다.",
          "절대 학생 대신 글을 완성해주지 말고, 질문에 대한 피드백/가이드만 제공한다.",
          "가능하면 3~6개의 체크리스트/질문으로 되묻게 한다.",
          "",
          `학생 상태: ${contextHint}`,
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
          질문 형식으로 도움을 받을 수 있어요. 대필 요청은 차단됩니다.
        </div>
      </div>

      <div className={styles.chat}>
        {msgs.length === 0 ? (
          <div className={styles.empty}>
            예시 질문: "이 글의 주장이 더 명확해지려면 어떤 근거가 필요할까요?"
          </div>
        ) : (
          msgs.map((m) => (
            <div
              key={m.id}
              className={m.role === "student" ? styles.me : styles.ai}
            >
              <div className={styles.bubble}>{m.text}</div>
            </div>
          ))
        )}
      </div>

      {error ? <div className={styles.error}>{error}</div> : null}

      <div className={styles.inputRow}>
        <textarea
          className={styles.input}
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="질문을 입력하세요. 예) '이 문단의 근거가 충분한가요?'"
        />
        <Button onClick={onSend} isLoading={isSending}>
          질문하기
        </Button>
      </div>
    </div>
  );
}
