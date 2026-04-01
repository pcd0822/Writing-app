"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import styles from "./AiTutor.module.css";
import { Button } from "@/components/ui/Button";
import { callFunction } from "@/lib/netlifyClient";
import { nanoid } from "nanoid";
import { addAiLog } from "@/lib/localDb";
import type { Stage } from "@/lib/types";

type Msg = { id: string; role: "student" | "assistant"; text: string };

function looksLikeQuestion(text: string) {
  const t = text.trim();
  if (t.length < 2) return false;
  if (/[?？]$/.test(t)) return true;
  // 한국어 질문 유도: "어떻게/왜/무엇/어떤/가능할까요/인가요" 등
  if (/(어떻게|왜|무엇|어떤|가능|인가요|일까요|까요)\s*/.test(t)) return true;
  return false;
}

function looksLikeCommand(text: string) {
  const t = text.trim();
  return /(써줘|해줘|해줘요|작성해줘|만들어줘|대신 써|대신 써줘|요약해줘)$/.test(t);
}

export function AiTutor({
  submissionId,
  stage,
  contextHint,
  referenceText,
}: {
  submissionId: string;
  stage: Stage;
  contextHint: string;
  referenceText?: string | null;
}) {
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
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
    const clipped = ref.length > 600 ? `${ref.slice(0, 600)}…` : ref;
    const next = `다음 구간을 참고해서 질문할게요.\n\n[선택한 구간]\n${clipped}\n\n[질문] `;
    setInput((prev) => (prev.trim() ? `${next}${prev}` : next));
    // 다음 입력을 쉽게 하도록 포커스
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [referenceText]);

  async function onSend() {
    setError(null);
    const q = input.trim();
    if (!q) return;
    if (looksLikeCommand(q) || !looksLikeQuestion(q)) {
      setError(
        "AI 튜터는 ‘질문’ 형식으로만 도움을 받을 수 있어요. (예: ‘이 문단의 주장-근거 연결이 자연스러운가요?’)",
      );
      return;
    }

    const studentMsg: Msg = { id: nanoid(10), role: "student", text: q };
    setMsgs((m) => [...m, studentMsg]);
    addAiLog({
      id: nanoid(12),
      submissionId,
      stage,
      createdAt: Date.now(),
      role: "student",
      text: q,
    });

    setInput("");
    setIsSending(true);
    try {
      const prompt = [
        "너는 학생의 작문을 돕는 튜터다.",
        "절대 학생 대신 글을 완성해주지 말고, 질문에 대한 피드백/가이드/예시 문장(짧게)만 제공한다.",
        "가능하면 3~6개의 체크리스트/질문으로 되묻게 한다.",
        "",
        `학생 상태: ${contextHint}`,
        "",
        `학생 질문: ${q}`,
      ].join("\n");

      const res = await callFunction<{ text: string }>("gemini-chat", { prompt });
      const assistantText = (res.text || "").trim() || "답변을 생성하지 못했습니다.";
      const assistantMsg: Msg = {
        id: nanoid(10),
        role: "assistant",
        text: assistantText,
      };
      setMsgs((m) => [...m, assistantMsg]);
      addAiLog({
        id: nanoid(12),
        submissionId,
        stage,
        createdAt: Date.now(),
        role: "assistant",
        text: assistantText,
      });
    } catch (e) {
      setError((e as Error).message || "전송 실패");
    } finally {
      setIsSending(false);
    }
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <div className={styles.title}>{header}</div>
        <div className={styles.sub}>
          “질문”으로만 도움을 받을 수 있어요. 명령형(써줘/해줘)은 차단됩니다.
        </div>
      </div>

      <div className={styles.chat}>
        {msgs.length === 0 ? (
          <div className={styles.empty}>
            예시 질문: “이 글의 주장이 더 명확해지려면 어떤 근거가 필요할까요?”
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
          placeholder="질문을 입력하세요. 예) ‘이 문단의 근거가 충분한가요?’"
        />
        <Button onClick={onSend} isLoading={isSending}>
          질문하기
        </Button>
      </div>
    </div>
  );
}

